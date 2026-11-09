/**
 * Pins carry when the pinned message was posted (messageAt), and search takes a
 * user filter (a bare handle matches on every board, handle@BOARD matches one).
 * The 68K LiveChat pins overlay prints "Sent: <date>" and its search overlay has
 * a username field, both 1:1 with the TS door. Driven through the real routes.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string): Promise<string> {
  return (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop: true })).body.sid as string;
}
const call = (method: 'get' | 'post', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

describe('pins and search filters', () => {
  it('pins report the message time and search filters by user', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const room = (await call('post', '/rooms', a).send({ name: 'lobby' })).body.id as string;
    expect((await call('post', `/rooms/${room}/join`, a).send({})).status).toBe(200);
    expect((await call('post', `/rooms/${room}/join`, b).send({})).status).toBe(200);
    const posted = await call('post', `/rooms/${room}/messages`, a).send({ content: 'hello amiga world', clientId: 'p1' });
    expect(posted.status).toBe(201);
    await call('post', `/rooms/${room}/messages`, b).send({ content: 'amiga forever', clientId: 'p2' });
    const mid = posted.body.id as string;

    expect((await call('post', `/rooms/${room}/pins`, a).send({ messageId: mid })).status).toBe(201);
    const pins = (await call('get', `/rooms/${room}/pins`, a)).body as { messageId: string; messageAt: number; at: number }[];
    expect(pins).toHaveLength(1);
    expect(pins[0].messageId).toBe(mid);
    expect(pins[0].messageAt).toBe(posted.body.at);

    const all = (await call('get', '/search?q=amiga', a)).body as { user: string }[];
    expect(all).toHaveLength(2);
    const bobs = (await call('get', '/search?q=amiga&user=BOB', a)).body as { user: string; content: string }[];
    expect(bobs.map((h) => h.content)).toEqual(['amiga forever']);
    const full = (await call('get', `/search?q=amiga&user=${encodeURIComponent(bobs[0].user)}`, a)).body as unknown[];
    expect(full).toHaveLength(1);
    expect((await call('get', '/search?q=amiga&user=carol', a)).body).toEqual([]);
  });
});
