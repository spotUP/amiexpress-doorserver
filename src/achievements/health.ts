/**
 * What the surface says about itself.
 *
 * Two objects, because two callers ask two different questions:
 *
 * - GET /achievements/v1/health answers the full object, with no board key,
 *   for a sysop and a monitor. `pendingMail` is the one number that matters
 *   most: a queue depth that stops going down is how a sysop finds out that
 *   verification codes are going nowhere, before the callers do.
 * - GET /api/door-repo/health - the URL the container healthcheck and the
 *   deploy workflow already call - gains an `achievements` key and nothing
 *   else. It reports `enabled: false` on a server that never configured the
 *   surface, so the existing healthcheck cannot start failing on a board
 *   that never wanted achievements.
 *
 * This lives beside the router rather than inside it so routes.ts can answer
 * the door-repo half without importing the achievements router, its body
 * parser and its auth.
 */
import type Database from 'better-sqlite3';
import { ACHIEVEMENTS_CONTRACT_VERSION } from '../../contract/achievement-types';
import type {
  AchievementsHealth,
  AchievementsHealthSummary,
} from '../../contract/achievement-types';
import type { ServerConfig } from '../config';
import type { AchievementsConfig } from './config';
import { withAchievementsDb } from './db';
import { catalogRevision } from './catalog';
import { pendingMailCount } from './mail';

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/**
 * The season the clock is inside, or null. Seasons are created lazily by
 * AC-15; a database with no season row is not an error, it is a server that
 * has not had a write yet.
 */
function currentSeason(db: Database.Database, now: number): string | null {
  const row = db
    .prepare(
      'SELECT id FROM seasons WHERE starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC LIMIT 1'
    )
    .get(now, now) as { id: string } | undefined;
  return row?.id ?? null;
}

export function achievementsHealth(
  ach: AchievementsConfig,
  now: number = Math.floor(Date.now() / 1000)
): AchievementsHealth {
  return withAchievementsDb(
    ach,
    (db) => ({
      status: 'ok',
      contractVersion: ACHIEVEMENTS_CONTRACT_VERSION,
      revision: catalogRevision(db),
      players: count(db, 'SELECT COUNT(*) AS n FROM players'),
      boards: count(db, 'SELECT COUNT(*) AS n FROM boards'),
      pendingMail: pendingMailCount(db),
      season: currentSeason(db, now),
    }),
    { readonly: true }
  );
}

/** The door-repo health object's new key, and nothing more than a key. */
export function achievementsHealthSummary(cfg: ServerConfig): AchievementsHealthSummary {
  if (!cfg.achievements) {
    return { enabled: false };
  }
  try {
    return withAchievementsDb(
      cfg.achievements,
      (db) => ({
        enabled: true,
        contractVersion: ACHIEVEMENTS_CONTRACT_VERSION,
        players: count(db, 'SELECT COUNT(*) AS n FROM players'),
        pendingMail: pendingMailCount(db),
      }),
      { readonly: true }
    );
  } catch (err) {
    // The container healthcheck and the deploy workflow call the door-repo
    // health URL. An achievements database that cannot be read is a real
    // fault and is logged as one, but it must not take the door repo's
    // liveness down with it - that is the whole reason the two are separate
    // files.
    console.error(`[ERROR] achievements health: ${(err as Error).message}`);
    return { enabled: true, contractVersion: ACHIEVEMENTS_CONTRACT_VERSION };
  }
}
