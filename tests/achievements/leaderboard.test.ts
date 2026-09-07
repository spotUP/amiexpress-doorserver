/**
 * AC-15 - leaderboards, seasons, the season winner, rarity.
 *
 * SYM-11 MOVED HERE from the RED file. Unlocks are written the way the
 * engine writes them - through POST /events for the flow tests, and as rows
 * with an explicit board and season where a test needs a past season or a
 * second board's history, which no endpoint can be made to produce for a
 * date that has gone.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { createBoard, setBoardSuspended } from '../../src/achievements/boards';
import { closeDueSeasons, ensureCurrentSeason, seasonIdAt } from '../../src/achievements/seasons';
import { computeRarity, rarityComputedAt, refreshRarityIfStale } from '../../src/achievements/rarity';
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
  defineAchievement(db, { id: 'msg.post.1', rule: { op: 'count', type: 'msg.post', n: 1 }, points: 5 });
  defineAchievement(db, { id: 'file.up.1', rule: { op: 'count', type: 'file.upload', n: 1 }, points: 10 });
  defineAchievement(db, { id: 'rare.season.winner', rule: { op: 'granted' }, tier: 'platinum', points: 50, hidden: true });
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

const get = (path: string, auth = fx.auth): request.Test => request(fx.app).get(`/achievements/v1${path}`).set('Authorization', auth);
const handles = (res: Response): string[] => (res.body.rows as { handle: string }[]).map((r) => r.handle);

let nextId = 100;
/** A player row, verified, optionally private, linked to the given boards. */
function player(handle: string, opts: { private?: boolean; verified?: boolean; boards?: string[] } = {}): number {
  const id = nextId++;
  db.prepare(`INSERT INTO players (id, email_key, email, handle, verified_at, private, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)`).run(
    id, `${handle.toLowerCase()}@example.com`, `${handle.toLowerCase()}@example.com`, handle, opts.verified === false ? null : 1, opts.private ? 1 : 0
  );
  for (const b of opts.boards ?? [TEST_BOARD_ID]) db.prepare('INSERT INTO links (board_id, player_id, linked_at) VALUES (?, ?, 1)').run(b, id);
  return id;
}
function unlock(playerId: number, achievementId: string, boardId = TEST_BOARD_ID, seasonId = seasonIdAt(Math.floor(Date.now() / 1000)), at = 1000): void {
  db.prepare('INSERT INTO unlocks (player_id, achievement_id, board_id, season_id, at) VALUES (?, ?, ?, ?, ?)').run(playerId, achievementId, boardId, seasonId, at);
}

describe('leaderboards', () => {
  it('SYM-11: a private player is absent from the global board and present on the board they are linked to', async () => {
    const hermit = player('Hermit', { private: true });
    const loud = player('Loud');
    unlock(hermit, 'msg.post.1');
    unlock(loud, 'msg.post.1');

    const global = await get('/leaderboard?scope=global');
    const board = await get(`/leaderboard?scope=board:${TEST_BOARD_ID}`);

    expect(global.status).toBe(200);
    expect(handles(global)).toEqual(['Loud']);
    expect(global.body).toMatchObject({ scope: 'global', period: 'all', season: null });
    expect(global.body.rows[0]).toEqual({ rank: 1, handle: 'Loud', points: 5, unlocks: 1 });
    // Private is a GLOBAL opt-out only: the board's caller list is its own.
    expect(handles(board)).toEqual(['Hermit', 'Loud']);
  });

  it('an unverified player is on no leaderboard at all', async () => {
    const ghost = player('Ghost', { verified: false });
    unlock(ghost, 'msg.post.1');
    expect(handles(await get('/leaderboard?scope=global'))).toEqual([]);
    expect(handles(await get(`/leaderboard?scope=board:${TEST_BOARD_ID}`))).toEqual([]);
    // And a scope that is neither global nor board:<slug> is a 400.
    const bad = await get('/leaderboard?scope=galaxy');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_scope');
  });

  it("unlocks earned on a suspended board leave the global board and stay on that board's own", async () => {
    createBoard(db, 'shady', 'Shady', null);
    const p = player('Spot', { boards: [TEST_BOARD_ID, 'shady'] });
    unlock(p, 'msg.post.1', TEST_BOARD_ID);
    unlock(p, 'file.up.1', 'shady');
    expect((await get('/leaderboard?scope=global')).body.rows[0]).toMatchObject({ points: 15, unlocks: 2 });

    setBoardSuspended(db, 'shady', true);

    expect((await get('/leaderboard?scope=global')).body.rows[0]).toMatchObject({ points: 5, unlocks: 1 });
    expect((await get('/leaderboard?scope=board:shady')).body.rows[0]).toMatchObject({ handle: 'Spot', points: 10, unlocks: 1 });
  });

  it('the board leaderboard counts only the points earned on that board', async () => {
    createBoard(db, 'other', 'Other', null);
    const a = player('Alpha', { boards: [TEST_BOARD_ID, 'other'] });
    const b = player('Beta');
    unlock(a, 'msg.post.1', TEST_BOARD_ID);
    unlock(a, 'file.up.1', 'other');
    unlock(b, 'file.up.1', TEST_BOARD_ID);

    const rows = (await get(`/leaderboard?scope=board:${TEST_BOARD_ID}`)).body.rows;
    expect(rows).toEqual([
      { rank: 1, handle: 'Beta', points: 10, unlocks: 1 },
      { rank: 2, handle: 'Alpha', points: 5, unlocks: 1 },
    ]);
    // A scope naming an unknown board is an empty listing, not a 404.
    const unknown = await get('/leaderboard?scope=board:nowhere');
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ scope: 'board:nowhere', rows: [], revision: 'l0-t0' });
  });

  it('closing a season grants the winner and leaves every unlock untouched', () => {
    const q2 = 1780000000; // 2026-05-28, in 2026Q2
    const july = 1783000000; // 2026-07-02, in 2026Q3
    ensureCurrentSeason(db, q2);
    createBoard(db, 'other', 'Other', null);
    const winner = player('Winner', { boards: [TEST_BOARD_ID, 'other'] });
    const runnerUp = player('Runner');
    unlock(winner, 'msg.post.1', TEST_BOARD_ID, '2026Q2', q2);
    unlock(winner, 'file.up.1', 'other', '2026Q2', q2 + 1);
    unlock(runnerUp, 'msg.post.1', TEST_BOARD_ID, '2026Q2', q2);
    const before = db.prepare('SELECT * FROM unlocks ORDER BY player_id, achievement_id').all();

    const closes = closeDueSeasons(db, july);

    expect(closes).toEqual([{ seasonId: '2026Q2', globalWinner: 'Winner', boardWinners: [] }]);
    const granted = db.prepare(`SELECT player_id, board_id, season_id FROM unlocks WHERE achievement_id = 'rare.season.winner'`).all();
    // Stamped with the board of the highest-scoring unlock that season.
    expect(granted).toEqual([{ player_id: winner, board_id: 'other', season_id: '2026Q2' }]);
    expect(db.prepare('SELECT * FROM unlocks WHERE achievement_id <> ? ORDER BY player_id, achievement_id').all('rare.season.winner')).toEqual(before);
    expect(db.prepare('SELECT closed_at FROM seasons WHERE id = ?').get('2026Q2')).toEqual({ closed_at: july });
    // Closing again grants nothing and closes nothing.
    expect(closeDueSeasons(db, july + 1)).toEqual([]);
    // A season with no unlocks closes silently.
    db.prepare(`INSERT INTO seasons (id, starts_at, ends_at) VALUES ('2025Q4', 1, 2)`).run();
    expect(closeDueSeasons(db, july)).toEqual([{ seasonId: '2025Q4', globalWinner: null, boardWinners: [] }]);
  });

  it('a board with four verified linked players mints no season winner; five does', () => {
    const q2 = 1780000000;
    const july = 1783000000;
    ensureCurrentSeason(db, q2);
    createBoard(db, 'small', 'Small', null);
    createBoard(db, 'big', 'Big', null);
    // Three plus the top makes four on small; four plus the top makes five on big.
    for (let i = 0; i < 3; i += 1) player(`Small${i}`, { boards: ['small'] });
    for (let i = 0; i < 4; i += 1) player(`Big${i}`, { boards: ['big'] });
    const smallTop = player('SmallTop', { boards: ['small'], private: true });
    const bigTop = player('BigTop', { boards: ['big'], private: true });
    unlock(smallTop, 'msg.post.1', 'small', '2026Q2', q2);
    unlock(bigTop, 'msg.post.1', 'big', '2026Q2', q2);

    const closes = closeDueSeasons(db, july);

    // Private players win their own board and never the global one.
    expect(closes).toEqual([{ seasonId: '2026Q2', globalWinner: null, boardWinners: [{ boardId: 'big', handle: 'BigTop' }] }]);
  });

  it('season points reset at the roll and all-time points do not', async () => {
    const p = player('Spot');
    unlock(p, 'msg.post.1', TEST_BOARD_ID, '2026Q1', 100);
    unlock(p, 'file.up.1', TEST_BOARD_ID, seasonIdAt(Math.floor(Date.now() / 1000)), 200);

    const all = await get('/leaderboard?scope=global&period=all');
    const season = await get('/leaderboard?scope=global&period=season');

    expect(all.body.rows[0]).toMatchObject({ points: 15, unlocks: 2 });
    expect(season.body).toMatchObject({ period: 'season', season: seasonIdAt(Math.floor(Date.now() / 1000)) });
    expect(season.body.rows[0]).toMatchObject({ points: 10, unlocks: 1 });
  });

  it('rarity with fewer than twenty verified players is common, not legendary', async () => {
    const p = player('Spot');
    unlock(p, 'msg.post.1');

    const run = computeRarity(db, 1800000000);

    expect(run).toEqual({ verifiedPlayers: 1, achievements: 3, floored: true });
    const rows = db.prepare('SELECT achievement_id, pct_tenths, bucket FROM rarity ORDER BY achievement_id').all();
    expect(rows).toEqual([
      { achievement_id: 'file.up.1', pct_tenths: 1000, bucket: 'common' },
      { achievement_id: 'msg.post.1', pct_tenths: 1000, bucket: 'common' },
      { achievement_id: 'rare.season.winner', pct_tenths: 1000, bucket: 'common' },
    ]);
    // Twenty verified players, one of whom holds msg.post.1: 5.0%, rare.
    for (let i = 0; i < 19; i += 1) player(`P${i}`);
    computeRarity(db, 1800000001);
    expect(db.prepare('SELECT pct_tenths, bucket FROM rarity WHERE achievement_id = ?').get('msg.post.1')).toEqual({ pct_tenths: 50, bucket: 'rare' });
    expect(db.prepare('SELECT pct_tenths, bucket FROM rarity WHERE achievement_id = ?').get('file.up.1')).toEqual({ pct_tenths: 0, bucket: 'legendary' });
    // And the catalog reports what was computed.
    const catalog = await get('/catalog');
    expect((catalog.body.achievements as { id: string; rarityPctTenths: number; rarityBucket: string }[]).find((a) => a.id === 'msg.post.1')).toMatchObject({ rarityPctTenths: 50, rarityBucket: 'rare' });
  });

  it('rarity is recomputed at most once a day', () => {
    expect(rarityComputedAt(db)).toBeNull();
    expect(refreshRarityIfStale(db, 1800000000)).not.toBeNull();
    expect(refreshRarityIfStale(db, 1800000000 + 86399)).toBeNull();
    expect(rarityComputedAt(db)).toBe(1800000000);
    expect(refreshRarityIfStale(db, 1800000000 + 86400)).not.toBeNull();
    expect(rarityComputedAt(db)).toBe(1800000000 + 86400);
  });

  it('two identical leaderboard requests return the same order, and a write request winds the clock', async () => {
    const a = player('Alpha');
    const b = player('Beta');
    const c = player('Gamma');
    unlock(a, 'msg.post.1', TEST_BOARD_ID, undefined, 500);
    unlock(b, 'msg.post.1', TEST_BOARD_ID, undefined, 400);
    unlock(c, 'msg.post.1', TEST_BOARD_ID, undefined, 400);

    const one = await get('/leaderboard?scope=global');
    const two = await get('/leaderboard?scope=global');

    // Equal points: earliest last-unlock first, then handle.
    expect(handles(one)).toEqual(['Beta', 'Gamma', 'Alpha']);
    expect(two.text).toBe(one.text);
    expect(one.headers.etag).toBe(`"${one.body.revision}"`);
    expect((await get('/leaderboard?scope=global').set('If-None-Match', one.headers.etag)).status).toBe(304);

    // Any write request runs the clock: the rarity rows appear without a CLI.
    expect(rarityComputedAt(db)).toBeNull();
    await request(fx.app).post('/achievements/v1/players').set('Authorization', fx.auth).send({ email: 'new@example.com', handle: 'Newbie' });
    expect(rarityComputedAt(db)).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM seasons').get()).toEqual({ n: 1 });
  });
});
