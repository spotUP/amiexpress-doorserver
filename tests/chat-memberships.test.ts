/**
 * Persistent chat membership, the last-read marker, history?after= and the
 * auto-away presence, over the real app.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string): Promise<string> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle });
  expect(r.status).toBe(201);
  return r.body.sid as string;
}
function api(method: 'get' | 'post' | 'put' | 'delete', path: string, sid?: string) {
  const r = request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth);
  return sid ? r.set('X-Chat-Session', sid) : r;
}
const rowsOf = (text: string): string[][] => text.split('\r\n').filter((l) => l !== '').slice(1).map((l) => l.split('|'));
async function post(sid: string, room: string, content: string): Promise<number> {
  const r = await api('post', `/rooms/${room}/messages`, sid).send({ content, clientId: `c${Math.random()}` });
  expect(r.status).toBe(201);
  return r.body.seq as number;
}
async function lobby(sid: string): Promise<string> {
  const id = (await api('post', '/rooms', sid).send({ name: 'lobby' })).body.id as string;
  await api('post', `/rooms/${id}/join`, sid);
  return id;
}
const memberships = async (sid: string) => rowsOf((await api('get', '/memberships.txt', sid)).text);
const statusOf = async (viewer: string, room: string, user: string) =>
  rowsOf((await api('get', `/rooms/${room}/members.txt`, viewer)).text).find((r) => r[0] === user)?.[5];

describe('persistent membership', () => {
  it('survives the session expiring and a new session sees the room', async () => {
    const a = await login('alice');
    const id = await lobby(a);
    expect((await api('delete', '/sessions/current', a)).status).toBe(200);
    const a2 = await login('alice');
    expect(await memberships(a2)).toEqual([[id, 'lobby', '0', '0']]);
  });

  it('starts a first join at the room head and reports lastRead', async () => {
    const a = await login('alice');
    const id = await lobby(a);
    const s1 = await post(a, id, 'one');
    const b = await login('bob');
    const j = await api('post', `/rooms/${id}/join`, b);
    expect(j.body.lastRead).toBe(s1);
    const again = await api('post', `/rooms/${id}/join`, b);
    expect(again.body.lastRead).toBe(s1);
  });

  it('counts unread and the marker never moves backwards', async () => {
    const a = await login('alice');
    const id = await lobby(a);
    const b = await login('bob');
    await api('post', `/rooms/${id}/join`, b);
    const s1 = await post(a, id, 'one');
    const s2 = await post(a, id, 'two');
    expect((await memberships(b))[0].slice(2)).toEqual(['0', '2']);
    expect((await api('put', `/rooms/${id}/read`, b).send({ seq: s2 })).body).toEqual({ lastRead: s2 });
    expect((await api('put', `/rooms/${id}/read`, b).send({ seq: s1 })).body).toEqual({ lastRead: s2 });
    expect((await memberships(b))[0].slice(2)).toEqual([String(s2), '0']);
    expect((await api('put', `/rooms/${id}/read`, b).send({ seq: 'x' })).status).toBe(400);
  });

  it('refuses a read marker without a membership', async () => {
    const a = await login('alice');
    const id = await lobby(a);
    const b = await login('bob');
    const r = await api('put', `/rooms/${id}/read`, b).send({ seq: 1 });
    expect(r.status).toBe(403);
  });

  it('removes the membership on an explicit leave', async () => {
    const a = await login('alice');
    const id = await lobby(a);
    await api('post', `/rooms/${id}/leave`, a);
    expect(await memberships(a)).toEqual([]);
  });

  it('removes the membership when the room is deleted', async () => {
    const a = await login('alice');
    const id = await lobby(a);
    expect((await api('delete', `/rooms/${id}`, a)).status).toBeLessThan(300);
    expect(await memberships(a)).toEqual([]);
  });

  it('history?after= returns only newer rows, oldest first, up to 500', async () => {
    const a = await login('alice');
    const id = await lobby(a);
    const s1 = await post(a, id, 'one');
    const s2 = await post(a, id, 'two');
    const s3 = await post(a, id, 'three');
    const h = rowsOf((await api('get', `/rooms/${id}/history.txt?after=${s1}`, a)).text);
    expect(h.map((r) => Number(r[0]))).toEqual([s2, s3]);
    const lim = rowsOf((await api('get', `/rooms/${id}/history.txt?after=0&limit=1`, a)).text);
    expect(lim.map((r) => Number(r[0]))).toEqual([s1]);
    expect(rowsOf((await api('get', `/rooms/${id}/history.txt?after=${s3}`, a)).text)).toEqual([]);
  });
});

describe('offline members and auto-away', () => {
  it('shows a member without a session as away, and back online with a new session', async () => {
    const a = await login('alice');
    const id = await lobby(a);
    const b = await login('bob');
    await api('post', `/rooms/${id}/join`, b);
    expect(await statusOf(a, id, 'bob@UPROUGH')).toBe('online');
    await api('delete', '/sessions/current', b);
    expect(await statusOf(a, id, 'bob@UPROUGH')).toBe('away');
    await login('bob');
    expect(await statusOf(a, id, 'bob@UPROUGH')).toBe('online');
  });

  it('keeps a second live session online', async () => {
    const a = await login('alice');
    const id = await lobby(a);
    const b1 = await login('bob');
    const b2 = await login('bob');
    await api('post', `/rooms/${id}/join`, b1);
    await api('delete', '/sessions/current', b1);
    expect(await statusOf(a, id, 'bob@UPROUGH')).toBe('online');
    expect(b2).toBeTruthy();
  });

  it('lets a user-set dnd survive expiry and a new session', async () => {
    const a = await login('alice');
    const id = await lobby(a);
    const b = await login('bob');
    await api('post', `/rooms/${id}/join`, b);
    await api('put', '/presence', b).send({ status: 'dnd', text: 'busy' });
    await api('delete', '/sessions/current', b);
    expect(await statusOf(a, id, 'bob@UPROUGH')).toBe('dnd');
    await login('bob');
    expect(await statusOf(a, id, 'bob@UPROUGH')).toBe('dnd');
  });
});
