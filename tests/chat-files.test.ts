/**
 * Chat file sharing. ONE reachability test drives begin -> 3 chunks -> finish
 * -> events.txt -> GET /files/:id through the real app; the rest pin the
 * refusals where they live (store behaviour via the routes, name rebuild and
 * FILES render as pure functions).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { _resetRateLimitsForTests } from '../src/achievements/ratelimit';
import { fileStats, rebuildFileName, sweepFiles } from '../src/chat/files';
import { renderText } from '../src/chat/render';
import { CHAT_LIMITS } from '../contract/chat-types';

let fx: AchievementsFixture;
beforeEach(() => { _resetRateLimitsForTests(); fx = makeAchievementsFixture({ chatFiles: true }); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); _resetRateLimitsForTests(); });

async function login(handle: string, sysop = false): Promise<string> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop });
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
async function begin(sid: string, roomId: string, name: string, size: number, clientId = 'c1') {
  return call('post', `/rooms/${roomId}/files`, sid).send({ name, size, clientId });
}
async function upload(sid: string, roomId: string, name: string, data: Buffer, clientId = 'c1'): Promise<string> {
  const b = await begin(sid, roomId, name, data.length, clientId);
  const id = b.body.id as string;
  for (let off = 0; off < data.length; off += 32768) {
    const part = data.subarray(off, off + 32768);
    const r = await call('put', `/files/${id}/chunk?offset=${off}`, sid).set('Content-Type', 'application/octet-stream').send(part);
    expect(r.status).toBe(200);
  }
  const f = await call('post', `/files/${id}/finish`, sid).send({});
  expect(f.status).toBe(200);
  return id;
}
const lines = (t: string): string[] => t.split('\r\n').filter((l) => l.length > 0);
const binary = (res: request.Response): Buffer => res.body as Buffer;
const bin = (r: request.Test) => r.buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

describe('chat files', () => {
  it('REACHABLE: begin, 3 chunks, finish, events.txt, GET /files/:id with matching sha256', async () => {
    const a = await login('alice');
    const r = await room(a);
    const data = crypto.randomBytes(32768 * 2 + 100);
    data.writeUInt32BE(0x000003f3, 0);
    const before = fileStats.chunkCalls;
    const id = await upload(a, r, 'My Demo.exe', data);
    expect(fileStats.chunkCalls - before).toBe(3);

    const ev = await call('get', '/events.txt?since=0', a);
    const row = lines(ev.text).find((l) => l.startsWith(`file_shared|`) || l.includes('file_shared'));
    expect(row).toBeDefined();
    expect(row).toContain(`My_Demo.exe!${data.length}!program`);

    const dl = await bin(call('get', `/files/${id}`, a));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    expect(dl.headers['content-length']).toBe(String(data.length));
    expect(dl.headers['transfer-encoding']).toBeUndefined();
    expect(crypto.createHash('sha256').update(binary(dl)).digest('hex')).toBe(crypto.createHash('sha256').update(data).digest('hex'));
  });

  it('migration 13 created chat_files', () => {
    const db = fx.openAchievements();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chat_files'").get()).toBeDefined();
    db.close();
  });

  it('wrong offset gives 409 with received; short finish is refused', async () => {
    const a = await login('alice');
    const r = await room(a);
    const id = (await begin(a, r, 'a.txt', 10)).body.id as string;
    const bad = await call('put', `/files/${id}/chunk?offset=5`, a).set('Content-Type', 'application/octet-stream').send(Buffer.from('xx'));
    expect(bad.status).toBe(409);
    expect(bad.body.received).toBe(0);
    await call('put', `/files/${id}/chunk?offset=0`, a).set('Content-Type', 'application/octet-stream').send(Buffer.from('hello'));
    const fin = await call('post', `/files/${id}/finish`, a).send({});
    expect(fin.status).toBe(409);
  });

  it('raw parser accepts 32 KB and refuses 32 KB + 1; JSON stays capped at 32 KB', async () => {
    const a = await login('alice');
    const r = await room(a);
    const id = (await begin(a, r, 'big.bin', CHAT_LIMITS.fileMaxBytes)).body.id as string;
    const ok = await call('put', `/files/${id}/chunk?offset=0`, a).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(32768, 1));
    expect(ok.status).toBe(200);
    const big = await call('put', `/files/${id}/chunk?offset=32768`, a).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(32769, 1));
    expect(big.status).toBe(413);
    expect(big.body.error).toBe('too_large');
    const json = await call('post', `/rooms/${r}/files`, a).send({ name: 'x', size: 1, clientId: 'z'.repeat(40000) });
    expect(json.status).toBe(413);
  });

  it('refuses a file over 2 MB and a non-member download', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const r = await room(a);
    expect((await begin(a, r, 'x.bin', CHAT_LIMITS.fileMaxBytes + 1)).body.error).toBe('too_large');
    const id = await upload(a, r, 'x.bin', Buffer.from('abc'));
    expect((await call('get', `/files/${id}`, b)).status).toBe(403);
  });

  it('Range answers 206 with Content-Range', async () => {
    const a = await login('alice');
    const r = await room(a);
    const id = await upload(a, r, 'r.txt', Buffer.from('0123456789'));
    const res = await bin(call('get', `/files/${id}`, a).set('Range', 'bytes=2-5'));
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(binary(res).toString()).toBe('2345');
  });

  it('quota: charged on begin, refunded on cancel (6 rooms is the per-board creation cap)', async () => {
    const a = await login('alice');
    const mb2 = 2 * 1024 * 1024;
    const rooms: string[] = [];
    for (let i = 0; i < 6; i += 1) rooms.push(await room(a));
    const held: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const x = await begin(a, rooms[i], `g${i}.bin`, mb2, `g${i}`);
      expect(x.status).toBe(200);
      held.push(x.body.id as string);
    }
    const over = await begin(a, rooms[5], 'over.bin', mb2, 'over');
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('quota');
    await call('delete', `/files/${held[0]}`, a);
    expect((await begin(a, rooms[5], 'over.bin', mb2, 'over2')).status).toBe(200);
  });

  it('delete: uploader, op and admin may; a plain member may not; sweeper expiry removes the blob', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const r = await room(a, b);
    const mine = await upload(b, r, 'b.txt', Buffer.from('bob file'), 'b1');
    expect((await call('delete', `/files/${mine}`, b)).status).toBe(200);
    const two = await upload(b, r, 'b2.txt', Buffer.from('bob two'), 'b2');
    const c = await login('carol');
    await call('post', `/rooms/${r}/join`, c);
    expect((await call('delete', `/files/${two}`, c)).status).toBe(403);
    expect((await call('delete', `/files/${two}`, a)).status).toBe(200);
    expect((await call('get', `/files/${two}`, a)).status).toBe(404);

    const three = await upload(a, r, 'a3.txt', Buffer.from('alice three'), 'a3');
    const db = fx.openAchievements();
    const blob = `${fx.cfg.chatFilesDir}/${three}.bin`;
    expect(fs.existsSync(blob)).toBe(true);
    db.prepare('UPDATE chat_files SET expires_at = 1 WHERE id = ?').run(three);
    sweepFiles(db, fx.cfg.chatFilesDir ?? null);
    expect(fs.existsSync(blob)).toBe(false);
    db.close();
    expect((await call('get', `/files/${three}`, a)).status).toBe(404);
  });

  it('clearRoom deletes the room files; identical bytes share one blob', async () => {
    const a = await login('alice');
    const r = await room(a);
    const one = await upload(a, r, 'same.txt', Buffer.from('identical'), 'k1');
    const two = await upload(a, r, 'same2.txt', Buffer.from('identical'), 'k2');
    const files = fs.readdirSync(fx.cfg.chatFilesDir as string);
    expect(files).toEqual([`${one}.bin`]);
    expect((await call('get', `/files/${two}`, a)).status).toBe(200);
    expect((await call('post', `/rooms/${r}/clear`, a).send({})).status).toBe(200);
    expect(fs.readdirSync(fx.cfg.chatFilesDir as string)).toEqual([]);
    expect((await call('get', `/files/${one}`, a)).status).toBe(404);
  });

  it('answers 503 files_disabled without CHAT_FILES_DIR', async () => {
    _stopChatSweepersForTests();
    fx.cleanup();
    fx = makeAchievementsFixture();
    const a = await login('alice');
    const r = await room(a);
    const res = await begin(a, r, 'x.txt', 3);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('files_disabled');
  });

  it('FILES render golden and filename rebuild table', () => {
    expect(renderText('FILES', 17, [['f1', 'demo.lha', 48213, 'alice@BOARD', 1760000000, 'alice']]).toString('latin1')).toBe(
      'FILES|1|17|1\r\nf1|demo.lha|48213|alice@BOARD|1760000000|alice\r\n'
    );
    const table: [string, string][] = [
      ['My Demo.exe', 'My_Demo.exe'],
      ['..\\..\\etc/passwd', 'passwd'],
      ['DH0:Work/Tune.mod', 'Tune.mod'],
      ['.hidden', 'hidden'],
      ['Blåbær ße.txt', 'Blabaer_sse.txt'],
      ['???', 'file.bin'],
      ['a'.repeat(50) + '.lha', 'a'.repeat(26) + '.lha'],
    ];
    for (const [input, want] of table) expect(rebuildFileName(input)).toBe(want);
  });
});
