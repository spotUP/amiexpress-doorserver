/** Canvas storage: lazy row, rev counting, last writer wins, FK cascade. */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { _resetRateLimitsForTests } from '../src/achievements/ratelimit';
import { readCell } from '../src/chat/canvas-codec';

let fx: AchievementsFixture;
beforeEach(() => { _resetRateLimitsForTests(); fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); _resetRateLimitsForTests(); });

const call = (method: 'get' | 'post', path: string, sid: string) =>
  request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

async function setup(): Promise<{ sid: string; id: string }> {
  const sid = (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle: 'own' })).body.sid as string;
  const id = (await call('post', '/rooms', sid).send({ name: 'canv', kind: 'art' })).body.id as string;
  await call('post', `/rooms/${id}/join`, sid);
  return { sid, id };
}

describe('chat canvas store', () => {
  it('creates the row lazily, counts rev, and the later post wins per cell', async () => {
    const { sid, id } = await setup();
    const db = fx.openAchievements();
    try {
      const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM chat_canvas WHERE room_id = ?').get(id) as { n: number }).n;
      expect(count()).toBe(0);
      await call('post', `/rooms/${id}/canvas`, sid).send({ ops: '@5,5:^12a' });
      expect(count()).toBe(1);
      await call('post', `/rooms/${id}/canvas`, sid).send({ ops: '@5,5:^34b' });
      const row = db.prepare('SELECT rev, cells FROM chat_canvas WHERE room_id = ?').get(id) as { rev: number; cells: Buffer };
      expect(row.rev).toBe(2);
      expect(readCell(row.cells, 5, 5)).toEqual({ char: String.fromCharCode(0x62), fg: 3, bg: 4, blink: false });
    } finally { db.close(); }
  });

  it('cascades on a hard DELETE of the room row', async () => {
    const { sid, id } = await setup();
    await call('post', `/rooms/${id}/canvas`, sid).send({ ops: '@0,0:a' });
    const db = fx.openAchievements();
    try {
      db.prepare('DELETE FROM chat_rooms WHERE id = ?').run(id);
      expect((db.prepare('SELECT COUNT(*) AS n FROM chat_canvas WHERE room_id = ?').get(id) as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });
});
