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
  {
    version: 2,
    name: 'chat: the federated live-chat surface',
    // Rooms, sessions, messages, direct messages, the event log, roles, pins
    // and emoji. Every statement is IF NOT EXISTS, so a re-run against a
    // database that already has them is a no-op (the step is idempotent
    // against the live achievements.db, like step 1). User columns are
    // COLLATE NOCASE: identity is handle@BOARD and a handle's case is not an
    // identity. chat_messages.seq and chat_dm_messages.seq equal the seq of
    // the event that announced the message, which is what history paging and
    // the "seq" field of every reply read.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_rooms (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          name_key    TEXT NOT NULL UNIQUE,
          owner_board TEXT NOT NULL,
          owner_user  TEXT NOT NULL COLLATE NOCASE,
          topic       TEXT NOT NULL DEFAULT '',
          visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
          created_at  INTEGER NOT NULL,
          deleted_at  INTEGER
        )`);
      db.exec(`CREATE TABLE IF NOT EXISTS chat_room_ops (
          room_id TEXT NOT NULL, user TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (room_id, user))`);
      db.exec(`CREATE TABLE IF NOT EXISTS chat_invites (
          room_id TEXT NOT NULL, user TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (room_id, user))`);
      db.exec(`CREATE TABLE IF NOT EXISTS chat_bans (
          room_id TEXT NOT NULL, user TEXT NOT NULL COLLATE NOCASE, reason TEXT NOT NULL DEFAULT '',
          by_user TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (room_id, user))`);
      db.exec(`CREATE TABLE IF NOT EXISTS chat_mutes (
          room_id TEXT NOT NULL, user TEXT NOT NULL COLLATE NOCASE, until INTEGER,
          by_user TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (room_id, user))`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          sid        TEXT PRIMARY KEY,
          board_id   TEXT NOT NULL,
          handle     TEXT NOT NULL,
          user       TEXT NOT NULL COLLATE NOCASE,
          sysop      INTEGER NOT NULL DEFAULT 0,
          client     TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          last_seen  INTEGER NOT NULL
        )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_sessions_board ON chat_sessions(board_id)');
      db.exec(`CREATE TABLE IF NOT EXISTS chat_members (
          room_id TEXT NOT NULL, sid TEXT NOT NULL, user TEXT NOT NULL COLLATE NOCASE,
          joined_at INTEGER NOT NULL, PRIMARY KEY (room_id, sid))`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_members_sid ON chat_members(sid)');
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id         TEXT PRIMARY KEY,
          seq        INTEGER NOT NULL,
          room_id    TEXT NOT NULL,
          user       TEXT NOT NULL COLLATE NOCASE,
          content    TEXT NOT NULL,
          client_id  TEXT NOT NULL,
          reply_to   TEXT,
          thread_id  TEXT,
          created_at INTEGER NOT NULL,
          edited_at  INTEGER,
          deleted_at INTEGER,
          UNIQUE (room_id, user, client_id)
        )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_room ON chat_messages(room_id, seq)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, seq)');
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_dm_messages (
          id         TEXT PRIMARY KEY,
          seq        INTEGER NOT NULL,
          thread_id  TEXT NOT NULL,
          dm_a       TEXT NOT NULL COLLATE NOCASE,
          dm_b       TEXT NOT NULL COLLATE NOCASE,
          sender     TEXT NOT NULL COLLATE NOCASE,
          content    TEXT NOT NULL,
          client_id  TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          read_at    INTEGER,
          UNIQUE (sender, client_id)
        )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_dm_thread ON chat_dm_messages(thread_id, seq)');
      db.exec(`CREATE TABLE IF NOT EXISTS chat_reactions (
          message_id TEXT NOT NULL, user TEXT NOT NULL COLLATE NOCASE, emoji TEXT NOT NULL,
          at INTEGER NOT NULL, PRIMARY KEY (message_id, user, emoji))`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_events (
          seq       INTEGER PRIMARY KEY AUTOINCREMENT,
          type      TEXT NOT NULL,
          room_id   TEXT,
          label     TEXT NOT NULL DEFAULT '',
          user      TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
          ref       TEXT NOT NULL DEFAULT '',
          at        INTEGER NOT NULL,
          text      TEXT NOT NULL DEFAULT '',
          dm_a      TEXT COLLATE NOCASE,
          dm_b      TEXT COLLATE NOCASE
        )`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_roles (
          id         TEXT PRIMARY KEY,
          board_id   TEXT NOT NULL,
          name       TEXT NOT NULL,
          color_hex  TEXT NOT NULL,
          color_ansi INTEGER NOT NULL,
          position   INTEGER NOT NULL DEFAULT 0,
          perms      TEXT NOT NULL DEFAULT '{}'
        )`);
      db.exec(`CREATE TABLE IF NOT EXISTS chat_role_assignments (
          role_id TEXT NOT NULL, board_id TEXT NOT NULL, handle TEXT NOT NULL COLLATE NOCASE,
          PRIMARY KEY (role_id, handle))`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_assign_handle ON chat_role_assignments(board_id, handle)');
      db.exec(`CREATE TABLE IF NOT EXISTS chat_pins (
          room_id TEXT NOT NULL, message_id TEXT NOT NULL, pinned_by TEXT NOT NULL, at INTEGER NOT NULL,
          PRIMARY KEY (room_id, message_id))`);
      db.exec(`CREATE TABLE IF NOT EXISTS chat_emoji (
          board_id TEXT NOT NULL, name TEXT NOT NULL, data_url TEXT NOT NULL, PRIMARY KEY (board_id, name))`);
      db.exec(`CREATE TABLE IF NOT EXISTS chat_motd (
          id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL DEFAULT '')`);
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
          content, content='chat_messages', content_rowid='rowid')`);
    },
  },
  {
    version: 3,
    name: 'chat: presence status and per-identity ignore list',
    // chat_presence: one row per user while any session of that user lives
    // (a missing row means online with no text); the row goes when the last
    // session ends. chat_ignores: the ignore list of a chat identity, kept
    // across sessions; the server only stores it, doors do the filtering.
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS chat_presence (
          user TEXT PRIMARY KEY COLLATE NOCASE,
          status TEXT NOT NULL,
          text TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL)`);
      db.exec(`CREATE TABLE IF NOT EXISTS chat_ignores (
          owner TEXT NOT NULL COLLATE NOCASE,
          target TEXT NOT NULL COLLATE NOCASE,
          at INTEGER NOT NULL,
          PRIMARY KEY (owner, target))`);
    },
  },
];
