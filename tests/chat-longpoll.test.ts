/** The events long poll: wakes on a post, times out empty, holds no DB handle. */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { heldPollCount } from '../src/chat/events';
import { _resetRateLimitsForTests } from '../src/achievements/ratelimit';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string): Promise<string> {
  return (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle })).body.sid as string;
}
const call = (method: 'get' | 'post', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

describe('chat long poll', () => {
  it('returns empty after the wait with Content-Length', async () => {
    const sid = await login('alice');
    const r = await call('get', '/events.txt?wait=1', sid);
    expect(r.status).toBe(200);
    expect(r.headers['content-length']).toBeDefined();
    expect(r.text.startsWith('EVENTS|')).toBe(true);
    expect(heldPollCount()).toBe(0);
  });

  it('wakes on a message from another session', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const id = (await call('post', '/rooms', a).send({ name: 'lobby' })).body.id as string;
    await call('post', `/rooms/${id}/join`, a);
    await call('post', `/rooms/${id}/join`, b);
    const started = Date.now();
    const held = call('get', '/events.txt?wait=20', b).then((r) => r);
    await new Promise((res) => setTimeout(res, 300));
    await call('post', `/rooms/${id}/messages`, a).send({ content: 'wake up', clientId: 'x1' });
    const r = await held;
    expect(Date.now() - started).toBeLessThan(10000);
    expect(r.text).toContain('wake up');
  });

  it('carries replyTo, then the label, as the last fields of a message event', async () => {
    const a = await login('alice');
    const id = (await call('post', '/rooms', a).send({ name: 'lobby' })).body.id as string;
    await call('post', `/rooms/${id}/join`, a);
    const parent = (await call('post', `/rooms/${id}/messages`, a).send({ content: 'first', clientId: 'p1' })).body.id as string;
    const since = (await call('get', '/events.txt?wait=0', a)).text.split('|')[2];
    await call('post', `/rooms/${id}/messages`, a).send({ content: 'answer', clientId: 'p2', replyTo: parent });
    const r = await call('get', `/events.txt?since=${since}&wait=0`, a);
    const row = r.text.split(/\r?\n/).find((l) => l.includes('|message|'));
    expect(row?.split('|').slice(7)).toEqual(['answer', parent, 'alice']);
  });
  it('never sends more than maxBytes of events, however many canvas events wait', async () => {
    const a = await login('alice');
    const id = (await call('post', '/rooms', a).send({ name: 'bulk', kind: 'art' })).body.id as string;
    await call('post', `/rooms/${id}/join`, a);
    for (let i = 0; i < 200; i++) {
      if (i % 30 === 0) _resetRateLimitsForTests();
      await call('post', `/rooms/${id}/canvas`, a).send({ ops: Array.from({ length: 6 }, (_, y) => `@0,${y}:${'x'.repeat(70)}`).join('') });
    }
    const r = await call('get', '/events.txt?since=0&wait=0&maxBytes=7680', a);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(7680);
    expect(r.text).toContain('|canvas|');
  }, 60000);
});
