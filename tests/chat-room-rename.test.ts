/**
 * Room rename: a moderator renames via PUT /chat/v1/rooms/:id/name, a plain member is
 * refused, a duplicate or invalid name is refused, and members hear `room_renamed`.
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

describe('room rename', () => {
  it('moderator renames, member refused, duplicate and invalid refused, event emitted', async () => {
    const owner = await login('sys', true);
    const id = (await call('post', '/rooms', owner).send({ name: 'lobby' })).body.id as string;
    await call('post', '/rooms', owner).send({ name: 'other' });
    const bob = await login('bob', false);
    await call('post', `/rooms/${id}/join`, bob);

    expect((await call('put', `/rooms/${id}/name`, bob).send({ name: 'bobs' })).status).toBe(403);
    expect((await call('put', `/rooms/${id}/name`, owner).send({ name: 'Other' })).status).toBe(409);
    expect((await call('put', `/rooms/${id}/name`, owner).send({ name: 'a|b' })).status).toBe(400);
    expect((await call('put', `/rooms/${id}/name`, owner).send({ name: '' })).status).toBe(400);
    expect((await call('put', `/rooms/${id}/name`, owner).send({ name: 'Hall' })).status).toBe(200);

    const rows = (await call('get', '/events.txt?since=0&wait=0', bob)).text.split('\r\n').filter((l) => l !== '').slice(1).map((l) => l.split('|')).filter((c) => c[1] === 'room_renamed');
    expect(rows).toHaveLength(1);
    expect(rows[0][2]).toBe(id);
    expect(rows[0][7]).toBe('Hall');
    const list = (await call('get', '/rooms', bob)).text;
    expect(list).toContain('Hall');
    expect(list).not.toContain('lobby');
  });
});
