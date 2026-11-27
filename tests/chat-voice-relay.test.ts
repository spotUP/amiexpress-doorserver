/**
 * The voice-room audio relay for callers without WebRTC: the G.711 mu-law codec, the mixer
 * rules (no echo, no mesh-to-mesh, mute, backlog cap) and PUT /rooms/:id/voice/audio.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { _resetVoiceForTests } from '../src/chat/voice';
import { AudioRelay, RELAY_MAX_BYTES, ulawDecode, ulawEncode } from '../src/chat/voice-relay';
import { encodeMedia, joinVoiceHub, MediaDecoder, resetVoiceHub } from '../src/partyline/livechat-voice';

describe('mu-law codec', () => {
  it('matches the G.711 reference points', () => {
    expect(ulawEncode(0)).toBe(0xff);
    expect(ulawEncode(32767)).toBe(0x80);
    expect(ulawEncode(-32768)).toBe(0x00);
    expect(ulawDecode(0xff)).toBe(0);
    expect(ulawDecode(0x80)).toBe(32124);
    expect(ulawDecode(0x00)).toBe(-32124);
    expect(ulawEncode(1000)).toBe(0xce);
    expect(ulawDecode(0xce)).toBe(988);
  });
  it('round-trips every byte, and every sample within the step size', () => {
    for (let b = 0; b < 256; b++) if (b !== 0x7f) expect(ulawEncode(ulawDecode(b))).toBe(b);
    for (let s = -32768; s < 32768; s += 7) {
      const back = ulawDecode(ulawEncode(s));
      expect(Math.abs(back - Math.max(-32124, Math.min(32124, s)))).toBeLessThanOrEqual((Math.abs(s) >> 4) + 9);
    }
  });
});

describe('AudioRelay mixer', () => {
  const opts = (mesh = false, muted = false, now = 0) => ({ mesh, muted, inCall: () => true, now });
  const tone = (v: number, n: number) => Buffer.alloc(n, ulawEncode(v));

  it('sends a sender audio to the others, never back to the sender', () => {
    const r = new AudioRelay();
    r.exchange('ami', Buffer.alloc(0), opts());
    r.exchange('web', tone(1000, 160), opts(true));
    expect(r.exchange('web', Buffer.alloc(0), opts(true))).toHaveLength(0);
    const got = r.exchange('ami', Buffer.alloc(0), opts());
    expect([...got]).toEqual([...tone(1000, 160)]);
    expect(r.exchange('ami', Buffer.alloc(0), opts())).toHaveLength(0);
  });

  it('mixes two senders sample by sample and clips', () => {
    const r = new AudioRelay();
    r.exchange('ami', Buffer.alloc(0), opts());
    r.exchange('a', tone(1000, 100), opts(true));
    r.exchange('b', tone(2000, 50), opts(true));
    const got = r.exchange('ami', Buffer.alloc(0), opts());
    expect(got).toHaveLength(100);
    expect(ulawDecode(got[0])).toBeCloseTo(ulawDecode(ulawEncode(988 + 1980)), -2);
    expect(got[99]).toBe(ulawEncode(988));
    r.exchange('a', tone(30000, 10), opts(true));
    r.exchange('b', tone(30000, 10), opts(true));
    expect(r.exchange('ami', Buffer.alloc(0), opts())[0]).toBe(0x80);
  });

  it('never relays mesh to mesh, drops a muted sender, caps a backlog at one second', () => {
    const r = new AudioRelay();
    r.exchange('web1', Buffer.alloc(0), opts(true));
    r.exchange('web2', tone(500, 80), opts(true));
    expect(r.exchange('web1', Buffer.alloc(0), opts(true))).toHaveLength(0);
    r.exchange('ami', Buffer.alloc(0), opts());
    r.exchange('ami2', tone(500, 80), opts(false, true));
    expect(r.exchange('ami', Buffer.alloc(0), opts())).toHaveLength(0);
    for (let i = 0; i < 3; i++) r.exchange('web2', tone(500, RELAY_MAX_BYTES), opts(true));
    expect(r.exchange('ami', Buffer.alloc(0), opts())).toHaveLength(RELAY_MAX_BYTES);
  });

  it('never relays within a group; a door caller hears and is heard by mesh and Amiga callers', () => {
    const relay = new AudioRelay();
    const at = (mesh: boolean | 'door' | 'mesh' | null) => ({ mesh, muted: false, inCall: () => true, now: 0 });
    for (const [u, g] of [['d1', 'door'], ['d2', 'door'], ['web', 'mesh'], ['ami', null]] as const) relay.exchange(u, Buffer.alloc(0), at(g));
    relay.exchange('d1', Buffer.alloc(10, 0x9a), at('door'));
    expect(relay.exchange('d2', Buffer.alloc(0), at('door')).length).toBe(0);
    expect(relay.exchange('web', Buffer.alloc(0), at('mesh')).length).toBe(10);
    expect(relay.exchange('ami', Buffer.alloc(0), at(null)).length).toBe(10);
    relay.exchange('web', Buffer.alloc(6, 0x9a), at('mesh'));
    expect(relay.exchange('d2', Buffer.alloc(0), at('door')).length).toBe(6);
  });

  it('forgets a listener that left the call or went idle', () => {
    const r = new AudioRelay();
    r.exchange('gone', Buffer.alloc(0), opts());
    r.exchange('idle', Buffer.alloc(0), opts(false, false, 0));
    r.exchange('ami', tone(100, 10), { mesh: false, muted: false, inCall: (u) => u !== 'gone', now: 10_000 });
    expect(r.size).toBe(1);
  });
});

describe('PUT /rooms/:id/voice/audio', () => {
  let fx: AchievementsFixture;
  beforeEach(() => { fx = makeAchievementsFixture(); _resetVoiceForTests(); });
  afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

  async function login(handle: string, sysop: boolean): Promise<string> {
    return (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop })).body.sid as string;
  }
  const call = (method: 'post' | 'put', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);
  const audio = (path: string, sid: string, bytes: Buffer) => call('put', path, sid).set('Content-Type', 'application/octet-stream').send(bytes)
    .buffer(true).parse((res, cb) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); });

  it('carries audio between call members, refuses outsiders and oversize posts', async () => {
    const owner = await login('sys', true);
    const id = (await call('post', '/rooms', owner).send({ name: 'lounge', kind: 'voice' })).body.id as string;
    await call('post', `/rooms/${id}/join`, owner);
    const ami = await login('ami', false);
    await call('post', `/rooms/${id}/join`, ami);

    expect((await audio(`/rooms/${id}/voice/audio`, ami, Buffer.alloc(0))).status).toBe(404);
    await call('post', `/rooms/${id}/voice/join`, owner).send({});
    await call('post', `/rooms/${id}/voice/join`, ami).send({});

    const first = await audio(`/rooms/${id}/voice/audio`, ami, Buffer.alloc(0));
    expect(`${first.status} ${(first.body as Buffer).toString()}`).toBe('200 ');
    const sent = Buffer.alloc(400, 0x9a);
    expect((await audio(`/rooms/${id}/voice/audio?mesh=1`, owner, sent)).status).toBe(200);
    const got = await audio(`/rooms/${id}/voice/audio`, ami, Buffer.alloc(0));
    expect(got.headers['content-type']).toMatch(/octet-stream/);
    expect(got.headers['content-length']).toBe('400');
    expect(Buffer.compare(got.body as Buffer, sent)).toBe(0);

    expect((await audio(`/rooms/${id}/voice/audio`, ami, Buffer.alloc(RELAY_MAX_BYTES + 1))).status).toBe(413);
  });

  it('logs voice join and each caller first audio post under LOG_LEVEL=debug only', async () => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((l: string) => { lines.push(l); });
    const prev = process.env.LOG_LEVEL;
    try {
      const owner = await login('sys', true);
      const id = (await call('post', '/rooms', owner).send({ name: 'lounge', kind: 'voice' })).body.id as string;
      await call('post', `/rooms/${id}/join`, owner);
      const ami = await login('ami', false);
      await call('post', `/rooms/${id}/join`, ami);
      delete process.env.LOG_LEVEL;
      await call('post', `/rooms/${id}/voice/join`, owner).send({});
      expect(lines.filter((l) => l.startsWith('[voice]'))).toEqual([]);
      process.env.LOG_LEVEL = 'debug';
      await call('post', `/rooms/${id}/voice/join`, ami).send({});
      await audio(`/rooms/${id}/voice/audio`, owner, Buffer.alloc(0));
      await audio(`/rooms/${id}/voice/audio`, ami, Buffer.alloc(160, 0x9a));
      const v = lines.filter((l) => l.startsWith('[voice]'));
      expect(v[0]).toMatch(/^\[voice\] join room=\S+ user=\S+ muted=0 members=2$/);
      expect(v[1]).toMatch(/audio .* bytes=0 .* to=0 .* posts=1 withBytes=0 forwarded=0$/);
      expect(v[2]).toMatch(/audio .* bytes=160 muted=0 to=1 listeners=2 posts=1 withBytes=1 forwarded=1$/);
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev;
    }
  });

  it('bridges a Partyline door caller in the room into the call, both ways, muted dropped', async () => {
    resetVoiceHub();
    const owner = await login('sys', true);
    const id = (await call('post', '/rooms', owner).send({ name: 'lounge', kind: 'voice' })).body.id as string;
    await call('post', `/rooms/${id}/join`, owner);
    const door = (userId: string) => {
      const got: Buffer[] = [];
      const dec = new MediaDecoder();
      const voice = joinVoiceHub({ userId, username: userId, room: () => id, event: () => undefined, media: (p) => { const m = dec.push(p); if (m?.ev === 'audio:ulaw') got.push(m.body); } });
      const tick = (bytes: Buffer) => { for (const p of encodeMedia('audio:ulaw', bytes)) voice.onMedia(p); };
      return { got, voice, tick };
    };
    const d1 = door('alice'), d2 = door('bob');

    // No call in the room yet: nothing to bridge to.
    d1.tick(Buffer.alloc(10, 0x9a));
    await call('post', `/rooms/${id}/voice/join`, owner).send({});
    expect((await audio(`/rooms/${id}/voice/audio?mesh=1`, owner, Buffer.alloc(0))).body.length).toBe(0);

    d1.tick(Buffer.alloc(0)); d2.tick(Buffer.alloc(0));
    const said = Buffer.alloc(300, 0x9a);
    d1.tick(said);
    expect(Buffer.compare((await audio(`/rooms/${id}/voice/audio?mesh=1`, owner, Buffer.alloc(200, 0xa0))).body as Buffer, said)).toBe(0);
    // Door to door stays on LIVECHAT's audio:data; the /chat caller's 200 bytes reach both doors.
    d2.tick(Buffer.alloc(0));
    expect(d2.got.map((b) => b.length)).toEqual([200]);
    d1.tick(Buffer.alloc(0));
    expect(d1.got.map((b) => b.length)).toEqual([200]);

    d1.voice.onDoorEmit('voice:mute', { isMuted: true });
    d1.tick(Buffer.alloc(300, 0x9a));
    expect((await audio(`/rooms/${id}/voice/audio?mesh=1`, owner, Buffer.alloc(0))).body.length).toBe(0);
    d1.voice.close(); d2.voice.close();
  });

  it('tells the door audio:relay active only while the room has a /chat call', async () => {
    resetVoiceHub();
    const owner = await login('sys', true);
    const id = (await call('post', '/rooms', owner).send({ name: 'lounge', kind: 'voice' })).body.id as string;
    await call('post', `/rooms/${id}/join`, owner);
    const told: boolean[] = [];
    const dec = new MediaDecoder();
    const voice = joinVoiceHub({ userId: 'alice', username: 'alice', room: () => id, event: () => undefined,
      media: (p) => { const m = dec.push(p); if (m?.ev === 'audio:relay') told.push((JSON.parse(m.body.toString()) as { active: boolean }).active); } });
    voice.onDoorEmit('audio:start-streaming', {});
    expect(told).toEqual([false]);
    await call('post', `/rooms/${id}/voice/join`, owner).send({});
    expect(told).toEqual([false, true]);
    voice.onDoorEmit('voice:mute', { isMuted: false }); // no change: nothing resent
    await call('post', `/rooms/${id}/voice/leave`, owner);
    expect(told).toEqual([false, true, false]);
    voice.close();
  });
});
