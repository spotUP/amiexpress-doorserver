/**
 * Forward-only migrations for releases.db.
 *
 * Empty at birth, and that is correct: schema.sql creates a database that
 * does not exist yet, and the first entry is added the first time a column
 * is added after the first import. The RUNNER (runMigrations) is shared with
 * every other database; the ARRAY is per-database, so versions here never
 * collide with doors.db or achievements.db (D5).
 */
import type { Migration } from '../migrations';

export const RELEASES_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'release_files group columns',
    // Which scene group released it, denormalised from release_groups at
    // import time so reads never touch doors.db. A live releases.db from the
    // first import gains the columns here; values land on the next import
    // (the importer upserts every row).
    up: (db) => {
      for (const col of ['release_group TEXT', 'release_group_full TEXT']) {
        const name = col.split(' ')[0];
        const has = (
          db.prepare('PRAGMA table_info(release_files)').all() as { name: string }[]
        ).some((r) => r.name === name);
        if (!has) db.exec(`ALTER TABLE release_files ADD COLUMN ${col}`);
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_release_files_group ON release_files(release_group)');
    },
  },
];
