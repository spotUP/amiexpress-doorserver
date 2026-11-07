/** Roles: a sysop manages their board's roles; a plain user cannot. */
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
const call = (method: 'get' | 'post' | 'put' | 'delete', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

describe('chat roles', () => {
  it('refuses a plain user', async () => {
    const u = await login('bob', false);
    expect((await call('post', '/roles', u).send({ name: 'Mod', colorHex: '#ff0000', colorAnsi: 9 })).status).toBe(403);
  });

  it('sysop creates, lists, assigns and deletes a role', async () => {
    const s = await login('sys', true);
    const made = await call('post', '/roles', s).send({ name: 'Mod', colorHex: '#ff0000', colorAnsi: 9 });
    expect(made.status).toBe(201);
    const list = await call('get', '/roles', s);
    expect(JSON.stringify(list.body)).toContain('Mod');
    const asg = await call('put', '/roles/assignments/bob', s).send({ roleIds: [made.body.id] });
    expect(asg.status).toBe(200);
    expect((await call('delete', `/roles/${made.body.id}`, s)).status).toBe(200);
  });
});
