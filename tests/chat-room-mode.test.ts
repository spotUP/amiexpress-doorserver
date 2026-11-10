/**
 * Room modes (the TS LiveChat door's /mode): staff only; +i makes the room
 * private, +m silences all but staff and voiced users, +o/+v/+b take a user;
 * a bad flag is reported and skipped; members hear one `mode` event with what
 * was applied. Driven through the real POST /chat/v1/rooms/:id/mode,
 * POST /rooms/:id/messages, GET /rooms and GET /events.txt.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string, sysop: boolean): Promise<{ sid: string; user: string }> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop });
  return { sid: r.body.sid as string, user: r.body.user as string };
}
const call = (method: 'get' | 'post' | 'put', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);
let n = 0;
const say = (id: string, sid: string, content: string) => call('post', `/rooms/${id}/messages`, sid).send({ content, clientId: `c${++n}` });

describe('room modes', () => {
  it('applies i/m/o/v/b, enforces +m, reports bad flags, emits one mode event', async () => {
    const owner = await login('sys', true);
    const id = (await call('post', '/rooms', owner.sid).send({ name: 'modes' })).body.id as string;
    expect((await call('post', `/rooms/${id}/join`, owner.sid)).status).toBe(200);
    const bob = await login('bob', false);
    const carl = await login('carl', false);
    expect((await call('post', `/rooms/${id}/join`, bob.sid)).status).toBe(200);
    expect((await call('post', `/rooms/${id}/join`, carl.sid)).status).toBe(200);

    const refused = await call('post', `/rooms/${id}/mode`, bob.sid).send({ modes: '+m' });
    expect(refused.status).toBe(403);
    expect(refused.body.message ?? refused.body.error).toBeDefined();
    expect((await call('post', `/rooms/${id}/mode`, owner.sid).send({ modes: 'm' })).status).toBe(400);

    const r = await call('post', `/rooms/${id}/mode`, owner.sid).send({ modes: '+mvxo', params: `${bob.user} nobody` });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(`+m +v ${bob.user}`);
    expect(r.body.errors).toBe('Unknown mode flag: x|User nobody not found');

    expect((await say(id, bob.sid, 'voiced')).status).toBe(201);
    const silent = await say(id, carl.sid, 'not voiced');
    expect(silent.status).toBe(403);
    expect(silent.body.error).toBe('moderated');
    expect((await say(id, owner.sid, 'staff')).status).toBe(201);

    expect((await call('post', `/rooms/${id}/mode`, owner.sid).send({ modes: '+o', params: carl.user })).body.applied).toBe(`+o ${carl.user}`);
    expect((await say(id, carl.sid, 'now op')).status).toBe(201);
    expect((await call('post', `/rooms/${id}/mode`, carl.sid).send({ modes: '-m+b', params: bob.user })).body.applied).toBe(`-m +b ${bob.user}`);
    expect((await say(id, bob.sid, 'muted')).body.error).toBe('muted');
    expect((await call('post', `/rooms/${id}/mode`, carl.sid).send({ modes: '-b', params: bob.user })).status).toBe(200);
    expect((await say(id, bob.sid, 'back')).status).toBe(201);
    expect((await call('post', `/rooms/${id}/mode`, owner.sid).send({ modes: '+b', params: owner.user })).body.errors).toContain('the room owner cannot be moderated');

    expect((await call('post', `/rooms/${id}/mode`, owner.sid).send({ modes: '+i' })).body.applied).toBe('+i');
    const dave = await login('dave', false);
    expect((await call('post', `/rooms/${id}/join`, dave.sid)).status).toBe(403);
    await call('post', `/rooms/${id}/mode`, owner.sid).send({ modes: '-i' });
    expect((await call('post', `/rooms/${id}/join`, dave.sid)).status).toBe(200);

    const ev = await call('get', '/events.txt?since=0&wait=0', bob.sid);
    const modes = ev.text.split('\r\n').map((l) => l.split('|')).filter((c) => c[1] === 'mode');
    expect(modes[0][7]).toBe(`+m +v ${bob.user}`);
    expect(modes.length).toBeGreaterThanOrEqual(4);
  });
});
