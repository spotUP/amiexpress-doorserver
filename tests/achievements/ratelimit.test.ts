/**
 * AC-17 - rate limits, on the write API only.
 *
 * The read paths are named one by one in the two "never" tests. The clock
 * is injected through _resetRateLimitsForTests so a window can pass
 * without waiting a minute.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { LIMITS, _resetRateLimitsForTests } from '../../src/achievements/ratelimit';
import { defineAchievement, makeAchievementsFixture, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

// Scrypt and a thousand requests under eight parallel workers: five
// seconds is a load-dependent limit, not a correctness one.
jest.setTimeout(180000);

let fx: AchievementsFixture;
let db: Database.Database;
let now = 1800000000;

beforeEach(() => {
  fx = makeAchievementsFixture();
  db = fx.openAchievements();
  now = 1800000000;
  _resetRateLimitsForTests(() => now);
  defineAchievement(db, { id: 'msg.post.1', rule: { op: 'count', type: 'msg.post', n: 1 } });
});

afterEach(() => {
  db.close();
  fx.cleanup();
  _resetRateLimitsForTests();
});

const post = (path: string, body: unknown): Promise<Response> =>
  request(fx.app).post(`/achievements/v1${path}`).set('Authorization', fx.auth).send(body as object);
const get = (path: string): Promise<Response> => request(fx.app).get(`/achievements/v1${path}`).set('Authorization', fx.auth);

let seq = 0;
const batch = (email = 'caller@example.com') => ({
  events: [{ ref: `${TEST_BOARD_ID}:r${++seq}`, email, type: 'msg.post', at: new Date().toISOString() }],
});

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
async function linkedPlayer(email: string, handle: string): Promise<void> {
  await post('/players', { email, handle });
  const mail = db.prepare('SELECT body FROM mail_queue ORDER BY id DESC LIMIT 1').get() as { body: string };
  const verify = await post('/players/verify', { email, code: mail.body.split('\n').filter((l) => CODE.test(l))[0] });
  await post('/links', { email, code: verify.body.linkCode });
}

describe('rate limits', () => {
  it('a board over the event rate gets 429 with a Retry-After in seconds', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    now += 10;
    for (let i = 0; i < LIMITS.eventsPerBoard.max; i += 1) expect((await post('/events', batch())).status).toBe(200);

    const over = await post('/events', batch());

    expect(over.status).toBe(429);
    expect(over.body.error).toBe('rate_limited');
    // The window opened at the first event post, a full minute ago from its
    // own point of view: the clock has not moved since.
    expect(over.headers['retry-after']).toBe('60');
    expect(over.body.retryAfter).toBe(60);
  });

  it('the next window lets the same board through again', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    now += 10;
    for (let i = 0; i < LIMITS.eventsPerBoard.max; i += 1) await post('/events', batch());
    expect((await post('/events', batch())).status).toBe(429);

    now += LIMITS.eventsPerBoard.windowSeconds;

    expect((await post('/events', batch())).status).toBe(200);
  });

  it("a fourth registration mail for one address in an hour is refused; the board's other players are unaffected", async () => {
    for (let i = 0; i < LIMITS.registerPerEmail.max; i += 1) {
      expect((await post('/players', { email: 'hammer@example.com', handle: 'Hammer' })).status).toBe(202);
    }
    const fourth = await post('/players', { email: 'hammer@example.com', handle: 'Hammer' });
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThan(0);
    // Resend shares the mail budget - it is the abusable half.
    expect((await post('/players/resend', { email: 'HAMMER@example.com' })).status).toBe(429);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mail_queue').get()).toEqual({ n: 3 });

    expect((await post('/players', { email: 'other@example.com', handle: 'Other' })).status).toBe(202);
    // The board's own budget counts REQUESTS, refused ones included: six so
    // far (three hammers, the refused fourth, the refused resend, other),
    // so four more fit and the eleventh is refused.
    for (let i = 0; i < LIMITS.registerPerBoard.max - 6; i += 1) {
      expect((await post('/players', { email: `p${i}@example.com`, handle: `Player${i}` })).status).toBe(202);
    }
    expect((await post('/players', { email: 'last@example.com', handle: 'Last' })).status).toBe(429);
  });

  it('reading the catalog a thousand times is never rate limited', async () => {
    for (let i = 0; i < 1000; i += 1) {
      const res = await get(i % 2 === 0 ? '/catalog' : '/catalog.txt');
      expect(res.status).toBe(200);
    }
    expect((await get('/health')).status).toBe(200);
  });

  it('reading the leaderboard a thousand times is never rate limited', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    for (let i = 0; i < 1000; i += 1) {
      const res = await get(i % 2 === 0 ? '/leaderboard?scope=global' : `/leaderboard.txt?scope=board:${TEST_BOARD_ID}`);
      expect(res.status).toBe(200);
    }
    expect((await get('/players/caller%40example.com')).status).toBe(200);
  });

  it('a 429 stores no events', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    now += 10;
    for (let i = 0; i < LIMITS.eventsPerBoard.max; i += 1) await post('/events', batch());
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'msg.post'`).get() as { n: number }).n;

    const over = await post('/events', batch());

    expect(over.status).toBe(429);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'msg.post'`).get()).toEqual({ n: before });
    // The per-player row budget is charged by email, not by batch shape.
    _resetRateLimitsForTests(() => now);
    const big = { events: Array.from({ length: 100 }, () => batch().events[0]) };
    for (let i = 0; i < 6; i += 1) expect((await post('/events', big)).status).toBe(200);
    expect((await post('/events', batch())).status).toBe(429);
  });
});
