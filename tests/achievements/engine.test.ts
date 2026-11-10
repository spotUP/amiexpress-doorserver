/**
 * AC-10 - the rule engine: eight operators as data, plus the cascade.
 *
 * Every operator gets the three fixtures the spec's testing section
 * demands: one that unlocks, one that nearly does, and a duplicate that
 * must not unlock twice. Every test drives POST /events through the real
 * app; the engine is reached only the way a board reaches it.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { createBoard } from '../../src/achievements/boards';
import { RARITY_FLOOR } from '../../src/achievements/rarity';
import { _lastEvaluatedForTests, MAX_PROGRESS } from '../../src/achievements/engine';
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
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

async function post(path: string, body: unknown, auth = fx.auth): Promise<Response> {
  return request(fx.app).post(`/achievements/v1${path}`).set('Authorization', auth).send(body as object);
}

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
function codeFromLatestMail(): string {
  const mail = db.prepare('SELECT body FROM mail_queue ORDER BY id DESC LIMIT 1').get() as { body: string };
  return mail.body.split('\n').filter((l) => CODE.test(l))[0];
}

/** Register, verify and link this board; returns the next link code. */
async function linkedPlayer(email: string, handle: string): Promise<string> {
  expect((await post('/players', { email, handle })).status).toBe(202);
  const verify = await post('/players/verify', { email, code: codeFromLatestMail() });
  const link = await post('/links', { email, code: verify.body.linkCode });
  expect(link.status).toBe(200);
  return link.body.linkCode as string;
}

let seq = 0;
const ref = (board = TEST_BOARD_ID): string => `${board}:01J8Z${String(++seq).padStart(21, '0')}`;
const secondsAgo = (s: number): string => new Date(Date.now() - s * 1000).toISOString();

interface Extra { key?: string; value?: number; at?: string; board?: string }
const event = (email: string, type: string, extra: Extra = {}) => ({
  ref: ref(extra.board),
  email,
  type,
  at: extra.at ?? new Date().toISOString(),
  ...(extra.key !== undefined ? { key: extra.key } : {}),
  ...(extra.value !== undefined ? { value: extra.value } : {}),
});

/** Post events one batch at a time and return the unlock ids of each. */
async function unlocksOf(events: object[], auth = fx.auth): Promise<string[]> {
  const res = await post('/events', { events }, auth);
  expect(res.status).toBe(200);
  return (res.body.unlocks as { id: string }[]).map((u) => u.id);
}

const many = (email: string, type: string, n: number, extra: Extra = {}): object[] =>
  Array.from({ length: n }, () => event(email, type, extra));

describe('the rule engine', () => {
  it('a hundredth message unlocks Century, ninety-nine does not, and resending the hundredth does not unlock twice', async () => {
    defineAchievement(db, { id: 'msg.post.100', rule: { op: 'count', type: 'msg.post', n: 100 }, name: 'Century', tier: 'silver', points: 10 });
    await linkedPlayer('caller@example.com', 'Caller');

    expect(await unlocksOf(many('caller@example.com', 'msg.post', 99))).toEqual([]);
    const hundredth = event('caller@example.com', 'msg.post');
    const res = await post('/events', { events: [hundredth] });
    expect(res.body.unlocks).toEqual([
      // The floor, not 0: an unlock nothing has recomputed a rarity for is
      // `common` at 1000, the same answer the catalog gives for it. This
      // line pinned 0 until rarity-floor.test.ts showed what a door printed.
      expect.objectContaining({
        id: 'msg.post.100',
        name: 'Century',
        tier: 'silver',
        points: 10,
        hidden: false,
        rarityPctTenths: RARITY_FLOOR.pctTenths,
      }),
    ]);
    expect(typeof res.body.unlocks[0].at).toBe('string');
    // The resend is a duplicate and moves nothing, so nothing is evaluated.
    const again = await post('/events', { events: [hundredth] });
    expect(again.body).toMatchObject({ duplicates: 1, unlocks: [] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM unlocks').get()).toEqual({ n: 1 });
  });

  it('the first upload ever unlocks, and the second upload unlocks nothing', async () => {
    defineAchievement(db, { id: 'file.first', rule: { op: 'first', type: 'file.upload' } });
    await linkedPlayer('caller@example.com', 'Caller');

    expect(await unlocksOf([event('caller@example.com', 'file.upload')])).toEqual(['file.first']);
    expect(await unlocksOf([event('caller@example.com', 'file.upload')])).toEqual([]);
  });

  it('a hundred megabytes uploaded unlocks; ninety-nine does not', async () => {
    defineAchievement(db, { id: 'file.bytes.100m', rule: { op: 'sum', type: 'file.upload', field: 'value', n: 100 * 1024 * 1024 } });
    await linkedPlayer('caller@example.com', 'Caller');

    expect(await unlocksOf([event('caller@example.com', 'file.upload', { value: 99 * 1024 * 1024 })])).toEqual([]);
    expect(await unlocksOf([event('caller@example.com', 'file.upload', { value: 1024 * 1024 })])).toEqual(['file.bytes.100m']);
    expect(await unlocksOf([event('caller@example.com', 'file.upload', { value: 1024 * 1024 })])).toEqual([]);
  });

  it('posting in ten different conferences unlocks; ten posts in one conference does not', async () => {
    defineAchievement(db, { id: 'msg.conf.10', rule: { op: 'distinct', type: 'msg.post', dim: 'key', n: 10 } });
    await linkedPlayer('caller@example.com', 'Caller');

    expect(await unlocksOf(many('caller@example.com', 'msg.post', 10, { key: 'conf:1' }))).toEqual([]);
    const nine = Array.from({ length: 8 }, (_, i) => event('caller@example.com', 'msg.post', { key: `conf:${i + 2}` }));
    expect(await unlocksOf(nine)).toEqual([]);
    expect(await unlocksOf([event('caller@example.com', 'msg.post', { key: 'conf:10' })])).toEqual(['msg.conf.10']);
    expect(await unlocksOf([event('caller@example.com', 'msg.post', { key: 'conf:11' })])).toEqual([]);
  });

  it('earning the same achievement on three boards unlocks; three achievements on one board does not', async () => {
    // The meta rule: meta.unlock, dim board, grouped by key (the achievement id).
    defineAchievement(db, { id: 'boards.same.3', rule: { op: 'distinct', type: 'meta.unlock', dim: 'board', n: 3, group: 'key' } });
    for (const t of ['a', 'b', 'c']) defineAchievement(db, { id: `x.${t}`, rule: { op: 'first', type: `x.${t}` } });
    let code = await linkedPlayer('caller@example.com', 'Caller');
    const boards = ['two', 'three'].map((id) => `Board ${createBoard(db, id, id, null).key}`);
    for (const auth of boards) {
      const link = await post('/links', { email: 'caller@example.com', code }, auth);
      expect(link.status).toBe(200);
      code = link.body.linkCode;
    }

    // Three different achievements on one board: three meta.unlock events,
    // three keys, one board each - the grouped distinct never exceeds one.
    expect(await unlocksOf([event('caller@example.com', 'x.a'), event('caller@example.com', 'x.b'), event('caller@example.com', 'x.c')])).toEqual(['x.a', 'x.b', 'x.c']);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM unlocks WHERE achievement_id = 'boards.same.3'`).get()).toEqual({ n: 0 });

    // The same achievement, earned again from two more boards: x.a is held
    // once, globally, but each board's own events satisfy its rule and the
    // server records that board under meta.unlock - the third one fires
    // the meta award, on the board that completed it.
    expect(await unlocksOf([event('caller@example.com', 'x.a', { board: 'two' })], boards[0])).toEqual([]);
    expect(await unlocksOf([event('caller@example.com', 'x.a', { board: 'three' })], boards[1])).toEqual(['boards.same.3']);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM unlocks WHERE achievement_id = 'x.a'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT board_id FROM unlocks WHERE achievement_id = 'boards.same.3'`).get()).toEqual({ board_id: 'three' });
    // And a fourth board adds nothing new to a rule already satisfied.
    expect(await unlocksOf([event('caller@example.com', 'x.a', { board: 'three' })], boards[1])).toEqual([]);
  });

  it('calling on seven consecutive days unlocks; a gap on day four does not', async () => {
    defineAchievement(db, { id: 'presence.streak.7', rule: { op: 'streak', type: 'presence.call', unit: 'day', n: 7 } });
    await linkedPlayer('gap@example.com', 'Gap');
    await linkedPlayer('run@example.com', 'Run');
    const day = 24 * 3600;

    const gapped = [0, 1, 2, 4, 5, 6].map((d) => event('gap@example.com', 'presence.call', { at: secondsAgo(d * day + 3600) }));
    expect(await unlocksOf(gapped)).toEqual([]);

    const run = [0, 1, 2, 3, 4, 5].map((d) => event('run@example.com', 'presence.call', { at: secondsAgo(d * day + 3600) }));
    expect(await unlocksOf(run)).toEqual([]);
    expect(await unlocksOf([event('run@example.com', 'presence.call', { at: secondsAgo(6 * day + 3600) })])).toEqual(['presence.streak.7']);
    expect(await unlocksOf([event('run@example.com', 'presence.call', { at: secondsAgo(7 * day + 3600) })])).toEqual([]);
  });

  it('three messages inside five minutes unlocks; three inside six does not', async () => {
    defineAchievement(db, { id: 'msg.burst.3', rule: { op: 'within', type: 'msg.post', n: 3, window_s: 300 } });
    await linkedPlayer('slow@example.com', 'Slow');
    await linkedPlayer('fast@example.com', 'Fast');

    const slow = [360, 180, 0].map((s) => event('slow@example.com', 'msg.post', { at: secondsAgo(s + 1000) }));
    expect(await unlocksOf(slow)).toEqual([]);

    const fast = [299, 150, 0].map((s) => event('fast@example.com', 'msg.post', { at: secondsAgo(s + 1000) }));
    expect(await unlocksOf(fast)).toEqual(['msg.burst.3']);
    expect(await unlocksOf([event('fast@example.com', 'msg.post', { at: secondsAgo(999) })])).toEqual([]);
  });

  it('the file meta award unlocks only when every file achievement is unlocked', async () => {
    defineAchievement(db, { id: 'file.first', rule: { op: 'first', type: 'file.upload' } });
    defineAchievement(db, { id: 'file.dl.first', rule: { op: 'first', type: 'file.download' } });
    defineAchievement(db, { id: 'file.all', rule: { op: 'all', ids: ['file.first', 'file.dl.first'] } });
    await linkedPlayer('caller@example.com', 'Caller');

    expect(await unlocksOf([event('caller@example.com', 'file.upload')])).toEqual(['file.first']);
    expect(await unlocksOf([event('caller@example.com', 'file.download')])).toEqual(['file.dl.first', 'file.all']);
    expect(await unlocksOf([event('caller@example.com', 'file.download')])).toEqual([]);
  });

  it('a snapshot of a hundred uploads unlocks the hundred-upload award without a hundred events', async () => {
    defineAchievement(db, { id: 'file.upload.100', rule: { op: 'count', type: 'file.upload', n: 100 } });
    await linkedPlayer('caller@example.com', 'Caller');
    const snap = (value: number) => ({
      ref: `${TEST_BOARD_ID}:caller@example.com:stat:file.upload:${value}`,
      email: 'caller@example.com',
      type: 'stat.snapshot',
      at: new Date().toISOString(),
      key: 'file.upload',
      value,
    });

    expect(await unlocksOf([snap(99)])).toEqual([]);
    expect(await unlocksOf([snap(100)])).toEqual(['file.upload.100']);
    expect((await post('/events', { events: [snap(100)] })).body).toMatchObject({ duplicates: 1, unlocks: [] });
  });

  it('a snapshot lower than the stored one unlocks nothing and reduces nothing', async () => {
    defineAchievement(db, { id: 'file.upload.100', rule: { op: 'count', type: 'file.upload', n: 100 } });
    defineAchievement(db, { id: 'file.upload.50', rule: { op: 'count', type: 'file.upload', n: 50 } });
    await linkedPlayer('caller@example.com', 'Caller');
    const snap = (value: number) => ({
      ref: `${TEST_BOARD_ID}:caller@example.com:stat:file.upload:${value}`,
      email: 'caller@example.com',
      type: 'stat.snapshot',
      at: new Date().toISOString(),
      key: 'file.upload',
      value,
    });

    expect(await unlocksOf([snap(120)])).toEqual(['file.upload.100', 'file.upload.50']);
    const lower = await post('/events', { events: [snap(10)] });
    expect(lower.body).toMatchObject({ accepted: 1, unlocks: [] });
    expect(db.prepare(`SELECT value FROM snapshots WHERE name = 'file.upload'`).get()).toEqual({ value: 120 });
    // And the progress report, if any, reads the stored maximum.
    expect(lower.body.progress).toEqual([]);
  });

  it('a three-level meta chain unlocks all three in one request', async () => {
    defineAchievement(db, { id: 'chain.1', rule: { op: 'first', type: 'msg.post' } });
    defineAchievement(db, { id: 'chain.2', rule: { op: 'all', ids: ['chain.1'] } });
    defineAchievement(db, { id: 'chain.3', rule: { op: 'all', ids: ['chain.2'] } });
    await linkedPlayer('caller@example.com', 'Caller');

    expect(await unlocksOf([event('caller@example.com', 'msg.post')])).toEqual(['chain.1', 'chain.2', 'chain.3']);
    // The first unlock the board ever recorded also left meta.board_first.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'meta.board_first'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'meta.unlock'`).get()).toEqual({ n: 3 });
  });

  it('a granted-op achievement never unlocks from events', async () => {
    defineAchievement(db, { id: 'rare.season.winner', rule: { op: 'granted' } });
    defineAchievement(db, { id: 'msg.first', rule: { op: 'first', type: 'msg.post' } });
    await linkedPlayer('caller@example.com', 'Caller');

    expect(await unlocksOf([event('caller@example.com', 'msg.post')])).toEqual(['msg.first']);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM achievement_types WHERE achievement_id = 'rare.season.winner'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM unlocks WHERE achievement_id = 'rare.season.winner'`).get()).toEqual({ n: 0 });
  });

  it('the engine considers only achievements naming a type the batch touched', async () => {
    defineAchievement(db, { id: 'msg.post.100', rule: { op: 'count', type: 'msg.post', n: 100 } });
    defineAchievement(db, { id: 'file.upload.100', rule: { op: 'count', type: 'file.upload', n: 100 } });
    defineAchievement(db, { id: 'presence.streak.7', rule: { op: 'streak', type: 'presence.call', unit: 'day', n: 7 } });
    await linkedPlayer('caller@example.com', 'Caller');

    await post('/events', { events: [event('caller@example.com', 'msg.post')] });

    expect(_lastEvaluatedForTests()).toEqual(['msg.post.100']);
  });

  it('progress never exceeds twenty entries, and is ordered by how close each is', async () => {
    for (let n = 2; n <= 27; n += 1) defineAchievement(db, { id: `msg.post.${n}`, rule: { op: 'count', type: 'msg.post', n } });
    await linkedPlayer('caller@example.com', 'Caller');

    const res = await post('/events', { events: [event('caller@example.com', 'msg.post')] });

    expect(res.body.progress).toHaveLength(MAX_PROGRESS);
    expect(res.body.progress[0]).toEqual({ id: 'msg.post.2', have: 1, need: 2 });
    expect(res.body.progress[19]).toEqual({ id: 'msg.post.21', have: 1, need: 21 });
  });

  it("the engine's source names no achievement id", () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/achievements/engine.ts'), 'utf8');
    for (const id of ['msg.post', 'file.upload', 'presence.call', 'rare.', 'boards.']) {
      expect(src).not.toContain(`'${id}`);
    }
  });
});
