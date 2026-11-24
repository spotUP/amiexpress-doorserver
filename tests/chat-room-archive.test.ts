/**
 * Archive Channel (LiveChat's sysop room action): POST /rooms/:id/archive hides
 * the room from every list and refuses joins, keeps its messages in the DB,
 * tells members `room_deleted` with ref `archived`, and refuses a plain user.
 */
import request from 'supertest';
import Database from 'better-sqlite3';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string, sysop: boolean): Promise<string> {
  return (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop })).body.sid as string;
}
const call = (method: 'get' | 'post', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

describe('room archive', () => {
  it('hides the room, refuses joins, keeps history and tells members', async () => {
    const owner = await login('sys', true);
    const id = (await call('post', '/rooms', owner).send({ name: 'oldtalk' })).body.id as string;
    const bob = await login('bob', false);
    expect((await call('post', `/rooms/${id}/join`, bob)).status).toBe(200);
    expect((await call('post', `/rooms/${id}/messages`, bob).send({ content: 'keep me', clientId: 'k1' })).status).toBeLessThan(300);

    expect((await call('post', `/rooms/${id}/archive`, bob)).status).toBe(403);
    expect((await call('post', `/rooms/${id}/archive`, owner)).status).toBe(200);

    const ev = (await call('get', '/events.txt?since=0&wait=0', bob)).text.split('\r\n').map((l) => l.split('|')).filter((c) => c[1] === 'room_deleted');
    expect(ev).toHaveLength(1);
    expect(ev[0][2]).toBe(id);
    expect(ev[0][4]).toBe('archived');

    const rooms = await call('get', '/rooms.txt', owner);
    expect(rooms.text).not.toContain('oldtalk');
    expect((await call('post', `/rooms/${id}/join`, bob)).status).toBe(404);

    const db = new Database(fx.achievementsDbPath);
    const row = db.prepare('SELECT archived_at FROM chat_rooms WHERE id = ?').get(id) as { archived_at: number | null };
    expect(row.archived_at).not.toBeNull();
    const kept = db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE room_id = ? AND deleted_at IS NULL').get(id) as { n: number };
    expect(kept.n).toBe(1);
    db.close();
  });
});
