/**
 * AC-9 - POST /events: validation, idempotency, clamping, counters.
 *
 * SYM-5, SYM-6, SYM-7 and SYM-8 MOVED HERE from the RED file, adapted to a
 * world that now has players and links: every event here is for a caller
 * who registered, verified and linked this board the way a real one does,
 * over HTTP. What is asserted is COUNTERS, never unlocks - AC-10 puts the
 * rule engine behind this same endpoint.
 *
 * `notLinked` on a 200 carries addresses by contract (the board arms its
 * linking explanation for exactly those callers), so this suite has no
 * "no @ in any body" guard; the link and player suites keep theirs.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { defineAchievement, makeAchievementsFixture, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

// Scrypt and a thousand requests under eight parallel workers: five
// seconds is a load-dependent limit, not a correctness one.
jest.setTimeout(60000);

let fx: AchievementsFixture;
let db: Database.Database;

beforeEach(() => {
  fx = makeAchievementsFixture();
  db = fx.openAchievements();
  defineAchievement(db, { id: 'msg.post.100', rule: { op: 'count', type: 'msg.post', n: 100 } });
  defineAchievement(db, { id: 'presence.streak.7', rule: { op: 'streak', type: 'presence.call', unit: 'day', n: 7 } });
  defineAchievement(db, { id: 'file.upload.100', rule: { op: 'count', type: 'file.upload', n: 100 } });
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

async function post(path: string, body: unknown): Promise<Response> {
  return request(fx.app).post(`/achievements/v1${path}`).set('Authorization', fx.auth).send(body as object);
}

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
function codeFromLatestMail(): string {
  const mail = db.prepare('SELECT body FROM mail_queue ORDER BY id DESC LIMIT 1').get() as { body: string };
  return mail.body.split('\n').filter((l) => CODE.test(l))[0];
}

/** Register, verify and link: a caller this board may report for. */
async function linkedPlayer(email: string, handle: string): Promise<void> {
  expect((await post('/players', { email, handle })).status).toBe(202);
  const verify = await post('/players/verify', { email, code: codeFromLatestMail() });
  expect(verify.status).toBe(200);
  expect((await post('/links', { email, code: verify.body.linkCode })).status).toBe(200);
}

let seq = 0;
const ref = (): string => `${TEST_BOARD_ID}:01J8Z${String(++seq).padStart(21, '0')}`;
const NOW_ISO = (): string => new Date().toISOString();

const event = (email: string, type: string, extra: Record<string, unknown> = {}) => ({
  ref: ref(),
  email,
  type,
  at: NOW_ISO(),
  ...extra,
});

const counter = (type: string, key = ''): { n: number; sum_value: number } | undefined =>
  db.prepare('SELECT n, sum_value FROM counters WHERE player_id = 1 AND type = ? AND key = ?').get(type, key) as
    | { n: number; sum_value: number }
    | undefined;

/** The board's events - not the meta.link the link itself appended. */
const eventRows = (): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type NOT LIKE 'meta.%'`).get() as { n: number }).n;

describe('POST /events', () => {
  it('SYM-6: the same ref sent twice counts once', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const e = event('caller@example.com', 'msg.post');

    const first = await post('/events', { events: [e] });
    const second = await post('/events', { events: [e] });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ accepted: 1, duplicates: 0, rejected: [], notLinked: [], unlocks: [] });
    // One message toward Century: the engine (AC-10) reports the distance.
    expect(first.body.progress).toEqual([{ id: 'msg.post.100', have: 1, need: 100 }]);
    // The primary key (board_id, ref) is the whole idempotency story: a
    // resend is a duplicate by construction and folds nothing.
    expect(second.body).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(counter('msg.post')).toEqual({ n: 1, sum_value: 1 });
    expect(eventRows()).toBe(1);
  });

  it('SYM-7: an event stamped a year in the future is clamped to now and recorded as clamped', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const e = event('caller@example.com', 'presence.call', { at: nextYear });

    const res = await post('/events', { events: [e] });

    expect(res.status).toBe(200);
    const row = db.prepare('SELECT at, received_at, clamped FROM events WHERE ref = ?').get(e.ref) as {
      at: number;
      received_at: number;
      clamped: number;
    };
    expect(row.clamped).toBe(1);
    expect(row.at).toBe(row.received_at);
    // The streak day is the clamped day, not next year's.
    const day = db.prepare('SELECT day FROM counter_days WHERE player_id = 1').get() as { day: string };
    expect(day.day).toBe(new Date(row.at * 1000).toISOString().slice(0, 10));
  });

  it('an event stamped forty days ago is clamped; one stamped twenty days ago is not', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString();
    const forty = event('caller@example.com', 'msg.post', { at: daysAgo(40) });
    const twenty = event('caller@example.com', 'msg.post', { at: daysAgo(20) });

    const res = await post('/events', { events: [forty, twenty] });

    expect(res.body).toMatchObject({ accepted: 2 });
    const rows = db.prepare('SELECT ref, clamped, at, received_at FROM events ORDER BY ref').all() as {
      ref: string;
      clamped: number;
      at: number;
      received_at: number;
    }[];
    const f = rows.find((r) => r.ref === forty.ref) as (typeof rows)[number];
    const t = rows.find((r) => r.ref === twenty.ref) as (typeof rows)[number];
    expect(f.clamped).toBe(1);
    expect(f.at).toBe(f.received_at);
    expect(t.clamped).toBe(0);
    expect(t.received_at - t.at).toBeGreaterThan(19 * 24 * 3600);
  });

  it('a batch of 101 is refused and none of the 101 is stored', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const events = Array.from({ length: 101 }, () => event('caller@example.com', 'msg.post'));

    const res = await post('/events', { events });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('batch_too_large');
    expect(eventRows()).toBe(0);
    expect(counter('msg.post')).toBeUndefined();
  });

  it('SYM-8: a batch containing meta.unlock is refused whole', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const good = event('caller@example.com', 'msg.post');
    const forged = event('caller@example.com', 'meta.unlock', { key: 'msg.post.100' });

    const res = await post('/events', { events: [good, forged] });

    // An attack signal, not a typo: nothing about it is per-event, and the
    // good event in front of it is not stored either.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('meta_type_rejected');
    expect(eventRows()).toBe(0);
  });

  it('one unlinked player in a batch does not stop the other ninety-nine', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const events = Array.from({ length: 99 }, () => event('caller@example.com', 'msg.post'));
    const stranger = event('stranger@example.com', 'msg.post');
    events.splice(50, 0, stranger);

    const res = await post('/events', { events });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 99, duplicates: 0 });
    expect(res.body.rejected).toEqual([{ ref: stranger.ref, reason: 'unknown_player' }]);
    expect(counter('msg.post')).toEqual({ n: 99, sum_value: 99 });
  });

  it('SYM-5: a batch entirely for unlinked players answers 403 not_linked', async () => {
    // Registered and verified, but never linked THIS board.
    expect((await post('/players', { email: 'caller@example.com', handle: 'Caller' })).status).toBe(202);
    expect((await post('/players/verify', { email: 'caller@example.com', code: codeFromLatestMail() })).status).toBe(200);

    const res = await post('/events', { events: [event('caller@example.com', 'msg.post')] });

    // The single-player case the 68K door always sends: the door explains linking.
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_linked');
    expect(eventRows()).toBe(0);

    // The same address in a MIXED batch is per-event, and named once.
    await linkedPlayer('other@example.com', 'Other');
    const mixed = await post('/events', {
      events: [event('other@example.com', 'msg.post'), event('caller@example.com', 'msg.post'), event('caller@example.com', 'msg.post')],
    });
    expect(mixed.status).toBe(200);
    expect(mixed.body.accepted).toBe(1);
    expect(mixed.body.rejected.map((r: { reason: string }) => r.reason)).toEqual(['not_linked', 'not_linked']);
    expect(mixed.body.notLinked).toEqual(['caller@example.com']);
  });

  it('an unknown event type is rejected per event, and the response names the ref', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const known = event('caller@example.com', 'msg.post');
    const unknown = event('caller@example.com', 'msg.frobnicate');

    const res = await post('/events', { events: [known, unknown] });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected).toEqual([{ ref: unknown.ref, reason: 'unknown_event_type' }]);
    expect(eventRows()).toBe(1);
  });

  it('a lower stat.snapshot after a higher one does not reduce the counter', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const snap = (value: number) => ({
      ref: `${TEST_BOARD_ID}:caller@example.com:stat:file.upload:${value}`,
      email: 'caller@example.com',
      type: 'stat.snapshot',
      at: NOW_ISO(),
      key: 'file.upload',
      value,
    });

    expect((await post('/events', { events: [snap(137)] })).body).toMatchObject({ accepted: 1 });
    expect((await post('/events', { events: [snap(90)] })).body).toMatchObject({ accepted: 1 });
    // The same counter, re-sent unchanged: a duplicate by ref.
    expect((await post('/events', { events: [snap(137)] })).body).toMatchObject({ accepted: 0, duplicates: 1 });

    const row = db.prepare('SELECT value FROM snapshots WHERE player_id = 1 AND name = ?').get('file.upload') as { value: number };
    expect(row.value).toBe(137);
    // And a snapshot feeds no counter: count reads max(n, snapshot) instead.
    expect(counter('file.upload')).toBeUndefined();
    expect(counter('stat.snapshot')).toBeUndefined();
  });

  it('a stat.snapshot naming a type no achievement uses is rejected', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const e = {
      ref: `${TEST_BOARD_ID}:caller@example.com:stat:msg.frobnicate:5`,
      email: 'caller@example.com',
      type: 'stat.snapshot',
      at: NOW_ISO(),
      key: 'msg.frobnicate',
      value: 5,
    };

    const res = await post('/events', { events: [e] });

    expect(res.status).toBe(200);
    expect(res.body.rejected).toEqual([{ ref: e.ref, reason: 'unknown_event_type' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()).toEqual({ n: 0 });
  });

  it('a failed event batch leaves no counter half-folded', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    // The storage fails on the SECOND row - a trigger standing in for a
    // full disk or a broken index - after the first was inserted and folded.
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON events WHEN NEW.ref LIKE '%:boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const first = event('caller@example.com', 'msg.post');
    const second = { ...event('caller@example.com', 'msg.post'), ref: `${TEST_BOARD_ID}:boom` };

    const res = await post('/events', { events: [first, second] });

    expect(res.status).toBe(500);
    expect(eventRows()).toBe(0);
    expect(counter('msg.post')).toBeUndefined();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM board_audit WHERE action = 'events'`).get()).toEqual({ n: 0 });
  });

  it('every accepted event lands in the counters a rule will read: keyed, per board, per day', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const res = await post('/events', {
      events: [
        event('caller@example.com', 'msg.post', { key: 'conf:2', value: 3 }),
        event('caller@example.com', 'msg.post', { key: 'conf:5' }),
      ],
    });

    expect(res.body.accepted).toBe(2);
    expect(counter('msg.post')).toEqual({ n: 2, sum_value: 4 });
    expect(counter('msg.post', 'conf:2')).toEqual({ n: 1, sum_value: 3 });
    const dims = db
      .prepare(`SELECT dim, grp, dim_value FROM counter_dims WHERE player_id = 1 AND type = 'msg.post' ORDER BY dim, grp, dim_value`)
      .all();
    expect(dims).toEqual([
      { dim: 'board', grp: '', dim_value: TEST_BOARD_ID },
      { dim: 'board', grp: 'conf:2', dim_value: TEST_BOARD_ID },
      { dim: 'board', grp: 'conf:5', dim_value: TEST_BOARD_ID },
      { dim: 'key', grp: '', dim_value: 'conf:2' },
      { dim: 'key', grp: '', dim_value: 'conf:5' },
      { dim: 'key', grp: 'conf:2', dim_value: 'conf:2' },
      { dim: 'key', grp: 'conf:5', dim_value: 'conf:5' },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM counter_days WHERE type = 'msg.post'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT action, count FROM board_audit WHERE action = 'events'`).get()).toEqual({ action: 'events', count: 2 });
  });
});
