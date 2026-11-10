/**
 * Chat picture previews: H1 decode at finish, H2 preview.png, H3 preview.rgb,
 * cache lifetime, and the admin file routes. ONE reachability test drives
 * upload -> finish (kind image, img_w/img_h) -> preview.png through the app;
 * decoders and scaling are pinned where they live.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { encode as encodeJpeg } from 'jpeg-js';
import { GifWriter } from 'omggif';
import { PNG } from 'pngjs';
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { _resetRateLimitsForTests } from '../src/achievements/ratelimit';
import { sweepFiles } from '../src/chat/files';
import { decodeImage } from '../src/chat/image-decode';
import { decodeIlbm } from '../src/chat/ilbm';
import { cellsOf, fitSize } from '../src/chat/preview';

let fx: AchievementsFixture;
beforeEach(() => { _resetRateLimitsForTests(); fx = makeAchievementsFixture({ chatFiles: true, admin: true }); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); _resetRateLimitsForTests(); });

async function login(handle: string): Promise<string> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle });
  return r.body.sid as string;
}
const call = (method: 'get' | 'post' | 'delete' | 'put', path: string, sid: string) =>
  request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);
async function room(owner: string, other?: string): Promise<string> {
  const id = (await call('post', '/rooms', owner).send({ name: `r${Math.random().toString(36).slice(2, 8)}` })).body.id as string;
  await call('post', `/rooms/${id}/join`, owner);
  if (other) await call('post', `/rooms/${id}/join`, other);
  return id;
}
async function upload(sid: string, roomId: string, name: string, data: Buffer, clientId = 'c1'): Promise<string> {
  const id = (await call('post', `/rooms/${roomId}/files`, sid).send({ name, size: data.length, clientId })).body.id as string;
  for (let off = 0; off < data.length; off += 32768) {
    const r = await call('put', `/files/${id}/chunk?offset=${off}`, sid).set('Content-Type', 'application/octet-stream').send(data.subarray(off, off + 32768));
    expect(r.status).toBe(200);
  }
  expect((await call('post', `/files/${id}/finish`, sid).send({})).status).toBe(200);
  return id;
}
const bin = (r: request.Test) => r.buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
const listing = async (sid: string, r: string) => (await call('get', `/rooms/${r}/files`, sid)).body.files as Array<{ id: string; kind: string; imgW: number | null; imgH: number | null }>;

function pngOf(w: number, h: number, fill: (i: number) => [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i += 1) {
    const [r, g, b] = fill(i);
    png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}
const noisyPng = (w: number, h: number): Buffer => {
  const noise = crypto.randomBytes(w * h * 3);
  return pngOf(w, h, (i) => [noise[i * 3], noise[i * 3 + 1], noise[i * 3 + 2]]);
};

function ilbm(): Buffer {
  // 16x4, 2 planes, ByteRun1, palette black/red/green/blue; plane0 all ones, plane1 all zeros -> index 1 (red)
  const bmhd = Buffer.alloc(20);
  bmhd.writeUInt16BE(16, 0); bmhd.writeUInt16BE(4, 2); bmhd[8] = 2; bmhd[10] = 1;
  // per row: plane0 = ByteRun1 replicate (-1) of 0xFF, plane1 = replicate (-1) of 0x00 (2 bytes each)
  const body = Buffer.from(Array.from({ length: 4 }).flatMap(() => [0xff, 0xff, 0xff, 0x00]));
  const cmap = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const chunk = (id: string, d: Buffer): Buffer => {
    const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32BE(d.length, 4);
    return Buffer.concat([h, d, d.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const inner = Buffer.concat([Buffer.from('ILBM'), chunk('BMHD', bmhd), chunk('CMAP', cmap), chunk('BODY', body)]);
  const head = Buffer.alloc(8); head.write('FORM', 0, 'latin1'); head.writeUInt32BE(inner.length, 4);
  return Buffer.concat([head, inner]);
}

describe('decoders', () => {
  it('PNG, JPEG, GIF first frame and ILBM decode to RGB with their size', () => {
    const p = decodeImage(pngOf(6, 3, () => [10, 20, 30]));
    expect(p && [p.w, p.h, p.rgb.length, p.rgb[0], p.rgb[1], p.rgb[2]]).toEqual([6, 3, 54, 10, 20, 30]);
    const jd = Buffer.alloc(8 * 8 * 4, 200);
    const j = decodeImage(encodeJpeg({ data: jd, width: 8, height: 8 }, 90).data);
    expect(j && [j.w, j.h]).toEqual([8, 8]);
    const g = Buffer.alloc(200);
    const gw = new GifWriter(g, 5, 4, { palette: [0x000000, 0xff0000] });
    gw.addFrame(0, 0, 5, 4, new Array<number>(20).fill(1));
    const gif = decodeImage(g.subarray(0, gw.end()));
    expect(gif && [gif.w, gif.h, gif.rgb[0], gif.rgb[1], gif.rgb[2]]).toEqual([5, 4, 255, 0, 0]);
    const i = decodeIlbm(ilbm());
    expect(i && [i.w, i.h, i.rgb[0], i.rgb[1], i.rgb[2]]).toEqual([16, 4, 255, 0, 0]);
    expect(decodeImage(Buffer.from('GIF89a garbage'))).toBeNull();
  });

  it('fit keeps aspect, never enlarges, and cells are the ceil of the pixel size', () => {
    expect(fitSize(640, 400, 32, 10)).toEqual({ w: 256, h: 160 });
    expect(fitSize(16, 4, 32, 10)).toEqual({ w: 16, h: 4 });
    expect(cellsOf(256, 160)).toEqual({ c: 32, r: 10 });
    expect(cellsOf(17, 17)).toEqual({ c: 3, r: 2 });
  });
});

describe('chat previews', () => {
  it('REACHABLE: upload a PNG -> kind image with size -> preview.png and preview.rgb through the app', async () => {
    const a = await login('alice');
    const r = await room(a);
    const id = await upload(a, r, 'pic.png', pngOf(100, 50, (i) => [i % 256, 0, 255]));
    const row = (await listing(a, r)).find((f) => f.id === id);
    expect([row?.kind, row?.imgW, row?.imgH]).toEqual(['image', 100, 50]);
    const txt = (await call('get', `/rooms/${r}/files.txt`, a)).text;
    expect(txt).toContain(`|image|100|50\r\n`);

    const res = await bin(call('get', `/files/${id}/preview.png?cols=20&rows=4`, a));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['transfer-encoding']).toBeUndefined();
    expect(Number(res.headers['content-length'])).toBe((res.body as Buffer).length);
    const png = PNG.sync.read(res.body as Buffer);
    expect(png.width).toBeLessThanOrEqual(160);
    expect(png.height).toBeLessThanOrEqual(64);
    expect([png.width, png.height]).toEqual([100, 50]);
    expect(res.headers['x-cells']).toBe(`${Math.ceil(100 / 8)}x${Math.ceil(50 / 16)}`);

    const rgb = await bin(call('get', `/files/${id}/preview.rgb?cols=20&rows=4`, a));
    expect(rgb.status).toBe(200);
    expect(rgb.headers['content-type']).toBe('application/octet-stream');
    expect(rgb.headers['transfer-encoding']).toBeUndefined();
    const [c, rr] = String(rgb.headers['x-cells']).split('x').map(Number);
    expect([c, rr]).toEqual([13, 4]);
    expect((rgb.body as Buffer).length).toBe(c * rr * 3);
  });

  it('keeps a large noisy PNG under 64 KB, inside the cell box, and clamps cols/rows', async () => {
    const a = await login('alice');
    const r = await room(a);
    const id = await upload(a, r, 'noise.png', noisyPng(600, 400));
    const res = await bin(call('get', `/files/${id}/preview.png?cols=80&rows=24`, a));
    expect(res.status).toBe(200);
    const buf = res.body as Buffer;
    expect(buf.length).toBeLessThanOrEqual(65536);
    const png = PNG.sync.read(buf);
    expect(png.width).toBeLessThanOrEqual(640);
    expect(png.height).toBeLessThanOrEqual(384);
    expect(res.headers['x-cells']).toBe(`${Math.ceil(png.width / 8)}x${Math.ceil(png.height / 16)}`);
    const tiny = await bin(call('get', `/files/${id}/preview.png?cols=1&rows=1`, a));
    const t = PNG.sync.read(tiny.body as Buffer);
    expect(t.width).toBeLessThanOrEqual(32);
    expect(t.height).toBeLessThanOrEqual(32);
  });

  it('415 not_image for non-pictures and undecodable image magic; 403 for non-members', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const r = await room(a);
    const txt = await upload(a, r, 'a.txt', Buffer.from('hello world'), 't1');
    const res = await call('get', `/files/${txt}/preview.png`, a);
    expect([res.status, res.body.error]).toEqual([415, 'not_image']);
    const bad = await upload(a, r, 'bad.png', Buffer.concat([Buffer.from('\x89PNG'), crypto.randomBytes(64)]), 't2');
    expect((await listing(a, r)).find((f) => f.id === bad)?.kind).toBe('binary');
    expect((await call('get', `/files/${bad}/preview.rgb`, a)).status).toBe(415);
    const pic = await upload(a, r, 'ok.png', pngOf(8, 8, () => [1, 2, 3]), 't3');
    const out = await call('get', `/files/${pic}/preview.png`, b);
    expect([out.status, out.body.error]).toEqual([403, 'not_member']);
  });

  it('caches previews next to the blob and deletes them with it (delete, expiry, room clear)', async () => {
    const dir = fx.cfg.chatFilesDir as string;
    const a = await login('alice');
    const r = await room(a);
    const id = await upload(a, r, 'c.png', pngOf(40, 40, () => [9, 9, 9]));
    await bin(call('get', `/files/${id}/preview.png?cols=10&rows=4`, a));
    await bin(call('get', `/files/${id}/preview.rgb?cols=10&rows=4`, a));
    const cache = () => fs.readdirSync(dir).filter((f) => f.startsWith(`${id}.p10x4.png`) || f.startsWith(`${id}.p10x4.rgb`));
    expect(cache().some((f) => f === `${id}.p10x4.png`)).toBe(true);
    expect(cache().some((f) => f === `${id}.p10x4.rgb`)).toBe(true);
    expect((await call('delete', `/files/${id}`, a)).status).toBe(200);
    expect(fs.readdirSync(dir)).toEqual([]);

    const e = await upload(a, r, 'e.png', pngOf(40, 40, () => [5, 5, 5]), 'c2');
    await bin(call('get', `/files/${e}/preview.png?cols=10&rows=4`, a));
    const db = fx.openAchievements();
    db.prepare('UPDATE chat_files SET expires_at = 1 WHERE id = ?').run(e);
    sweepFiles(db, dir);
    db.close();
    expect(fs.readdirSync(dir)).toEqual([]);

    const k = await upload(a, r, 'k.png', pngOf(40, 40, () => [7, 7, 7]), 'c3');
    await bin(call('get', `/files/${k}/preview.rgb?cols=10&rows=4`, a));
    expect(fs.readdirSync(dir).length).toBeGreaterThan(1);
    expect((await call('post', `/rooms/${r}/clear`, a).send({})).status).toBe(200);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('admin lists with filters and deletes with X-Admin-Token only', async () => {
    const a = await login('alice');
    const r = await room(a);
    const id = await upload(a, r, 'x.txt', Buffer.from('hello'), 'a1');
    const token = await fx.adminToken();
    const adm = (m: 'get' | 'delete', p: string) => request(fx.app)[m](`/chat/v1${p}`).set('Authorization', fx.auth).set('X-Admin-Token', `Bearer ${token}`);
    expect((await request(fx.app).get('/chat/v1/admin/files').set('Authorization', fx.auth).set('X-Chat-Session', a)).status).toBe(403);
    const all = await adm('get', `/admin/files?room=${r}`);
    expect(all.status).toBe(200);
    expect(all.body.files.map((f: { id: string }) => f.id)).toEqual([id]);
    expect((await adm('get', '/admin/files?uploader=nobody')).body.files).toEqual([]);
    expect((await adm('delete', `/admin/files/${id}`)).status).toBe(200);
    expect((await adm('get', `/admin/files?room=${r}`)).body.files).toEqual([]);
    const ev = await call('get', '/events.txt?since=0', a);
    expect(ev.text).toContain('file_deleted');
  });
});
