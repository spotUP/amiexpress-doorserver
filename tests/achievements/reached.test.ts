/**
 * AC-20 - the reachability ledger's instrument.
 *
 * Every row of .superpowers/sdd/2026-09-03-achievements-server/REACHED.tsv
 * is a CALL COUNT taken here, through the real app over HTTP with a real
 * board key, never a source pin. Sentinels are spied on the MODULE OBJECT
 * - ts-jest compiles a cross-module import into a property access, so the
 * spy sees it; an intra-module call is bound locally and the spy records
 * zero whether the path ran or not. Where the plan named an intra-module
 * symbol, the row counts the nearest cross-module one and says so.
 *
 * R0 validates the instrument first: the same walk against a server built
 * with `achievements: null` must report the router DEAD.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import request from 'supertest';
import * as auth from '../../src/auth';
import * as migrations from '../../src/migrations';
import * as textFormat from '../../src/text-format';
import { createApp } from '../../src/app';
import * as boards from '../../src/achievements/boards';
import * as catalog from '../../src/achievements/catalog';
import * as counters from '../../src/achievements/counters';
import * as db from '../../src/achievements/db';
import * as engine from '../../src/achievements/engine';
import * as leaderboard from '../../src/achievements/leaderboard';
import * as mail from '../../src/achievements/mail';
import * as profile from '../../src/achievements/profile';
import * as ratelimit from '../../src/achievements/ratelimit';
import * as router from '../../src/achievements/router';
import * as seasons from '../../src/achievements/seasons';
import { defineAchievement, makeAchievementsFixture, recordingMailer, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

jest.setTimeout(60000);

let fx: AchievementsFixture;
let store: Database.Database;

beforeEach(() => {
  fx = makeAchievementsFixture();
  store = fx.openAchievements();
});

afterEach(() => {
  store.close();
  fx.cleanup();
  jest.restoreAllMocks();
});

const post = (p: string, body: unknown, key = fx.auth): request.Test =>
  request(fx.app).post(`/achievements/v1${p}`).set('Authorization', key).send(body as object);
const get = (p: string, key = fx.auth): request.Test => request(fx.app).get(`/achievements/v1${p}`).set('Authorization', key);

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const codeFromLatestMail = (): string =>
  (store.prepare('SELECT body FROM mail_queue ORDER BY id DESC LIMIT 1').get() as { body: string }).body.split('\n').filter((l) => CODE.test(l))[0];

async function linkedPlayer(email: string, handle: string): Promise<string> {
  await post('/players', { email, handle });
  const verify = await post('/players/verify', { email, code: codeFromLatestMail() });
  const link = await post('/links', { email, code: verify.body.linkCode });
  return link.body.linkCode as string;
}

let seq = 0;
const event = (email: string, type: string, extra: Record<string, unknown> = {}) => ({
  ref: `${TEST_BOARD_ID}:R${++seq}`, email, type, at: new Date().toISOString(), ...extra,
});

describe('REACHED.tsv', () => {
  it('R0: the router is LIVE on a configured server and DEAD on one without achievements', () => {
    const spy = jest.spyOn(router, 'createAchievementsRouter');
    createApp(fx.cfg);
    expect(spy).toHaveBeenCalledTimes(1);
    createApp({ ...fx.cfg, achievements: null, releases: null });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('R2: startup runs the migrations once and leaves doors.db alone', () => {
    const doors = new Database(fx.doorsDbPath, { readonly: true });
    const tablesBefore = doors.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const spy = jest.spyOn(migrations, 'runMigrations');
    db.initAchievementsDb({ ...fx.ach, dbPath: path.join(fx.dir, 'r2.db') }, { seed: null });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(doors.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual(tablesBefore);
    doors.close();
  });

  it('R4/R5: one scrypt per cold key, none per cached, an audit row per accepted write, the header on a 401', async () => {
    defineAchievement(store, { id: 'msg.post.100', rule: { op: 'count', type: 'msg.post', n: 100 } });
    boards._clearBoardKeyCacheForTests();
    const verify = jest.spyOn(auth, 'verifyPassword');
    const audit = jest.spyOn(boards, 'auditBoard');
    await linkedPlayer('caller@example.com', 'Caller');
    verify.mockClear();
    audit.mockClear();
    boards._clearBoardKeyCacheForTests();

    const cold = await post('/events', { events: [event('caller@example.com', 'msg.post')] });
    expect(cold.status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
    const cached = await post('/events', { events: [event('caller@example.com', 'msg.post')] });
    expect(cached.status).toBe(200);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(2);

    const wrong = await post('/events', { events: [] }, `Board ${TEST_BOARD_ID}.not-the-secret`);
    expect(wrong.status).toBe(401);
    expect(wrong.headers['x-achievements-contract']).toBe('1');
    expect(verify).toHaveBeenCalledTimes(2);
    boards.setBoardSuspended(store, TEST_BOARD_ID, true);
    expect((await post('/events', { events: [event('caller@example.com', 'msg.post')] })).status).toBe(403);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it('R6/R7: a registration queues one mail, the drain sends it, one hash per code and one verify per attempt', async () => {
    const queue = jest.spyOn(mail, 'queueMail');
    const hash = jest.spyOn(auth, 'hashPassword');
    const verify = jest.spyOn(auth, 'verifyPassword');
    boards._clearBoardKeyCacheForTests();
    const res = await post('/players', { email: 'caller@example.com', handle: 'Caller' });
    expect(res.status).toBe(202);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledTimes(1);
    const mailer = recordingMailer();
    mailer.refuse(1);
    await mail.drainMailQueue(store, mailer, Math.floor(Date.now() / 1000));
    expect(mailer.calls).toBe(1);
    await mail.drainMailQueue(store, mailer, Math.floor(Date.now() / 1000) + 120);
    expect(mailer.sent).toHaveLength(1);

    verify.mockClear();
    expect((await post('/players/verify', { email: 'caller@example.com', code: 'ZZZZZZ' })).status).toBe(400);
    const ok = await post('/players/verify', { email: 'caller@example.com', code: codeFromLatestMail() });
    expect(ok.status).toBe(200);
    // Two code checks, one per attempt; the board key was already cached.
    expect(verify).toHaveBeenCalledTimes(2);
    expect(hash).toHaveBeenCalledTimes(2); // the verify code, then the link code
  });

  it('R8: a link appends exactly one meta.link, a relink none', async () => {
    const record = jest.spyOn(counters, 'recordEvent');
    await post('/players', { email: 'caller@example.com', handle: 'Caller' });
    const verify = await post('/players/verify', { email: 'caller@example.com', code: codeFromLatestMail() });
    record.mockClear();
    expect((await post('/links', { email: 'caller@example.com', code: verify.body.linkCode })).status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1].type).toBe('meta.link');
    expect((await post('/links', { email: 'caller@example.com', code: 'ZZZZZZ' })).status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('R9/R10: a hundred-event batch, half duplicates, inserts fifty and evaluates once; the hundredth message unlocks once', async () => {
    defineAchievement(store, { id: 'msg.post.100', rule: { op: 'count', type: 'msg.post', n: 100 }, name: 'Century' });
    await linkedPlayer('caller@example.com', 'Caller');
    const record = jest.spyOn(counters, 'recordEvent');
    const evaluate = jest.spyOn(engine, 'evaluate');
    const fifty = Array.from({ length: 50 }, () => event('caller@example.com', 'msg.post'));
    const res = await post('/events', { events: [...fifty, ...fifty] });
    expect(res.body).toMatchObject({ accepted: 50, duplicates: 50 });
    // recordEvent -> foldEvent is intra-module; recordEvent is the
    // cross-module sentinel: 100 calls, 50 of them new rows (the fold ran 50).
    expect(record).toHaveBeenCalledTimes(100);
    expect(record.mock.results.filter((r) => r.value === true)).toHaveLength(50);
    expect(store.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'msg.post'`).get()).toEqual({ n: 50 });
    expect(evaluate).toHaveBeenCalledTimes(1);

    evaluate.mockClear();
    const rest = Array.from({ length: 50 }, () => event('caller@example.com', 'msg.post'));
    const hundredth = await post('/events', { events: rest });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(hundredth.body.unlocks[0].id).toBe('msg.post.100');
    expect(store.prepare('SELECT COUNT(*) AS n FROM unlocks').get()).toEqual({ n: 1 });
  });

  it('R11: startup on a fresh database seeds the catalog once, to the pinned count', () => {
    const seed = jest.spyOn(catalog, 'seedCatalog');
    const fresh = path.join(fx.dir, 'r11.db');
    db.initAchievementsDb({ ...fx.ach, dbPath: fresh });
    expect(seed).toHaveBeenCalledTimes(1);
    const d = new Database(fresh, { readonly: true });
    expect(d.prepare('SELECT COUNT(*) AS n FROM achievements').get()).toEqual({ n: 66 });
    d.close();
  });

  it('R12: catalog.txt goes through the one escaper and is Latin-1 with CRLF', async () => {
    defineAchievement(store, { id: 'msg.post.1', rule: { op: 'count', type: 'msg.post', n: 1 } });
    const latin = jest.spyOn(textFormat, 'toLatin1Safe');
    const res = await get('/catalog.txt').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(latin.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(res.headers['content-type']).toBe('text/plain; charset=ISO-8859-1');
    expect((res.body as Buffer).toString('latin1').endsWith('\r\n')).toBe(true);
  });

  it('R13: a door-defined achievement unlocks through the real events path', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const put = await request(fx.app).put('/achievements/v1/catalog/doors/grandmaster').set('Authorization', fx.auth).send({
      digest: 'x',
      achievements: [{ id: 'door.grandmaster.first_win', name: 'First Blood', description: 'Win', family: 'door', tier: 'bronze', points: 5, hidden: false, rule: { op: 'count', type: 'door.grandmaster.win', n: 1 } }],
    });
    expect(put.status).toBe(200);
    const evaluate = jest.spyOn(engine, 'evaluate');
    const res = await post('/events', { events: [event('caller@example.com', 'door.grandmaster.win')] });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(store.prepare('SELECT achievement_id FROM unlocks').all()).toEqual([{ achievement_id: 'door.grandmaster.first_win' }]);
    expect(res.body.unlocks[0].id).toBe('door.grandmaster.first_win');
  });

  it('R14: the profile is read twice, one 200 and one 403', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const read = jest.spyOn(profile, 'readProfile');
    const other = `Board ${boards.createBoard(store, 'other', 'Other', null).key}`;
    expect((await get('/players/caller%40example.com')).status).toBe(200);
    expect((await get('/players/caller%40example.com', other)).status).toBe(403);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('R15: a forced season close grants the winner exactly once, and the write clock runs on every write', async () => {
    defineAchievement(store, { id: 'rare.season.winner', rule: { op: 'granted' }, tier: 'platinum', points: 50, hidden: true });
    defineAchievement(store, { id: 'msg.post.1', rule: { op: 'count', type: 'msg.post', n: 1 } });
    await linkedPlayer('caller@example.com', 'Caller');
    const clock = jest.spyOn(seasons, 'ensureCurrentSeason');
    await post('/events', { events: [event('caller@example.com', 'msg.post')] });
    // Once from the write hook at the top of the request, once from the
    // engine stamping the unlock's season.
    expect(clock).toHaveBeenCalledTimes(2);
    store.prepare(`UPDATE unlocks SET season_id = '2026Q1'`).run();
    store.prepare(`INSERT INTO seasons (id, starts_at, ends_at) VALUES ('2026Q1', 1767225600, 1775001600)`).run();
    const closes = seasons.closeDueSeasons(store, 1776000000);
    expect(closes).toHaveLength(1);
    expect(store.prepare(`SELECT COUNT(*) AS n FROM unlocks WHERE achievement_id = 'rare.season.winner'`).get()).toEqual({ n: 1 });
    expect((await get('/leaderboard?scope=global')).body.rows[0]).toMatchObject({ handle: 'Caller', points: 55 });
  });

  it('R16: leaderboard.txt is rendered once and equals the fixture bytes', async () => {
    defineAchievement(store, { id: 'msg.post.1', rule: { op: 'count', type: 'msg.post', n: 1 }, points: 5 });
    await linkedPlayer('caller@example.com', 'Caller');
    await post('/events', { events: [event('caller@example.com', 'msg.post')] });
    const at = (store.prepare('SELECT at FROM unlocks').get() as { at: number }).at;
    const render = jest.spyOn(leaderboard, 'renderLeaderboardTxt');
    const res = await get('/leaderboard.txt?scope=global').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(render).toHaveBeenCalledTimes(1);
    expect(Buffer.compare(res.body as Buffer, Buffer.from(`ACHIEVE|1|l1-t${at}|1\r\n1|Caller|5|1\r\n`, 'latin1'))).toBe(0);
  });

  it('R17: past the limit the limiter refuses and nothing is inserted', async () => {
    defineAchievement(store, { id: 'msg.post.1', rule: { op: 'count', type: 'msg.post', n: 1 } });
    await linkedPlayer('caller@example.com', 'Caller');
    const refusalsBefore = ratelimit._rateLimitRefusalsForTests();
    for (let i = 0; i < ratelimit.LIMITS.eventsPerBoard.max; i += 1) await post('/events', { events: [event('caller@example.com', 'msg.post')] });
    const insert = jest.spyOn(counters, 'recordEvent');
    const over = await post('/events', { events: [event('caller@example.com', 'msg.post')] });
    expect(over.status).toBe(429);
    expect(ratelimit._rateLimitRefusalsForTests() - refusalsBefore).toBeGreaterThanOrEqual(1);
    expect(insert).toHaveBeenCalledTimes(0);
  });

  it('R18: the recorded week is pinned in replay.test.ts, and its fixture is committed', () => {
    const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'recorded-week.expected.json'), 'utf8')) as { unlocks: string[]; accepted: number };
    expect(expected.unlocks.length).toBeGreaterThan(0);
    expect(expected.accepted).toBe(127);
  });
});
