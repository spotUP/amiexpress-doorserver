/**
 * AC-1 - RED. Eleven symptoms, named the way a board author would name them.
 *
 * No production code exists for any of these yet, and that is the point:
 * every test here FAILS on arrival, and each one names a user-visible
 * symptom rather than a function. As the tasks that own them turn them
 * GREEN, each test MOVES (not copies) into that task's own suite - AC-4
 * takes SYM-2 and SYM-3, AC-5 takes SYM-1, AC-7 takes SYM-4, AC-8 takes
 * SYM-5, AC-9 takes SYM-6/7/8, AC-12 takes SYM-9, AC-13 takes SYM-10 and
 * AC-15 takes SYM-11 - and AC-20's ledger records which task closed which.
 *
 * MOVED OUT SO FAR: SYM-2 and SYM-3 now live in
 * tests/achievements/boards.test.ts, where they are GREEN (AC-4); SYM-4 now
 * lives in tests/achievements/players.test.ts, GREEN (AC-7).
 *
 * SYM-5, SYM-6, SYM-7 and SYM-8 now live in tests/achievements/events.test.ts,
 * GREEN (AC-9), adapted to a world with players and links: the RED versions
 * posted for an address nobody had registered, which AC-9 rejects before it
 * ever reaches the behaviour they were written to catch.
 *
 * SYM-1 CLOSED BY AC-9: it asked for POST /events to exist behind the
 * mounted surface. AC-5 delivered the mount and its headers
 * (tests/achievements/mount.test.ts); AC-9 delivered the endpoint, and every
 * test in tests/achievements/events.test.ts drives it.
 *
 * Every test drives the REAL app: `createApp(cfg)` over HTTP through
 * supertest, exactly as tests/routes.test.ts does. Never a router, never a
 * handler, never a function in isolation. A test that passes here is
 * mis-specified and is rewritten before AC-2 starts.
 */
import request from 'supertest';
import { makeAchievementsFixture, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

let fx: AchievementsFixture;

beforeEach(() => {
  fx = makeAchievementsFixture();
});

afterEach(() => fx.cleanup());

describe('the achievements surface, as a board author meets it', () => {
  it('SYM-9: catalog.txt comes back as UTF-8 with LF line endings', async () => {
    const res = await request(fx.app)
      .get('/achievements/v1/catalog.txt')
      .set('Authorization', fx.auth)
      .buffer(true);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=ISO-8859-1');
    const text = Buffer.from(res.body).toString('latin1');
    expect(text.startsWith('ACHIEVE|1|')).toBe(true);
    // CRLF throughout, including after the last row - a 68K line reader
    // depends on it.
    expect(text).toContain('\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('SYM-10: a door redefines a published achievement id and the old definition is lost', async () => {
    const push = (name: string) =>
      request(fx.app)
        .put('/achievements/v1/catalog/doors/grandmaster')
        .set('Authorization', fx.auth)
        .send({
          digest: name,
          achievements: [
            {
              id: 'door.grandmaster.first_win',
              name,
              description: 'Win a game of chess',
              family: 'door',
              tier: 'bronze',
              points: 5,
              hidden: false,
              rule: { op: 'count', type: 'door.grandmaster.win', n: 1 },
            },
          ],
        });

    const first = await push('First Blood');
    const second = await push('First Kill');

    expect(first.status).toBe(200);
    // A published id is immutable, and the digest covers the name and the
    // description as well as the rule (D8).
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('definition_changed');

    const catalog = await request(fx.app)
      .get('/achievements/v1/catalog')
      .set('Authorization', fx.auth);
    const published = (catalog.body.achievements as { id: string; name: string }[]).find(
      (a) => a.id === 'door.grandmaster.first_win'
    );
    expect(published?.name).toBe('First Blood');
  });

  it('SYM-11: a private player appears in the global leaderboard', async () => {
    const db = fx.openAchievements();
    try {
      db.prepare(
        `INSERT INTO players (email_key, email, handle, verified_at, private, created_at)
         VALUES ('hermit@example.com', 'hermit@example.com', 'Hermit', 1700000000, 1, 1700000000)`
      ).run();
      db.prepare(
        `INSERT INTO players (email_key, email, handle, verified_at, private, created_at)
         VALUES ('loud@example.com', 'loud@example.com', 'Loud', 1700000000, 0, 1700000000)`
      ).run();
    } finally {
      db.close();
    }

    const res = await request(fx.app)
      .get('/achievements/v1/leaderboard?scope=global')
      .set('Authorization', fx.auth);

    expect(res.status).toBe(200);
    const handles = (res.body.rows as { handle: string }[]).map((r) => r.handle);
    // Private is a GLOBAL opt-out only: the board they are linked to still
    // lists them, because that board's caller list is its sysop's own data.
    expect(handles).not.toContain('Hermit');
  });
});
