/** The `canvas` event: row format, members only. */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { _resetRateLimitsForTests } from '../src/achievements/ratelimit';

let fx: AchievementsFixture;
beforeEach(() => { _resetRateLimitsForTests(); fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); _resetRateLimitsForTests(); });

const call = (method: 'get' | 'post', path: string, sid: string) =>
  request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);
const login = async (handle: string): Promise<{ sid: string; user: string }> => {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle });
  return { sid: r.body.sid as string, user: r.body.user as string };
};

describe('canvas event', () => {
  it('carries ref=rev and the ops, to members only', async () => {
    const own = await login('own');
    const eve = await login('eve');
    const id = (await call('post', '/rooms', own.sid).send({ name: 'ev', kind: 'art' })).body.id as string;
    await call('post', `/rooms/${id}/join`, own.sid);
    await call('post', `/rooms/${id}/canvas`, own.sid).send({ ops: '@1,1:~41' });
    const mine = (await call('get', '/events.txt?since=0&wait=0', own.sid)).text.split('\r\n').map((l) => l.split('|')).filter((c) => c[1] === 'canvas');
    expect(mine).toHaveLength(1);
    expect(mine[0][2]).toBe(id);
    expect(mine[0][4]).toBe('1');
    expect(mine[0][7]).toBe('@1,1:~41');
    const theirs = (await call('get', '/events.txt?since=0&wait=0', eve.sid)).text;
    expect(theirs).not.toContain('|canvas|');
  });
});
