/** Timed mute: refuses posts while running, then the sweeper unmutes and emits `unmuted` (ref system). */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests, sweepMutes } from '../src/chat/sessions';
import { withAchievementsDb } from '../src/achievements/db';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string, sysop: boolean): Promise<string> {
  return (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop })).body.sid as string;
}
const call = (method: 'get' | 'post', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

describe('timed mute expiry', () => {
  it('refuses while muted, sweeper lifts it once and emits unmuted', async () => {
    const owner = await login('sys', true);
    const id = (await call('post', '/rooms', owner).send({ name: 'lobby' })).body.id as string;
    const bob = await login('bob', false);
    await call('post', `/rooms/${id}/join`, bob);
    expect((await call('post', `/rooms/${id}/mute`, owner).send({ user: 'bob@uprough', minutes: 1 })).status).toBe(200);
    expect((await call('post', `/rooms/${id}/messages`, bob).send({ content: 'hi', clientId: 'c' + Math.random() })).status).toBe(403);

    withAchievementsDb(fx.ach, (db) => {
      expect(sweepMutes(db)).toBe(0);
      db.prepare('UPDATE chat_mutes SET until = until - 120').run();
      expect(sweepMutes(db)).toBe(1);
      expect(sweepMutes(db)).toBe(0);
    });
    expect((await call('post', `/rooms/${id}/messages`, bob).send({ content: 'hi', clientId: 'c' + Math.random() })).status).toBe(201);
    const rows = (await call('get', '/events.txt?since=0&wait=0', bob)).text.split('\r\n').map((l) => l.split('|')).filter((c) => c[1] === 'unmuted');
    expect(rows).toHaveLength(1);
  });
});
