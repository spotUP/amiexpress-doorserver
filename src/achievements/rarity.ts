/**
 * Rarity: how many verified players hold each achievement.
 *
 * `unlocked_verified_players / verified_players`, in tenths of a percent
 * (81 = 8.1%) because a C89 door has no float parsing worth relying on, and
 * bucketed: common above 25%, uncommon 10-25%, rare 2-10%, epic 0.5-2%,
 * legendary below 0.5%.
 *
 * THE FLOOR. With zero verified players every achievement is legendary by
 * arithmetic, which is wrong on day one, so fewer than twenty verified
 * players means every rarity is common at 1000 (ACHIEVEMENTS-API.md).
 *
 * Recomputed lazily, at most once per 24 h, from the top of every write
 * request (D12: no scheduler) and from scripts/achievements-season.ts.
 */
import type Database from 'better-sqlite3';
import type { RarityBucket } from '../../contract/achievement-types';

export const RARITY_INTERVAL_SECONDS = 24 * 3600;
export const RARITY_PLAYER_FLOOR = 20;
export const RARITY_META_KEY = 'rarity_computed_at';

export function bucketFor(pctTenths: number): RarityBucket {
  if (pctTenths > 250) return 'common';
  if (pctTenths > 100) return 'uncommon';
  if (pctTenths > 20) return 'rare';
  if (pctTenths > 5) return 'epic';
  return 'legendary';
}

/**
 * The rarity a reader sees when no rarity row exists yet - an achievement
 * published since the last recompute, or a database on its first day.
 *
 * This is the SAME floor `computeRarity` writes under twenty verified
 * players, and it lives here rather than at a read site because three
 * surfaces answer this question (the catalog, a profile's unlocks and the
 * unlocks an events batch returns). Two of them used to answer `0` -
 * "unlocked by nobody", the most legendary number there is - which is the
 * exact day-one arithmetic the floor exists to prevent, and which the
 * captured examples in docs/ACHIEVEMENTS-API.md caught.
 */
export const RARITY_FLOOR = { pctTenths: 1000, bucket: 'common' as RarityBucket };

/** The floor applied: a stored rarity, or the floor when there is none. */
export function rarityOf(
  pctTenths: number | null | undefined,
  bucket?: RarityBucket | null
): { pctTenths: number; bucket: RarityBucket } {
  if (pctTenths === null || pctTenths === undefined) return { ...RARITY_FLOOR };
  return { pctTenths, bucket: bucket ?? bucketFor(pctTenths) };
}

export interface RarityRun {
  verifiedPlayers: number;
  achievements: number;
  floored: boolean;
}

/** Recompute every achievement's rarity now, unconditionally. */
export function computeRarity(db: Database.Database, now: number): RarityRun {
  const verified = (db.prepare('SELECT COUNT(*) AS n FROM players WHERE verified_at IS NOT NULL').get() as { n: number }).n;
  const floored = verified < RARITY_PLAYER_FLOOR;
  const rows = db
    .prepare(
      `SELECT a.id,
              (SELECT COUNT(DISTINCT u.player_id) FROM unlocks u JOIN players p ON p.id = u.player_id
                WHERE u.achievement_id = a.id AND p.verified_at IS NOT NULL) AS unlocked
         FROM achievements a`
    )
    .all() as { id: string; unlocked: number }[];
  const upsert = db.prepare(
    `INSERT INTO rarity (achievement_id, unlocked, verified, pct_tenths, bucket, computed_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(achievement_id) DO UPDATE SET
       unlocked = excluded.unlocked, verified = excluded.verified, pct_tenths = excluded.pct_tenths,
       bucket = excluded.bucket, computed_at = excluded.computed_at`
  );
  for (const r of rows) {
    const tenths = floored ? 1000 : Math.round((r.unlocked * 1000) / verified);
    upsert.run(r.id, r.unlocked, verified, tenths, floored ? 'common' : bucketFor(tenths), now);
  }
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(RARITY_META_KEY, String(now));
  return { verifiedPlayers: verified, achievements: rows.length, floored };
}

export function rarityComputedAt(db: Database.Database): number | null {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(RARITY_META_KEY) as { v: string } | undefined;
  return row ? Number(row.v) : null;
}

/** Recompute when the last run is a day old or older. Returns the run, or null. */
export function refreshRarityIfStale(db: Database.Database, now: number): RarityRun | null {
  const last = rarityComputedAt(db);
  if (last !== null && now - last < RARITY_INTERVAL_SECONDS) return null;
  return computeRarity(db, now);
}
