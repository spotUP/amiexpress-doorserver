/**
 * Typing indicators: a member POSTs its whole input buffer to
 * POST /chat/v1/rooms/:id/typing; the hub emits a `typing` event carrying the
 * text. "" clears, non-members are refused, text is trimmed to 200 characters.
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
const call = (method: 'get' | 'post', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

describe('room typing', () => {
  it('emits typing events for members, keeps the latest, clears on "", refuses non-members, trims to 200', async () => {
    const owner = await login('sys', true);
    const id = (await call('post', '/rooms', owner.sid).send({ name: 'typing' })).body.id as string;
    await call('post', `/rooms/${id}/join`, owner.sid);
    const bob = await login('bob', false);
    const eve = await login('eve', false);
    await call('post', `/rooms/${id}/join`, bob.sid);

    expect((await call('post', `/rooms/${id}/typing`, bob.sid).send({ text: 'hello wor' })).status).toBe(200);
    expect((await call('post', `/rooms/${id}/typing`, bob.sid).send({ text: '' })).status).toBe(200);
    expect((await call('post', `/rooms/${id}/typing`, bob.sid).send({ text: 'x'.repeat(500) })).status).toBe(200);
    expect((await call('post', `/rooms/${id}/typing`, eve.sid).send({ text: 'hi' })).status).toBe(403);

    const ev = await call('get', '/events.txt?since=0&wait=0', owner.sid);
    const rows = ev.text.split('\r\n').map((l) => l.split('|')).filter((c) => c[1] === 'typing');
    // Typing is a state: only the latest buffer per user and room stays in the log.
    expect(rows.map((c) => c[7])).toEqual(['x'.repeat(200)]);
    expect(rows[0].join('|')).toContain(bob.user);
  });

});
