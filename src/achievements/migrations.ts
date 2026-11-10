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

/**
 * Mark every board that has ever used chat as already announced, so the
 * board_joined event fires only for boards that first chat AFTER this ships.
 * Evidence of past use: a live session row, or a chat identity (`handle@BOARD`)
 * in messages or events (sessions are swept, so rows alone under-count).
 */
export function backfillChatFirstSeen(db: import('better-sqlite3').Database): void {
  db.exec(`UPDATE boards SET chat_first_seen_at = CAST(strftime('%s','now') AS INTEGER)
    WHERE chat_first_seen_at IS NULL AND (
      id IN (SELECT board_id FROM chat_sessions)
      OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.user LIKE '%@' || upper(boards.id))
      OR EXISTS (SELECT 1 FROM chat_events e WHERE e.user LIKE '%@' || upper(boards.id)))`);
}

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
  {
    version: 4,
    name: 'chat: boards.chat_first_seen_at marks the first chat session of a board',
    // NULL = the board has never opened a chat session; the first one sets it
    // (atomically, in createSession) and announces board_joined. Boards that
    // already chatted are backfilled so deploying announces nobody.
    up: (db) => {
      db.exec('ALTER TABLE boards ADD COLUMN chat_first_seen_at INTEGER');
      backfillChatFirstSeen(db);
    },
  },
  {
    version: 5,
    name: 'chat: custom emoji carry a display glyph and an ascii fallback',
    // The TS LiveChat door stores {name, display, ascii}; the image shape
    // (data_url) stays. A row has one shape or the other, the unused columns are ''.
    up: (db) => {
      db.exec("ALTER TABLE chat_emoji ADD COLUMN display TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE chat_emoji ADD COLUMN ascii TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 6,
    name: 'chat: chat_events.board_id scopes board-local events',
    // A board relays its own BBS activity (logins, uploads, doors) as `bbs`
    // events; only sessions of that board see them, as the TS LiveChat door
    // only hears its own backend. NULL = an event of the whole federation.
    up: (db) => {
      db.exec('ALTER TABLE chat_events ADD COLUMN board_id TEXT');
    },
  },
  {
    version: 7,
    name: 'chat: chat_rooms.motd holds a per-room message of the day',
    // The TS LiveChat door's /motd sets a message for one room, shown on
    // join and broadcast to its members; the board-wide chat_motd stays.
    up: (db) => {
      db.exec("ALTER TABLE chat_rooms ADD COLUMN motd TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 8,
    name: 'chat: chat_rooms.kind records whether a room is text, voice or art',
    // Creating a channel now asks for its type. Rooms made before this were
    // plain chat, except the TS door's drawing rooms, which it marked only by
    // an "art:" name prefix; those become kind 'art'.
    up: (db) => {
      db.exec("ALTER TABLE chat_rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
      db.exec("UPDATE chat_rooms SET kind = 'art' WHERE name_key LIKE 'art:%'");
    },
  },
  {
    version: 9,
    name: 'chat: room modes +m (moderated) and +v (voiced users)',
    // The TS LiveChat door's /mode sets IRC-style room modes. +i maps onto the
    // existing private visibility (a private room already needs an invite) and
    // +o/+b onto ops and mutes; +m and +v had no home, so they get one here.
    up: (db) => {
      db.exec('ALTER TABLE chat_rooms ADD COLUMN moderated INTEGER NOT NULL DEFAULT 0');
      db.exec(`CREATE TABLE IF NOT EXISTS chat_room_voices (
          room_id TEXT NOT NULL, user TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (room_id, user))`);
    },
  },
  {
    version: 10,
    name: 'chat: chat_dm_members holds the members of a group direct message',
    // A group DM thread ('dg' + hash of its members) keeps its rows in
    // chat_dm_messages with empty dm_a/dm_b; who may read it lives here.
    // 1:1 threads stay pairwise and are not backfilled.
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS chat_dm_members (
          thread_id TEXT NOT NULL, user TEXT NOT NULL COLLATE NOCASE,
          last_read_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (thread_id, user))`);
    },
  },
  {
    version: 11,
    name: 'chat: boards.chat_relay (relay board may post as its own users) and boards.discord_mirror',
    // chat_relay is set by the server admin only: a relay board's session may
    // post, edit, delete and react with an `as` handle (user = as@<board>),
    // which is how the Discord bridge speaks for many Discord users through
    // one session. discord_mirror is each board's own opt-in (sysop command
    // /discord on|off): off means the bridge never copies that board's
    // callers to Discord. Both default off.
    up: (db) => {
      db.exec('ALTER TABLE boards ADD COLUMN chat_relay INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE boards ADD COLUMN discord_mirror INTEGER NOT NULL DEFAULT 0');
    },
  },
];
