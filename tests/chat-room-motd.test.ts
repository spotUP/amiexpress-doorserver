/**
 * Per-room message of the day (the TS LiveChat door's /motd): the room owner or
 * a moderator sets it, a plain member is refused, members hear `room_motd`,
 * the join reply carries it, and an empty body clears it. Driven through the
 * real PUT /chat/v1/rooms/:id/motd, POST /rooms/:id/join and GET /events.txt.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string, sysop: boolean): Promise<string> {
  return (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop })).body.sid as string;
}
const call = (method: 'get' | 'post' | 'put', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

async function motdRows(sid: string): Promise<string[][]> {
  const r = await call('get', '/events.txt?since=0&wait=0', sid);
  expect(r.status).toBe(200);
  return r.text.split('\r\n').filter((l) => l !== '').slice(1).map((l) => l.split('|')).filter((c) => c[1] === 'room_motd');
}

describe('room motd', () => {
  it('owner sets it, members hear it, join carries it, a plain member is refused, empty clears', async () => {
    const owner = await login('sys', true);
    const room = await call('post', '/rooms', owner).send({ name: 'lobby' });
    expect(room.status).toBe(201);
    const id = room.body.id as string;
    const bob = await login('bob', false);
    const first = await call('post', `/rooms/${id}/join`, bob);
    expect(first.status).toBe(200);
    expect(first.body.motd).toBe('');

    expect((await call('put', `/rooms/${id}/motd`, bob).send({ motd: 'nope' })).status).toBe(403);
    expect((await call('put', `/rooms/${id}/motd`, owner).send({ motd: 'Welcome to the lobby' })).status).toBe(200);

    const rows = await motdRows(bob);
    expect(rows).toHaveLength(1);
    // seq|type|room|user|ref|at|roleColor|text|replyTo
    expect(rows[0][2]).toBe(id);
    expect(rows[0][7]).toBe('Welcome to the lobby');

    const again = await call('post', `/rooms/${id}/join`, bob);
    expect(again.body.motd).toBe('Welcome to the lobby');

    expect((await call('put', `/rooms/${id}/motd`, owner).send({ motd: 'x'.repeat(501) })).status).toBe(400);
    expect((await call('put', `/rooms/${id}/motd`, owner).send({ motd: '' })).status).toBe(200);
    const cleared = await motdRows(bob);
    expect(cleared).toHaveLength(2);
    expect(cleared[1][7]).toBe('');
    expect((await call('post', `/rooms/${id}/join`, bob)).body.motd).toBe('');
  });
});
