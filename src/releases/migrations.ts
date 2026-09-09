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

export const RELEASES_MIGRATIONS: Migration[] = [];
