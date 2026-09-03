/**
 * Forward-only schema migrations for achievements.db.
 *
 * A SECOND array, not a second runner (D5): runMigrations(db, migrations) in
 * src/migrations.ts is already parameterised by the array and creates its own
 * schema_migrations table in whatever database it is handed. The door repo's
 * MIGRATIONS must never run here - its steps ALTER TABLE door_catalog, which
 * does not exist in this file and never will.
 *
 * Empty at birth, and that is correct: schema.sql creates a database that
 * does not exist yet. The first entry is added the first time a column is
 * added AFTER the first deploy - a live achievements.db is a hand-seeded
 * volume like doors.db, and a column that exists only in schema.sql exists
 * only on a fresh install.
 *
 * The two version counters are independent. This array starts at 1 again,
 * and a test asserts its versions are unique and ascending so a second entry
 * cannot collide with the first.
 */
import type { Migration } from '../migrations';

export const ACHIEVEMENTS_MIGRATIONS: Migration[] = [];
