#!/usr/bin/env npx tsx
/**
 * The hand on the clock (D12: no scheduler).
 *
 * Season rolls and the rarity recompute are lazy - they run at the top of
 * every write request and do nothing unless the calendar says otherwise.
 * This script is the same two functions, callable by hand and at an
 * arbitrary time, so a roll can be forced and a test can drive one.
 *
 * Usage:
 *   ACHIEVEMENTS_DB=/data/achievements.db npx tsx scripts/achievements-season.ts status
 *   npx tsx scripts/achievements-season.ts --db <path> close [--at <iso>]
 *   npx tsx scripts/achievements-season.ts --db <path> rarity [--now <iso>]
 */
import { initAchievementsDb, openAchievementsDb } from '../src/achievements/db';
import { closeDueSeasons, ensureCurrentSeason, seasonIdAt } from '../src/achievements/seasons';
import { computeRarity, rarityComputedAt } from '../src/achievements/rarity';
import type { AchievementsConfig } from '../src/achievements/config';

const argv = process.argv.slice(2);
let dbPath = process.env.ACHIEVEMENTS_DB ?? '';
const dbFlag = argv.indexOf('--db');
if (dbFlag !== -1) {
  dbPath = argv[dbFlag + 1] ?? '';
  argv.splice(dbFlag, 2);
}
function timeFlag(name: string): number {
  const i = argv.indexOf(name);
  if (i === -1) return Math.floor(Date.now() / 1000);
  const t = Date.parse(argv[i + 1] ?? '');
  if (Number.isNaN(t)) {
    console.error(`[ERROR] ${name} takes an ISO 8601 timestamp`);
    process.exit(2);
  }
  argv.splice(i, 2);
  return Math.floor(t / 1000);
}
const at = timeFlag('--at');
const now = timeFlag('--now');
const [command] = argv;

if (!dbPath) {
  console.error('[ERROR] ACHIEVEMENTS_DB is not set and --db was not given');
  process.exit(2);
}
const ach: AchievementsConfig = { dbPath, smtpUrl: '', mailFrom: '', publicBaseUrl: '' };
initAchievementsDb(ach);
const db = openAchievementsDb(ach);
try {
  switch (command) {
    case 'status': {
      const seasons = db.prepare('SELECT id, starts_at, ends_at, closed_at FROM seasons ORDER BY starts_at').all() as {
        id: string; starts_at: number; ends_at: number; closed_at: number | null;
      }[];
      console.log(`[INFO] current season ${seasonIdAt(now)}`);
      for (const s of seasons) {
        console.log(`[INFO] ${s.id} ${new Date(s.starts_at * 1000).toISOString()} .. ${new Date(s.ends_at * 1000).toISOString()} ${s.closed_at ? 'closed' : 'open'}`);
      }
      const r = rarityComputedAt(db);
      console.log(`[INFO] rarity computed ${r === null ? 'never' : new Date(r * 1000).toISOString()}`);
      break;
    }
    case 'close': {
      ensureCurrentSeason(db, at);
      const closes = closeDueSeasons(db, at);
      if (closes.length === 0) console.log('[INFO] no season is due to close');
      for (const c of closes) {
        console.log(`[OK] closed ${c.seasonId}: global winner ${c.globalWinner ?? 'none'}, board winners ${c.boardWinners.map((b) => `${b.boardId}=${b.handle}`).join(' ') || 'none'}`);
      }
      break;
    }
    case 'rarity': {
      const run = computeRarity(db, now);
      console.log(`[OK] rarity over ${run.verifiedPlayers} verified players, ${run.achievements} achievements${run.floored ? ' (under the floor: all common)' : ''}`);
      break;
    }
    default:
      console.error('[ERROR] usage: achievements-season.ts [--db <path>] status|close [--at <iso>]|rarity [--now <iso>]');
      process.exit(2);
  }
} finally {
  db.close();
}
