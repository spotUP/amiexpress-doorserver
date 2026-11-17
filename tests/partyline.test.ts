/**
 * PLP/1 server skeleton (Partyline P1): codec, login, version pick, ACK flow,
 * resume, drain, TLS and plain on one port, and the one chat store shared
 * with /chat/v1.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as tls from 'tls';
import type { Duplex } from 'stream';
import request from 'supertest';
import { PLP_MAX_PAYLOAD } from '../contract/partyline-types';
import type { PlpFrame } from '../contract/partyline-types';
import { openAchievementsDb } from '../src/achievements/db';
import { setBoardSuspended, _clearBoardKeyCacheForTests } from '../src/achievements/boards';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { authMac, plpKeyOf } from '../src/partyline/auth';
import { encodeFrame, FrameDecoder, FrameError, kvPayload, parseKv, readAck, seqPayload } from '../src/partyline/frames';
import { createPartylineServer, loadPartylineConfig } from '../src/partyline/server';
import type { PartylineServer } from '../src/partyline/server';
import { encodeMedia, joinVoiceHub, MediaDecoder, resetVoiceHub } from '../src/partyline/livechat-voice';
import { OLD_CLIENT_SCREEN } from '../src/partyline/session';
import type { RenderPart, ScreenFactory, ScreenInfo } from '../src/partyline/session';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';

// TLS keygen, scrypt board keys and the shared machine make single tests take seconds.
jest.setTimeout(30_000);

describe('frame codec', () => {
  it('round-trips a frame split across chunks', () => {
    const wire = Buffer.concat([encodeFrame('K', 'hello'), encodeFrame('C', seqPayload(7, Buffer.alloc(0)))]);
    const dec = new FrameDecoder();
    const out: PlpFrame[] = [];
    for (let i = 0; i < wire.length; i += 2) out.push(...dec.push(wire.subarray(i, i + 2)));
    expect(out.map((f) => f.type)).toEqual(['K', 'C']);
    expect(out[0].payload.toString()).toBe('hello');
    expect(readAck(out[1].payload)).toBe(7);
  });

  it('carries a 4096-byte payload and refuses 4097', () => {
    const big = Buffer.alloc(PLP_MAX_PAYLOAD, 0xab);
    const [f] = new FrameDecoder().push(encodeFrame('D', big));
    expect(f.payload.equals(big)).toBe(true);
    expect(() => encodeFrame('D', Buffer.alloc(PLP_MAX_PAYLOAD + 1))).toThrow(FrameError);
  });

  it('refuses an oversize length on the wire', () => {
    const hdr = Buffer.from([0x44, 0, 0]);
    hdr.writeUInt16BE(PLP_MAX_PAYLOAD + 1, 1);
    expect(() => new FrameDecoder().push(hdr)).toThrow(FrameError);
  });
});

// ---- a fake client ----

class Client {
  frames: PlpFrame[] = [];
  closed = false;
  private dec = new FrameDecoder();
  private waiters: Array<() => void> = [];
  constructor(readonly sock: Duplex) {
    sock.on('data', (c: Buffer) => { this.frames.push(...this.dec.push(c)); this.wake(); });
    sock.on('close', () => { this.closed = true; this.wake(); });
    sock.on('end', () => sock.end());
    sock.on('error', () => undefined);
  }
  private wake(): void { for (const w of this.waiters.splice(0)) w(); }
  send(type: string, payload?: Buffer | string): void { this.sock.write(encodeFrame(type, payload)); }
  /** Removes and returns the first frame of `type`. */
  async next(type: string, ms = 3000): Promise<PlpFrame> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.frames.findIndex((f) => f.type === type);
      if (i >= 0) return this.frames.splice(i, 1)[0];
      if (this.closed || Date.now() > deadline) throw new Error(`no ${type} frame (got ${this.frames.map((f) => f.type).join('')})`);
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
    }
  }
  async untilClosed(ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!this.closed && Date.now() < deadline) await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
    expect(this.closed).toBe(true);
  }
}

const text = (f: PlpFrame): string => f.payload.subarray(4).toString('latin1');

let fx: AchievementsFixture;
let hub: PartylineServer;
let port: number;
let certDir: string;
let tlsCtx: { cert: Buffer; key: Buffer };
let screens: ScreenInfo[];
let renders: string[];

/** The model each test drives: render returns `state`. */
let state = 'v0';
/** When set, render returns these parts (D text and G kitty bytes) instead of `state`. */
let parts: RenderPart[] | null = null;
/** Per session id: where an M frame from that caller goes. */
const mediaIn = new Map<string, (p: Buffer) => void>();
const testScreen: ScreenFactory = (info) => {
  screens.push(info);
  return {
    resize() { /* the stub's job */ },
    input() { /* none */ },
    render() { renders.push(state); return parts ?? Buffer.from(state); },
    media: (p) => mediaIn.get(info.sid)?.(p),
  };
};

beforeAll(() => {
  certDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'plp-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem')], { stdio: 'ignore' });
  tlsCtx = { cert: fs.readFileSync(path.join(certDir, 'cert.pem')), key: fs.readFileSync(path.join(certDir, 'key.pem')) };
});
afterAll(() => fs.rmSync(certDir, { recursive: true, force: true }));

beforeEach(async () => {
  fx = makeAchievementsFixture();
  screens = [];
  renders = [];
  state = 'v0';
  parts = null;
  hub = createPartylineServer({ enabled: true, port: 0, host: '127.0.0.1', tlsCert: null, tlsKey: null }, fx.ach,
    { screen: testScreen, log: () => undefined, tlsContext: tlsCtx });
  port = await hub.listen();
});
afterEach(async () => {
  await hub.drain();
  _stopChatSweepersForTests();
  _clearBoardKeyCacheForTests();
  fx.cleanup();
});

const secret = (): string => fx.boardKey.split('.').slice(1).join('.');

function dial(useTls: boolean): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock = useTls
      ? tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => resolve(new Client(sock)))
      : net.connect(port, '127.0.0.1', () => resolve(new Client(sock)));
    sock.once('error', reject);
  });
}

const hello = (extra: Record<string, string | number> = {}): Buffer =>
  kvPayload({ proto: '1.0', client: 'test/1', board: fx.boardId, handle: 'spot', cols: 80, rows: 25, ...extra });

/** HELLO, answer the challenge with `key`, return the WELCOME fields. */
async function login(c: Client, opts: { key?: string; extra?: Record<string, string | number> } = {}): Promise<Map<string, string>> {
  c.send('H', hello(opts.extra));
  const nonce = (await c.next('N')).payload.toString('latin1');
  c.send('A', authMac(opts.key ?? plpKeyOf(secret()), nonce, fx.boardId, 'spot'));
  return parseKv((await c.next('W')).payload);
}

describe('login', () => {
  it.each([['plain', false], ['tls', true]])('logs in over %s and gets W then a D frame', async (_name, useTls) => {
    const c = await dial(useTls);
    const w = await login(c);
    expect(w.get('proto')).toBe('1.0');
    expect(w.get('resume')).toMatch(/^[0-9a-f]{32}$/);
    expect(text(await c.next('D'))).toBe('v0');
    c.sock.destroy();
  });

  it('refuses a bad key with a screen and X', async () => {
    const c = await dial(false);
    c.send('H', hello());
    const nonce = (await c.next('N')).payload.toString('latin1');
    c.send('A', authMac(plpKeyOf('wrong'), nonce, fx.boardId, 'spot'));
    expect(text(await c.next('D'))).toContain('does not know this board key');
    expect((await c.next('X')).payload.toString()).toBe('unauthenticated');
    await c.untilClosed();
  });

  it('refuses a suspended board', async () => {
    const db = openAchievementsDb(fx.ach);
    setBoardSuspended(db, fx.boardId, true);
    db.close();
    const c = await dial(false);
    c.send('H', hello());
    const nonce = (await c.next('N')).payload.toString('latin1');
    c.send('A', authMac(plpKeyOf(secret()), nonce, fx.boardId, 'spot'));
    expect((await c.next('X')).payload.toString()).toBe('board_suspended');
  });

  it('serves a newer minor at ours and refuses an old major with the update screen', async () => {
    const c1 = await dial(false);
    expect((await login(c1, { extra: { proto: '1.7' } })).get('proto')).toBe('1.1');
    c1.sock.destroy();
    const c2 = await dial(false);
    c2.send('H', hello({ proto: '0.9' }));
    expect(text(await c2.next('D'))).toContain(OLD_CLIENT_SCREEN);
    expect((await c2.next('X')).payload.toString()).toBe('old_client');
  });

  it('skips unknown frame types and hello keys', async () => {
    const c = await dial(false);
    c.send('Z', 'from the future');
    await login(c, { extra: { warp: 9 } });
    c.send('Z', 'still from the future');
    c.send('P', 'ping-1');
    expect((await c.next('O')).payload.toString()).toBe('ping-1');
  });
});

describe('live loop', () => {
  it('holds the next D until C, then sends the merged latest state', async () => {
    const c = await dial(false);
    await login(c);
    const first = await c.next('D');
    expect(text(first)).toBe('v0');
    state = 'v1'; screens[0].markDirty();
    state = 'v2'; screens[0].markDirty();
    await new Promise((r) => setTimeout(r, 150));
    expect(c.frames.filter((f) => f.type === 'D')).toHaveLength(0);
    c.send('C', seqPayload(first.payload.readUInt32BE(0), Buffer.alloc(0)));
    const second = await c.next('D');
    expect(text(second)).toBe('v2');
    expect(second.payload.readUInt32BE(0)).toBe(first.payload.readUInt32BE(0) + 1);
    expect(renders).toEqual(['v0', 'v2']);
  });

  it('a door quit sends its last screen and waits for its C before closing', async () => {
    // LIVECHAT /quit writes a clear then ends; closing at once left the wide chat on screen (sysop, 2026-11-16).
    const c = await dial(false);
    await login(c);
    const first = await c.next('D');
    state = 'cleared'; screens[0].markDirty();
    screens[0].quit!();
    await new Promise((r) => setTimeout(r, 100));
    expect(c.sock.destroyed || c.sock.readableEnded).toBe(false);
    c.send('C', seqPayload(first.payload.readUInt32BE(0), Buffer.alloc(0)));
    const last = await c.next('D');
    expect(text(last)).toBe('cleared');
    c.send('C', seqPayload(last.payload.readUInt32BE(0), Buffer.alloc(0)));
    await c.untilClosed();
  });

  it('hands the screen the caller kitty flag and connection type, telnet when unknown', async () => {
    const a = await dial(false);
    await login(a, { extra: { kitty: 1, conn: 'web' } });
    const b = await dial(false);
    await login(b, { extra: { conn: 'modem' } });
    expect([screens[0].hello.kitty, screens[0].hello.conn]).toEqual([true, 'web']);
    expect([screens[1].hello.kitty, screens[1].hello.conn]).toEqual([false, 'telnet']);
  });

  it('sends D and G parts in render order on one sequence, one frame per C, splitting a big G', async () => {
    const c = await dial(false);
    await login(c);
    const first = await c.next('D');
    const big = Buffer.alloc(PLP_MAX_PAYLOAD, 'A');
    parts = [{ type: 'D', bytes: Buffer.from('a') }, { type: 'G', bytes: big }, { type: 'D', bytes: Buffer.from('b') }];
    screens[0].markDirty();
    let seq = first.payload.readUInt32BE(0);
    const got: Array<[string, number]> = [];
    for (let i = 0; i < 4; i++) {
      c.send('C', seqPayload(seq, Buffer.alloc(0)));
      for (;;) {
        const f = c.frames.find((x) => x.type === 'D' || x.type === 'G');
        if (f) { c.frames.splice(c.frames.indexOf(f), 1); got.push([f.type, f.payload.length - 4]); seq = f.payload.readUInt32BE(0); break; }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(seq).toBe(first.payload.readUInt32BE(0) + i + 1);
    }
    expect(got).toEqual([['D', 1], ['G', PLP_MAX_PAYLOAD - 4], ['G', 4], ['D', 1]]);
  });

  it('resumes the same chat session after a disconnect', async () => {
    const c1 = await dial(false);
    const sid = (await login(c1)).get('resume') as string;
    c1.sock.destroy();
    await new Promise((r) => setTimeout(r, 50));
    const c2 = await dial(true);
    expect((await login(c2, { extra: { resume: sid } })).get('resume')).toBe(sid);
    c2.sock.destroy();
  });

  it('drains with a status line and keeps the chat session for resume', async () => {
    const c = await dial(false);
    const sid = (await login(c)).get('resume') as string;
    await c.next('D');
    await hub.drain();
    expect(text(await c.next('D'))).toContain('restarting');
    await c.untilClosed();
    const res = await request(fx.app).get('/chat/v1/who.txt').set('Authorization', fx.auth).set('X-Chat-Session', sid);
    expect(res.status).toBe(200);
  });

  it('shares one store with /chat/v1: the PLP session is a chat session', async () => {
    const c = await dial(false);
    const sid = (await login(c)).get('resume') as string;
    const res = await request(fx.app).get('/chat/v1/who.txt').set('Authorization', fx.auth).set('X-Chat-Session', sid);
    expect(res.status).toBe(200);
    expect(res.text).toContain('spot');
    c.send('Q', 'user');
    await c.untilClosed();
    expect((await request(fx.app).get('/chat/v1/who.txt').set('Authorization', fx.auth).set('X-Chat-Session', sid)).status).toBe(401);
  });
});

describe('loadPartylineConfig', () => {
  it('is on by default and off only with PARTYLINE_ENABLED=0', () => {
    expect(loadPartylineConfig({}).enabled).toBe(true);
    expect(loadPartylineConfig({ PARTYLINE_ENABLED: '1' }).enabled).toBe(true);
    expect(loadPartylineConfig({ PARTYLINE_ENABLED: '0' }).enabled).toBe(false);
  });
});

describe('media (M frames)', () => {
  const dials = async (extra: Record<string, string | number>): Promise<{ c: Client; info: ScreenInfo }> => {
    const c = await dial(false);
    await login(c, { extra });
    await c.next('D');
    return { c, info: screens[screens.length - 1] };
  };

  it('relays a client M to the screen and hub M back, only with media=1', async () => {
    const got: Buffer[] = [];
    const on = await dials({ media: 1 });
    mediaIn.set(on.info.sid, (p) => got.push(p));
    on.c.send('M', encodeMedia('voice:speaking', { isSpeaking: true })[0]);
    on.c.send('P', 'x');
    await on.c.next('O');
    on.info.media!(encodeMedia('audio:start-streaming', {})[0]);
    expect((await on.c.next('M')).payload.toString('latin1')).toContain('audio:start-streaming');
    expect(got).toHaveLength(1);

    const off = await dials({ media: 0 });
    mediaIn.set(off.info.sid, (p) => got.push(p));
    off.c.send('M', encodeMedia('voice:speaking', {})[0]);
    off.c.send('P', 'x');
    await off.c.next('O');
    expect(off.info.media).toBeUndefined();
    expect(got).toHaveLength(1);
  });

  it('carries audio:data from caller A to caller B as userId|NUL|pcm, not back to A', async () => {
    resetVoiceHub();
    const a = await dials({ media: 1 });
    const b = await dials({ media: 1 });
    for (const [who, id] of [[a, 'a@x'], [b, 'b@y']] as const) {
      const v = joinVoiceHub({ userId: id, username: id, room: () => 'main', event: () => undefined, media: (p) => who.info.media!(p) });
      mediaIn.set(who.info.sid, (p) => v.onMedia(p));
    }
    const pcm = Buffer.from([1, 2, 3, 4]);
    a.c.send('M', encodeMedia('audio:data', pcm)[0]);
    const got = new MediaDecoder().push((await b.c.next('M')).payload);
    expect(got).toEqual({ ev: 'audio:data', body: Buffer.concat([Buffer.from('a@x\0'), pcm]) });
    a.c.send('P', 'x');
    await a.c.next('O');
    await expect(a.c.next('M', 200)).rejects.toThrow();
    resetVoiceHub();
  });

  it('drops M frames while the socket has over 256 KB queued, terminal output still flows', async () => {
    const { c, info } = await dials({ media: 1 });
    c.sock.pause();
    const chunk = Buffer.alloc(4000, 7);
    for (let i = 0; i < 3000; i++) info.media!(encodeMedia('audio:data', chunk)[0]);
    c.sock.resume();
    c.send('P', 'x');
    await c.next('O', 10_000);
    const n = (c as unknown as { frames: PlpFrame[] }).frames.filter((f) => f.type === 'M').length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(3000);
  });
});
