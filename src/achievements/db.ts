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

export function openAchievementsDb(
  ach: AchievementsConfig,
  opts?: { readonly?: boolean }
): Database.Database {
  return new Database(ach.dbPath, { readonly: opts?.readonly ?? false });
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
 * migrations. Returns the names of the migrations that actually ran, so
 * startup can report them - the same contract runMigrations() has.
 */
export function initAchievementsDb(ach: AchievementsConfig): string[] {
  const db = openAchievementsDb(ach);
  try {
    applyAchievementsSchema(db);
    return runMigrations(db, ACHIEVEMENTS_MIGRATIONS);
  } finally {
    db.close();
  }
}
