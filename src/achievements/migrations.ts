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

export const ACHIEVEMENTS_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'requests: the global-requests surface',
    // The global-requests door (a sibling surface, not an achievement) stores
    // its rows HERE: the boards table is achievements.db's, and a second
    // database would be a second place a board key has to be right. Every
    // statement is CREATE TABLE / CREATE INDEX IF NOT EXISTS, so a re-run on a
    // database that already has these tables is a no-op - which is what makes
    // this step idempotent against the live achievements.db.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS requests (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          kind           TEXT NOT NULL CHECK (kind IN ('release','art')),
          title          TEXT NOT NULL,
          notes          TEXT NOT NULL DEFAULT '',
          board_id       TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          handle         TEXT NOT NULL,          -- the BBS handle, as the door read it
          handle_key     TEXT NOT NULL,          -- lower(trim(handle)); the identity
          state          TEXT NOT NULL DEFAULT 'open'
                         CHECK (state IN ('open','claimed','done','withdrawn')),
          claim_board_id TEXT,
          claim_handle   TEXT,
          claim_handle_key TEXT,
          claimed_at     INTEGER,
          done_note      TEXT,
          done_at        INTEGER,
          votes          INTEGER NOT NULL DEFAULT 0,   -- denormalised: the list never aggregates
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL
        )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_requests_open ON requests(state, kind, votes DESC, updated_at DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_requests_author ON requests(board_id, handle_key)');

      db.exec(`
        CREATE TABLE IF NOT EXISTS request_votes (
          request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
          board_id   TEXT NOT NULL,
          handle_key TEXT NOT NULL,
          at         INTEGER NOT NULL,
          PRIMARY KEY (request_id, board_id, handle_key)   -- idempotent votes, by construction
        )`);
    },
  },
];
