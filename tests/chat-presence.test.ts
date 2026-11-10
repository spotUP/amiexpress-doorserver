/**
 * Chat presence, profile and ignore list over the real app. One reachability
 * path per route; the old who.txt / members.txt field positions are pinned.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { CHAT_LIMITS, CHAT_TEXT_FORMATS } from '../contract/chat-types';

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

async function lobby(sid: string, name = 'lobby'): Promise<string> {
  const id = (await api('post', '/rooms', sid).send({ name })).body.id as string;
  await api('post', `/rooms/${id}/join`, sid);
  return id;
}

describe('presence', () => {
  it('appends status and text to who.txt and members.txt without moving the old fields', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const id = await lobby(a);
    await api('post', `/rooms/${id}/join`, b);
    const before = rowsOf((await api('get', '/who.txt', a)).text);
    expect(before.every((r) => r.length === CHAT_TEXT_FORMATS.WHO.length)).toBe(true);
    expect(before.every((r) => r[5] === 'online' && r[6] === '')).toBe(true);

    const set = await api('put', '/presence', b).send({ status: 'away', text: 'at lunch' });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ status: 'away', statusText: 'at lunch' });

    const who = rowsOf((await api('get', '/who.txt', a)).text);
    const bob = who.find((r) => r[0] === 'bob@UPROUGH')!;
    expect(bob.slice(0, 5)).toEqual(['bob@UPROUGH', 'lobby', '0', '', expect.stringMatching(/^\d+$/)]);
    expect(bob.slice(5)).toEqual(['away', 'at lunch', 'bob']);
    const mem = rowsOf((await api('get', `/rooms/${id}/members.txt`, a)).text);
    const mb = mem.find((r) => r[0] === 'bob@UPROUGH')!;
    expect(mb).toHaveLength(CHAT_TEXT_FORMATS.MEMBERS.length);
    expect(mb.slice(0, 5)).toEqual(['bob@UPROUGH', '0', '0', '', '']);
    expect(mb.slice(5)).toEqual(['away', 'at lunch', 'bob']);

    expect((await api('delete', '/presence', b)).body).toEqual({ status: 'online', statusText: '' });
    const after = rowsOf((await api('get', '/who.txt', a)).text).find((r) => r[0] === 'bob@UPROUGH')!;
    expect(after.slice(5)).toEqual(['online', '', 'bob']);
  });

  it('emits a presence event to room members and validates input', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const id = await lobby(a);
    await api('post', `/rooms/${id}/join`, b);
    const since = (await api('get', '/events.txt?wait=0', a)).text.split('|')[2];
    await api('put', '/presence', b).send({ status: 'dnd', text: 'busy|now' });
    const ev = rowsOf((await api('get', `/events.txt?since=${since}&wait=0`, a)).text).filter((r) => r[1] === 'presence');
    expect(ev).toHaveLength(1);
    expect(ev[0][2]).toBe(id);
    expect(ev[0][3]).toBe('bob@UPROUGH');
    expect(ev[0][7]).toBe('dnd!busy!now');

    expect((await api('put', '/presence', b).send({ status: 'sleeping' })).status).toBe(400);
    expect((await api('put', '/presence', b).send({ status: 'away', text: 'x'.repeat(CHAT_LIMITS.statusTextMax + 1) })).status).toBe(400);
    expect((await api('put', '/presence')).status).toBe(401);
  });

  it('forgets the status when the last session ends', async () => {
    const a = await login('alice');
    const b = await login('bob');
    await lobby(a);
    await api('put', '/presence', b).send({ status: 'busy' });
    await api('delete', '/sessions/current', b);
    const b2 = await login('bob');
    const id = (await api('get', '/rooms', a)).body[0].id as string;
    await api('post', `/rooms/${id}/join`, b2);
    const row = rowsOf((await api('get', '/who.txt', a)).text).find((r) => r[0] === 'bob@UPROUGH')!;
    expect(row.slice(5)).toEqual(['online', '', 'bob']);
  });
});

describe('profile', () => {
  it('returns one PROFILE row with status and the rooms both users are in', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const shared = await lobby(a, 'shared');
    await api('post', `/rooms/${shared}/join`, b);
    await lobby(a, 'alone');
    await api('put', '/presence', b).send({ status: 'away', text: 'brb' });
    const r = await api('get', '/users/bob%40UPROUGH/profile.txt', a);
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBeDefined();
    const rows = rowsOf(r.text);
    expect(r.text.startsWith('PROFILE|1|')).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(CHAT_TEXT_FORMATS.PROFILE.length);
    const [user, nick, board, status, text, first, last, idle, online, rooms] = rows[0];
    expect([user, nick, board, status, text, online, rooms]).toEqual(['bob@UPROUGH', 'bob', 'UPROUGH', 'away', 'brb', '1', shared]);
    expect(Number(first)).toBeGreaterThan(0);
    expect(Number(last)).toBeGreaterThanOrEqual(Number(first));
    expect(idle).toMatch(/^\d+$/);
  });

  it('reports an offline user from the event log and 404s a stranger', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const id = await lobby(a);
    await api('post', `/rooms/${id}/join`, b);
    await api('delete', '/sessions/current', b);
    const row = rowsOf((await api('get', '/users/bob@UPROUGH/profile.txt', a)).text)[0];
    expect([row[3], row[8], row[7], row[9]]).toEqual(['offline', '0', '', '']);
    expect(Number(row[5])).toBeGreaterThan(0);
    expect((await api('get', '/users/nobody@UPROUGH/profile.txt', a)).status).toBe(404);
    expect((await api('get', '/users/notanidentity/profile.txt', a)).status).toBe(400);
  });
});

describe('ignore list', () => {
  it('adds, lists, dedupes and removes per identity, across sessions', async () => {
    const a = await login('alice');
    expect((await api('post', '/ignores', a).send({ user: 'zed@FRIEND' })).status).toBe(201);
    expect((await api('post', '/ignores', a).send({ user: 'zed@FRIEND' })).status).toBe(201);
    const list = await api('get', '/ignores.txt', a);
    expect(list.text.startsWith('IGNORES|1|')).toBe(true);
    expect(rowsOf(list.text).map((r) => r[0])).toEqual(['zed@FRIEND']);

    const a2 = await login('alice');
    expect(rowsOf((await api('get', '/ignores.txt', a2)).text)).toHaveLength(1);
    const b = await login('bob');
    expect(rowsOf((await api('get', '/ignores.txt', b)).text)).toHaveLength(0);

    expect((await api('delete', '/ignores/zed@FRIEND', a)).status).toBe(200);
    expect(rowsOf((await api('get', '/ignores.txt', a)).text)).toHaveLength(0);
  });

  it('refuses self, a non-identity and a missing session', async () => {
    const a = await login('alice');
    expect((await api('post', '/ignores', a).send({ user: 'alice@UPROUGH' })).status).toBe(400);
    expect((await api('post', '/ignores', a).send({ user: 'zed' })).status).toBe(400);
    expect((await api('get', '/ignores.txt')).status).toBe(401);
  });
});
