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

    expect((await audio(`/rooms/${id}/voice/audio`, ami, Buffer.alloc(0))).body).toHaveLength(0);
    const sent = Buffer.alloc(400, 0x9a);
    expect((await audio(`/rooms/${id}/voice/audio?mesh=1`, owner, sent)).status).toBe(200);
    const got = await audio(`/rooms/${id}/voice/audio`, ami, Buffer.alloc(0));
    expect(got.headers['content-type']).toMatch(/octet-stream/);
    expect(got.headers['content-length']).toBe('400');
    expect(Buffer.compare(got.body as Buffer, sent)).toBe(0);

    expect((await audio(`/rooms/${id}/voice/audio`, ami, Buffer.alloc(RELAY_MAX_BYTES + 1))).status).toBe(413);
  });
});
