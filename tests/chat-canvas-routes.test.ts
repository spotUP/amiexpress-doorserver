/**
 * The /draw canvas through the real app: POST canvas, GET canvas.txt, the
 * `canvas` event. One reachability test (POST -> GET -> events.txt); the rest
 * pin the refusals and the paging.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { _resetRateLimitsForTests } from '../src/achievements/ratelimit';
import { CHAT_LIMITS } from '../contract/chat-types';

let fx: AchievementsFixture;
beforeEach(() => { _resetRateLimitsForTests(); fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); _resetRateLimitsForTests(); });

async function login(handle: string, sysop = false): Promise<{ sid: string; user: string }> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop });
  return { sid: r.body.sid as string, user: r.body.user as string };
}
const call = (method: 'get' | 'post' | 'delete', path: string, sid: string) =>
  request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

async function artRoom(owner: { sid: string }, kind = 'art'): Promise<string> {
  const id = (await call('post', '/rooms', owner.sid).send({ name: `r${Math.random().toString(36).slice(2, 8)}`, kind })).body.id as string;
  await call('post', `/rooms/${id}/join`, owner.sid);
  return id;
}
const lines = (t: string): string[] => t.split('\r\n').filter((l) => l.length > 0);

describe('chat canvas', () => {
  it('REACHABLE: POST canvas -> GET canvas.txt -> events.txt carries the canvas event', async () => {
    const owner = await login('own');
    const id = await artRoom(owner);
    const post = await call('post', `/rooms/${id}/canvas`, owner.sid).send({ base: 0, ops: '@0,3:^40#*19;' });
    expect(post.status).toBe(200);
    expect(post.body).toEqual({ rev: 1 });

    const snap = await call('get', `/rooms/${id}/canvas.txt`, owner.sid);
    expect(snap.status).toBe(200);
    const l = lines(snap.text);
    expect(l[0]).toBe('CANVAS|1|1|24');
    expect(l).toHaveLength(25);
    expect(l[1]).toBe('0| *79;');
    expect(l[4]).toBe('3|^40#*19;^70 *59;');

    const ev = await call('get', '/events.txt?since=0&wait=0', owner.sid);
    const row = lines(ev.text).map((x) => x.split('|')).find((c) => c[1] === 'canvas');
    expect(row).toBeDefined();
    expect(row![2]).toBe(id);
    expect(row![3]).toBe(owner.user);
    expect(row![4]).toBe('1');
    expect(row![7]).toBe('@0,3:^40#*19;');
  });

  it('pages rows with from / count / maxBytes', async () => {
    const owner = await login('own');
    const id = await artRoom(owner);
    const part = await call('get', `/rooms/${id}/canvas.txt?from=10&count=3`, owner.sid);
    const l = lines(part.text);
    expect(l[0]).toBe('CANVAS|1|0|3');
    expect(l.slice(1).map((x) => x.split('|')[0])).toEqual(['10', '11', '12']);
    const tiny = await call('get', `/rooms/${id}/canvas.txt?maxBytes=60`, owner.sid);
    const t = lines(tiny.text);
    expect(t.length - 1).toBeGreaterThanOrEqual(1);
    expect(t.length - 1).toBeLessThan(24);
    expect(Number(t[0].split('|')[3])).toBe(t.length - 1);
    expect(Buffer.byteLength(tiny.text)).toBeLessThanOrEqual(100);
  });

  it('refuses a non-member, a non-art room, and a non-staff clear with 403', async () => {
    const owner = await login('own');
    const id = await artRoom(owner);
    const bob = await login('bob');
    const eve = await login('eve');
    expect((await call('post', `/rooms/${id}/canvas`, eve.sid).send({ ops: '@0,0:a' })).status).toBe(403);
    expect((await call('get', `/rooms/${id}/canvas.txt`, eve.sid)).status).toBe(403);
    const text = await artRoom(owner, 'text');
    expect((await call('post', `/rooms/${text}/canvas`, owner.sid).send({ ops: '@0,0:a' })).status).toBe(403);
    expect((await call('get', `/rooms/${text}/canvas.txt`, owner.sid)).status).toBe(403);

    await call('post', `/rooms/${id}/join`, bob.sid);
    expect((await call('post', `/rooms/${id}/canvas`, bob.sid).send({ ops: '@0,0:a' })).status).toBe(200);
    expect((await call('post', `/rooms/${id}/canvas`, bob.sid).send({ ops: 'X' })).status).toBe(403);
  });

  it('lets the owner and an op clear (D3); the clear blanks the canvas', async () => {
    const owner = await login('own');
    const id = await artRoom(owner);
    const bob = await login('bob');
    await call('post', `/rooms/${id}/join`, bob.sid);
    await call('post', `/rooms/${id}/canvas`, bob.sid).send({ ops: '@0,0:hello' });
    expect((await call('post', `/rooms/${id}/op`, owner.sid).send({ user: bob.user })).status).toBe(200);
    const r = await call('post', `/rooms/${id}/canvas`, bob.sid).send({ ops: 'X' });
    expect(r.status).toBe(200);
    expect(lines((await call('get', `/rooms/${id}/canvas.txt?from=0&count=1`, owner.sid)).text)[1]).toBe('0| *79;');
    expect((await call('post', `/rooms/${id}/canvas`, owner.sid).send({ ops: 'X' })).body.rev).toBe(3);
  });

  it('refuses 413 over 512 bytes and 422 for bad grammar, naming the offset', async () => {
    const owner = await login('own');
    const id = await artRoom(owner);
    const big = await call('post', `/rooms/${id}/canvas`, owner.sid).send({ ops: `@0,0:${'a'.repeat(CHAT_LIMITS.canvasOpsMax)}` });
    expect(big.status).toBe(413);
    const bad = await call('post', `/rooms/${id}/canvas`, owner.sid).send({ ops: '@0,0:ab|' });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain('byte 7');
    expect((await call('post', `/rooms/${id}/canvas`, owner.sid).send({ ops: '' })).status).toBe(422);
    expect((await call('post', `/rooms/${id}/canvas`, owner.sid).send({ ops: '@0,0:a*2000;' })).status).toBe(422);
    expect(lines((await call('get', `/rooms/${id}/canvas.txt?count=1`, owner.sid)).text)[1]).toBe('0| *79;');
  });

  it('refuses the post over the per-session rate with 429', async () => {
    const owner = await login('own');
    const id = await artRoom(owner);
    for (let i = 0; i < CHAT_LIMITS.canvasPostsPerSession; i++) {
      expect((await call('post', `/rooms/${id}/canvas`, owner.sid).send({ ops: '@0,0:a' })).status).toBe(200);
    }
    const over = await call('post', `/rooms/${id}/canvas`, owner.sid).send({ ops: '@0,0:a' });
    expect(over.status).toBe(429);
  });

  it('REVERT-PROOF: the canvas goes with a deleted room', async () => {
    const owner = await login('own');
    const id = await artRoom(owner);
    await call('post', `/rooms/${id}/canvas`, owner.sid).send({ ops: '@0,0:a' });
    expect((await call('delete', `/rooms/${id}`, owner.sid)).status).toBe(200);
    const db = fx.openAchievements();
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM chat_canvas WHERE room_id = ?').get(id)).toEqual({ n: 0 });
    } finally { db.close(); }
  });
});
