/**
 * The only place that opens achievements.db.
 *
 * Mirrors src/db.ts exactly - openDb/applySchema against a config the caller
 * was handed - so there is one shape to learn and not two. The one thing
 * that is deliberately NOT shared is the migration array: runMigrations()
 * creates schema_migrations in whatever database it is given, so the RUNNER
 * is reused verbatim while this database keeps its own version counter (D5).
 * Running the door repo's MIGRATIONS here would try to ALTER TABLE
 * door_catalog inside a file that has never heard of it.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { runMigrations } from '../migrations';
import { ACHIEVEMENTS_MIGRATIONS } from './migrations';
import type { AchievementsConfig } from './config';
import { loadSeed, seedCatalog } from './catalog';
import type { Seed } from './catalog';

export function openAchievementsDb(
  ach: AchievementsConfig,
  opts?: { readonly?: boolean }
): Database.Database {
  return new Database(ach.dbPath, { readonly: opts?.readonly ?? false });
}

/**
 * Open, run, close - the shape every request-scoped read and write uses, so
 * a handle can never be left open by an early return or a throw. This is the
 * same per-request open src/auth.ts's requireAdmin already does against
 * doors.db: opening a local SQLite file is cheap, and one long-lived shared
 * handle would be a second thing to reason about across Express's async
 * boundaries.
 */
export function withAchievementsDb<T>(
  ach: AchievementsConfig,
  fn: (db: Database.Database) => T,
  opts?: { readonly?: boolean }
): T {
  const db = openAchievementsDb(ach, opts);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * schema.sql sits beside this module in BOTH layouts - src/achievements/ from
 * source, dist/src/achievements/ compiled - because tsc does not emit .sql
 * and package.json's build script copies it. Without that copy the container
 * starts and dies here on readFileSync, which is exactly the failure the
 * Dockerfile already records for src/lha.js.
 */
export function applyAchievementsSchema(db: Database.Database): void {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));
}

/**
 * Create the file if it does not exist, apply the schema, run the
 * migrations, seed the catalog. Returns the names of the migrations that
 * actually ran, so startup can report them - the same contract
 * runMigrations() has.
 *
 * `seed` is the shipped file by default; a suite that defines its own
 * catalog passes null and starts empty, and the seed suite passes the file.
 */
export function initAchievementsDb(
  ach: AchievementsConfig,
  opts: { seed?: Seed | null } = {}
): string[] {
  const db = openAchievementsDb(ach);
  try {
    applyAchievementsSchema(db);
    const ran = runMigrations(db, ACHIEVEMENTS_MIGRATIONS);
    const seed = opts.seed === undefined ? loadSeed() : opts.seed;
    if (seed) {
      const r = seedCatalog(db, seed);
      if (r.inserted.length > 0) console.log(`[INFO] achievements: seeded ${r.inserted.length} achievements`);
    }
    return ran;
  } finally {
    db.close();
  }
}
