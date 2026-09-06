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
 * SYM-1 STAYS HERE THROUGH AC-5, and its reason is written on the test
 * itself: the surface is mounted now, but the endpoint SYM-1 drives is
 * POST /events, which AC-9 writes. AC-5 delivered the half it can honestly
 * deliver - the surface answers as itself, with its own headers, on every
 * response including a 404 - and that half is asserted in
 * tests/achievements/mount.test.ts. Wiring a stub /events to turn a status
 * code green would be scaffolding written for a test, which is the one
 * thing the RED file exists to prevent.
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
  // STILL RED AFTER AC-5, deliberately: the surface IS mounted (the header
  // assertion below now passes), but POST /events does not exist until AC-9,
  // so the router answers its own JSON 404. The remaining gap is an
  // endpoint, not a mount.
  it('SYM-1: a board with a valid key is told 404 by a server that never mounted the surface', async () => {
    const res = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', fx.auth)
      .send({ events: [] });

    // A 404 here is indistinguishable from "this host does not run
    // achievements at all" - the same two-meanings-one-status complaint
    // docs/DOOR-REPO-API.md already makes about the door repo. The surface
    // must ANSWER, whatever it answers.
    expect(res.status).not.toBe(404);
    expect(res.headers['x-achievements-contract']).toBe('1');
  });

  it('SYM-5: a board reports for an email that never linked it and the events land', async () => {
    const res = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', fx.auth)
      .send({
        events: [
          {
            ref: `${TEST_BOARD_ID}:01J8Z0000000000000000001`,
            email: 'stranger@example.com',
            type: 'msg.post',
            at: '2026-09-03T21:14:02Z',
          },
        ],
      });

    // The single-player case the 68K door always sends: every event in the
    // batch is for an unlinked player, so the whole request is 403 and the
    // door explains linking.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_linked');
  });

  it('SYM-6: the same ref sent twice counts twice', async () => {
    const event = {
      ref: `${TEST_BOARD_ID}:01J8Z0000000000000000002`,
      email: 'caller@example.com',
      type: 'msg.post',
      at: '2026-09-03T21:14:02Z',
    };
    const post = () =>
      request(fx.app)
        .post('/achievements/v1/events')
        .set('Authorization', fx.auth)
        .send({ events: [event] });

    const first = await post();
    const second = await post();

    expect(first.body).toMatchObject({ accepted: 1, duplicates: 0 });
    // The primary key (board_id, ref) is the whole idempotency story: a
    // resend is a duplicate by construction, and folds nothing.
    expect(second.body).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('SYM-7: an event stamped next year sets a streak nobody earned', async () => {
    const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const res = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', fx.auth)
      .send({
        events: [
          {
            ref: `${TEST_BOARD_ID}:01J8Z0000000000000000003`,
            email: 'caller@example.com',
            type: 'presence.call',
            at: nextYear,
          },
        ],
      });

    expect(res.status).toBe(200);

    const db = fx.openAchievements();
    try {
      const row = db
        .prepare('SELECT at, received_at, clamped FROM events WHERE ref = ?')
        .get(`${TEST_BOARD_ID}:01J8Z0000000000000000003`) as
        | { at: number; received_at: number; clamped: number }
        | undefined;
      expect(row).toBeDefined();
      // Clamped to the server's own clock, and the clamp is recorded on the
      // row - streaks and windows read the clamped value, nothing reads the
      // raw one.
      expect(row?.clamped).toBe(1);
      expect(row?.at).toBe(row?.received_at);
    } finally {
      db.close();
    }
  });

  it('SYM-8: a board posts meta.unlock and mints itself an achievement', async () => {
    const res = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', fx.auth)
      .send({
        events: [
          {
            ref: `${TEST_BOARD_ID}:01J8Z0000000000000000004`,
            email: 'caller@example.com',
            type: 'meta.unlock',
            key: 'msg.post.100',
            at: '2026-09-03T21:14:02Z',
          },
        ],
      });

    // A meta.* type from a board is an attack signal, not a typo: the whole
    // batch is refused, and nothing about it is per-event.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('meta_type_rejected');
  });

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
