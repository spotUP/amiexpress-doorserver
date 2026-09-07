/**
 * AC-18 - the recorded-week replay.
 *
 * The regression that catches a rule-engine change nobody meant to make.
 * recorded-week.jsonl (see make-recorded-week.ts beside it) is replayed
 * against a FRESH, SEEDED database through the real POST /events in
 * batches of at most 100, one batch per day, and the exact unlock list -
 * ids in order - is compared with recorded-week.expected.json. Then the
 * whole week is replayed a second time and must change nothing.
 *
 * To re-freeze after a DELIBERATE rule change: RECORD_EXPECTED=1 npx jest
 * ... replay.test.ts, then read the diff of the expected file as the
 * review it is.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { createBoard } from '../../src/achievements/boards';
import { makeAchievementsFixture, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

// Scrypt and a thousand requests under eight parallel workers: five
// seconds is a load-dependent limit, not a correctness one.
jest.setTimeout(60000);

const FIXTURE = path.join(__dirname, 'fixtures', 'recorded-week.jsonl');
const EXPECTED = path.join(__dirname, 'fixtures', 'recorded-week.expected.json');
const DAY = 86400;

interface Line {
  day: number;
  board: 'uprough' | 'other' | 'third';
  ref: string;
  email: string;
  type: string;
  offset: number;
  key?: string;
  value?: number;
}

interface Expected {
  /** Unlocks the population itself earned - at the links, before day 0. */
  populationUnlocks: string[];
  unlocks: string[];
  accepted: number;
  duplicates: number;
  rejected: Record<string, number>;
  clamped: number;
}

let fx: AchievementsFixture;
let db: Database.Database;
let auth: Record<string, string>;

beforeEach(() => {
  fx = makeAchievementsFixture({ seed: true });
  db = fx.openAchievements();
  auth = { uprough: fx.auth, other: `Board ${createBoard(db, 'other', 'Other', null).key}`, third: `Board ${createBoard(db, 'third', 'Third', null).key}` };
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

const post = (path: string, body: unknown, board = 'uprough'): Promise<Response> =>
  request(fx.app).post(`/achievements/v1${path}`).set('Authorization', auth[board]).send(body as object);

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
function codeFromLatestMail(): string {
  const mail = db.prepare('SELECT body FROM mail_queue ORDER BY id DESC LIMIT 1').get() as { body: string };
  return mail.body.split('\n').filter((l) => CODE.test(l))[0];
}

/** The cast, the way callers arrive. */
async function population(): Promise<void> {
  const verify = async (email: string, handle: string): Promise<string> => {
    await post('/players', { email, handle });
    const res = await post('/players/verify', { email, code: codeFromLatestMail() });
    return res.body.linkCode as string;
  };
  let code = await verify('alice@example.com', 'Alice');
  code = (await post('/links', { email: 'alice@example.com', code })).body.linkCode;
  code = (await post('/links', { email: 'alice@example.com', code }, 'other')).body.linkCode;
  await post('/links', { email: 'alice@example.com', code }, 'third');
  code = await verify('bob@example.com', 'Bob');
  await post('/links', { email: 'bob@example.com', code });
  await post('/players', { email: 'carol@example.com', handle: 'Carol' });
  await verify('dave@example.com', 'Dave');
}

const lines = (): Line[] => fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line);

/** Replay every day, in batches of at most 100. Returns the tallies. */
async function replay(base: number): Promise<Omit<Expected, 'populationUnlocks'> & { unlockedAt: string[] }> {
  const out = { unlocks: [] as string[], accepted: 0, duplicates: 0, rejected: {} as Record<string, number>, clamped: 0, unlockedAt: [] as string[] };
  const byDay = new Map<number, Line[]>();
  for (const l of lines()) byDay.set(l.day, [...(byDay.get(l.day) ?? []), l]);
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const dayLines = byDay.get(day) as Line[];
    for (const board of ['uprough', 'other', 'third'] as const) {
      const mine = dayLines.filter((l) => l.board === board);
      for (let i = 0; i < mine.length; i += 100) {
        const events = mine.slice(i, i + 100).map((l) => ({
          ref: l.ref,
          email: l.email,
          type: l.type,
          at: new Date((base + l.offset) * 1000).toISOString(),
          ...(l.key !== undefined ? { key: l.key } : {}),
          ...(l.value !== undefined ? { value: l.value } : {}),
        }));
        const res = await post('/events', { events }, board);
        if (res.status !== 200) throw new Error(`day ${day} ${board}: ${res.status} ${JSON.stringify(res.body)}`);
        out.accepted += res.body.accepted;
        out.duplicates += res.body.duplicates;
        for (const r of res.body.rejected as { reason: string }[]) out.rejected[r.reason] = (out.rejected[r.reason] ?? 0) + 1;
        // Labelled by day and board: two players may earn the same id.
        for (const u of res.body.unlocks as { id: string }[]) out.unlocks.push(`${day}/${board}:${u.id}`);
      }
    }
  }
  out.clamped = (db.prepare('SELECT COUNT(*) AS n FROM events WHERE clamped = 1').get() as { n: number }).n;
  return out;
}

describe('the recorded week', () => {
  it('replays to exactly the expected unlocks, and a second replay changes nothing', async () => {
    const all = lines();
    // The fixture carries what the plan says it must.
    const types = new Set(all.map((l) => l.type));
    for (const t of ['msg.post', 'presence.call', 'file.upload', 'stat.snapshot', 'wall.tag', 'social.chat', 'social.vote', 'presence.client']) {
      expect(types.has(t)).toBe(true);
    }
    const refs = all.map((l) => l.ref);
    expect(new Set(refs).size).toBe(refs.length - 1); // one duplicate ref
    expect(all.some((l) => l.offset > 7 * DAY + 900)).toBe(true); // the future one
    expect(all.some((l) => l.offset < 7 * DAY - 30 * DAY)).toBe(true); // the 40-day-old one
    expect(all.some((l) => l.email === 'carol@example.com')).toBe(true);
    expect(all.some((l) => l.email === 'dave@example.com')).toBe(true);

    await population();
    const populationUnlocks = (db.prepare('SELECT achievement_id FROM unlocks ORDER BY at, achievement_id').all() as { achievement_id: string }[]).map((r) => r.achievement_id);
    // Day 6 is replay day and its afternoon must be BEHIND the clock, or
    // the clamp catches it: the base sits a full week back.
    const base = Math.floor(Date.now() / 1000) - 7 * DAY;
    const first = await replay(base);

    // The two clamped events, from the clamped day.
    expect(first.clamped).toBe(2);
    const clampedDays = db.prepare(`SELECT type, at, received_at FROM events WHERE clamped = 1 ORDER BY type`).all() as { type: string; at: number; received_at: number }[];
    for (const c of clampedDays) expect(c.at).toBe(c.received_at);
    expect(clampedDays.map((c) => c.type)).toEqual(['social.chat', 'social.vote']);

    const got: Expected = { populationUnlocks, unlocks: first.unlocks, accepted: first.accepted, duplicates: first.duplicates, rejected: first.rejected, clamped: first.clamped };
    if (process.env.RECORD_EXPECTED === '1') {
      fs.writeFileSync(EXPECTED, JSON.stringify(got, null, 2) + '\n');
    }
    const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8')) as Expected;
    if (JSON.stringify(got.unlocks) !== JSON.stringify(expected.unlocks)) {
      // Side by side, so a diff in the unlock list reads as one.
      const width = Math.max(...expected.unlocks.map((s) => s.length), 8);
      const rows = Math.max(expected.unlocks.length, got.unlocks.length);
      const table = ['expected'.padEnd(width) + '  got'];
      for (let i = 0; i < rows; i += 1) table.push((expected.unlocks[i] ?? '').padEnd(width) + '  ' + (got.unlocks[i] ?? ''));
      throw new Error('the replay unlocked a different list:\n' + table.join('\n'));
    }
    expect(got).toEqual(expected);

    // The week again: nothing.
    const second = await replay(base);
    expect(second.accepted).toBe(0);
    expect(second.unlocks).toEqual([]);
    expect(second.duplicates).toBe(first.accepted + first.duplicates);
    expect(db.prepare('SELECT COUNT(*) AS n FROM unlocks').get()).toEqual({ n: expected.unlocks.length + expected.populationUnlocks.length });
  });
});
