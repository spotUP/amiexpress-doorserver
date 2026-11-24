/**
 * Voice-room calls on /chat/v1: the roster (join, leave, microphone/camera state) and
 * the WebRTC signal relay. Rules copy LIVECHAT's voice channels (src/partyline/livechat-voice.ts):
 * only voice rooms have a call, joining one call leaves the other, state changes fan out.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { _resetVoiceForTests } from '../src/chat/voice';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); _resetVoiceForTests(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string, sysop: boolean): Promise<{ sid: string; user: string }> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop });
  return { sid: r.body.sid as string, user: r.body.user as string };
}
const call = (method: 'get' | 'post' | 'put', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);
async function events(sid: string, type: string): Promise<string[][]> {
  const ev = await call('get', '/events.txt?since=0&wait=0', sid);
  return ev.text.split('\r\n').map((l) => l.split('|')).filter((c) => c[1] === type);
}

describe('voice room calls', () => {
  it('joins, lists, sets state, leaves; refuses text rooms and non-members', async () => {
    const owner = await login('sys', true);
    const id = (await call('post', '/rooms', owner.sid).send({ name: 'lounge', kind: 'voice' })).body.id as string;
    const text = (await call('post', '/rooms', owner.sid).send({ name: 'talk' })).body.id as string;
    await call('post', `/rooms/${id}/join`, owner.sid);
    await call('post', `/rooms/${text}/join`, owner.sid);
    const bob = await login('bob', false);
    const eve = await login('eve', false);
    await call('post', `/rooms/${id}/join`, bob.sid);

    expect((await call('post', `/rooms/${text}/voice/join`, owner.sid).send({})).status).toBe(403);
    expect((await call('post', `/rooms/${id}/voice/join`, eve.sid).send({})).status).toBe(403);

    expect((await call('post', `/rooms/${id}/voice/join`, owner.sid).send({ isMuted: true })).body.members)
      .toEqual([{ user: owner.user, isMuted: true, hasVideo: false }]);
    const joined = await call('post', `/rooms/${id}/voice/join`, bob.sid).send({ hasVideo: true });
    expect(joined.body.members).toHaveLength(2);

    expect((await call('put', `/rooms/${id}/voice`, bob.sid).send({ isMuted: true })).status).toBe(200);
    expect((await call('put', `/rooms/${id}/voice`, bob.sid).send({ isMuted: true })).status).toBe(200);
    expect((await call('get', `/rooms/${id}/voice`, owner.sid)).body.members)
      .toContainEqual({ user: bob.user, isMuted: true, hasVideo: true });

    expect((await call('post', `/rooms/${id}/voice/leave`, bob.sid)).body).toEqual({ left: true });
    expect((await call('put', `/rooms/${id}/voice`, bob.sid).send({ isMuted: false })).status).toBe(404);

    const rows = await events(owner.sid, 'voice');
    // An unchanged state (second PUT) emits nothing.
    expect(rows.filter((c) => c[3] === bob.user).map((c) => `${c[4]}:${c[7]}`)).toEqual(['joined:01', 'state:11', 'left:00']);
  });

  it('joining a second call leaves the first', async () => {
    const owner = await login('sys', true);
    const a = (await call('post', '/rooms', owner.sid).send({ name: 'va', kind: 'voice' })).body.id as string;
    const b = (await call('post', '/rooms', owner.sid).send({ name: 'vb', kind: 'voice' })).body.id as string;
    await call('post', `/rooms/${a}/join`, owner.sid);
    await call('post', `/rooms/${b}/join`, owner.sid);
    await call('post', `/rooms/${a}/voice/join`, owner.sid).send({});
    await call('post', `/rooms/${b}/voice/join`, owner.sid).send({});
    expect((await call('get', `/rooms/${a}/voice`, owner.sid)).body.members).toEqual([]);
    expect((await call('get', `/rooms/${b}/voice`, owner.sid)).body.members).toHaveLength(1);
  });

  it('relays signals between call members only, visible to sender and target alone, data intact', async () => {
    const owner = await login('sys', true);
    const id = (await call('post', '/rooms', owner.sid).send({ name: 'sig', kind: 'voice' })).body.id as string;
    await call('post', `/rooms/${id}/join`, owner.sid);
    const bob = await login('bob', false);
    const carol = await login('carol', false);
    await call('post', `/rooms/${id}/join`, bob.sid);
    await call('post', `/rooms/${id}/join`, carol.sid);
    await call('post', `/rooms/${id}/voice/join`, owner.sid).send({});
    await call('post', `/rooms/${id}/voice/join`, bob.sid).send({});

    // SDP carries '|' and newlines that the events.txt escaper would mangle: the relay base64s them.
    const sdp = JSON.stringify({ type: 'offer', sdp: 'v=0\r\na=group:BUNDLE 0|1\r\n' });
    expect((await call('post', `/rooms/${id}/voice/signal`, owner.sid).send({ to: bob.user, kind: 'offer', data: sdp })).status).toBe(200);
    expect((await call('post', `/rooms/${id}/voice/signal`, owner.sid).send({ to: carol.user, kind: 'offer', data: sdp })).status).toBe(404);
    expect((await call('post', `/rooms/${id}/voice/signal`, carol.sid).send({ to: bob.user, kind: 'offer', data: sdp })).status).toBe(404);
    expect((await call('post', `/rooms/${id}/voice/signal`, owner.sid).send({ to: bob.user, kind: 'hack', data: sdp })).status).toBe(400);

    const got = await events(bob.sid, 'voice_signal');
    expect(got).toHaveLength(1);
    expect(got[0][2]).toBe(id);
    expect(got[0][3]).toBe(owner.user);
    expect(got[0][4]).toBe('offer');
    expect(Buffer.from(got[0][7], 'base64').toString('utf8')).toBe(sdp);
    expect(await events(carol.sid, 'voice_signal')).toEqual([]);
  });
});
