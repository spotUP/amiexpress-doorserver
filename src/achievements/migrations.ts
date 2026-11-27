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
    // callers to Discord. Both default off; createBoard sets discord_mirror = 1 since 2026-11-11.
    up: (db) => {
      db.exec('ALTER TABLE boards ADD COLUMN chat_relay INTEGER NOT NULL DEFAULT 0');
      db.exec('ALTER TABLE boards ADD COLUMN discord_mirror INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 12,
    name: 'chat: chat_canvas holds the shared 80x24 cell canvas of an art room',
    // /draw is art rooms only. One row per room, created lazily on the first
    // read or post; cells = 80*24*3 bytes (char, fg<<4|bg, flags with bit 0 =
    // blink). It lives until the room row is deleted (ON DELETE CASCADE).
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS chat_canvas (
          room_id TEXT PRIMARY KEY REFERENCES chat_rooms(id) ON DELETE CASCADE,
          rev INTEGER NOT NULL DEFAULT 0,
          cells BLOB NOT NULL,
          updated_at INTEGER NOT NULL)`);
    },
  },
  {
    version: 13,
    name: 'chat: chat_files holds the files shared in a room (blobs live in CHAT_FILES_DIR)',
    // One row per upload. `uploading` rows have a <id>.part blob, `ready` rows
    // a <blob_id>.bin (blob_id differs from id when identical bytes in the
    // same room were linked to an existing blob). `deleted` rows stay for
    // moderation audit until the sweeper drops them. relay = 1: the upload was
    // made by a relay board `as` a user, so only the board's quota was charged.
    // img_w / img_h are filled by a later task and stay NULL until then.
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS chat_files (
          id          TEXT PRIMARY KEY,
          room_id     TEXT NOT NULL REFERENCES chat_rooms(id),
          board_id    TEXT NOT NULL,
          uploader    TEXT NOT NULL COLLATE NOCASE,
          name        TEXT NOT NULL,
          orig_name   TEXT NOT NULL,
          size        INTEGER NOT NULL,
          received    INTEGER NOT NULL DEFAULT 0,
          sha256      TEXT,
          kind        TEXT,
          status      TEXT NOT NULL,
          client_id   TEXT NOT NULL DEFAULT '',
          blob_id     TEXT,
          relay       INTEGER NOT NULL DEFAULT 0,
          img_w       INTEGER,
          img_h       INTEGER,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          deleted_at  INTEGER,
          deleted_by  TEXT,
          deleted_why TEXT)`);
      db.exec('CREATE INDEX IF NOT EXISTS chat_files_room ON chat_files(room_id, status, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS chat_files_expiry ON chat_files(status, expires_at)');
    },
  },
  {
    version: 14,
    name: 'chat: chat_memberships keeps a user in a room across sessions, with a last-read marker',
    // chat_members is per session and goes when the session expires;
    // chat_memberships is per (user, room) and goes only on an explicit leave,
    // a kick or ban, or when the room is deleted. last_read_seq is a chat_messages.seq.
    // Existing members are backfilled with the room's current head so nobody
    // starts with a pile of unread. chat_presence.auto = 1 marks the `away`
    // the hub set itself when a user's last session expired.
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS chat_memberships (
          user TEXT NOT NULL COLLATE NOCASE,
          room_id TEXT NOT NULL,
          last_read_seq INTEGER NOT NULL DEFAULT 0,
          joined_at INTEGER NOT NULL,
          PRIMARY KEY (user, room_id))`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_chat_memberships_room ON chat_memberships(room_id)');
      db.exec(`INSERT OR IGNORE INTO chat_memberships (user, room_id, last_read_seq, joined_at)
          SELECT m.user, m.room_id,
                 COALESCE((SELECT MAX(seq) FROM chat_messages c WHERE c.room_id = m.room_id AND c.thread_id IS NULL), 0),
                 MIN(m.joined_at)
            FROM chat_members m GROUP BY m.user, m.room_id`);
      const cols = db.prepare('PRAGMA table_info(chat_presence)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'auto')) db.exec('ALTER TABLE chat_presence ADD COLUMN auto INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 15,
    name: 'partyline: boards.plp_key holds the PLP/1 login key derived from the board secret',
    // The scrypt hash cannot drive a challenge-response, so PLP/1 (docs/PARTYLINE-PROTOCOL.md)
    // keys its HMAC with HMAC-SHA256(secret, "PLP/1 board key"): a leaked row lets someone
    // log in to Partyline as that board, never call /chat/v1 or /achievements/v1 with it.
    // NULL until the board's next verified request or key mint (src/achievements/boards.ts).
    up: (db) => {
      const cols = db.prepare('PRAGMA table_info(boards)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'plp_key')) db.exec('ALTER TABLE boards ADD COLUMN plp_key TEXT');
    },
  },
  {
    version: 16,
    name: 'chat: chat_prefs keeps a caller\'s door preferences per handle@BOARD',
    // One JSON object per chat identity; the LIVECHAT door sends it whole (chat:prefs-set) and reads it back on open (chat:prefs).
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS chat_prefs (
          user TEXT PRIMARY KEY COLLATE NOCASE,
          json TEXT NOT NULL,
          updated_at INTEGER NOT NULL)`);
    },
  },
  {
    version: 17,
    name: 'chat: discord_links (a sysop-requested Discord channel linked to the shared room) and discord_app',
    // No approval step: a request is `linked` at once; the bridge writes
    // `failed` plus `error` when it cannot see the channel or create a webhook.
    // One live (linked) row per channel; a failed channel may be requested again.
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS discord_links (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          room         TEXT NOT NULL,
          channel_id   TEXT NOT NULL,
          board_id     TEXT NOT NULL,
          status       TEXT NOT NULL CHECK (status IN ('linked','failed')),
          requested_by TEXT NOT NULL,
          requested_at INTEGER NOT NULL,
          error        TEXT)`);
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS discord_links_live ON discord_links(channel_id) WHERE status = 'linked'");
      db.exec('CREATE INDEX IF NOT EXISTS discord_links_board ON discord_links(board_id)');
      db.exec('CREATE TABLE IF NOT EXISTS discord_app (id INTEGER PRIMARY KEY CHECK (id = 1), application_id TEXT NOT NULL, at INTEGER NOT NULL)');
    },
  },
  {
    version: 18,
    name: 'chat: chat_files may belong to a direct-message thread (room_id NULL, dm_thread set)',
    // room_id was NOT NULL, so the table is rebuilt. Room files copy over unchanged.
    up: (db) => {
      db.exec(`CREATE TABLE chat_files_new (
          id          TEXT PRIMARY KEY,
          room_id     TEXT REFERENCES chat_rooms(id),
          dm_thread   TEXT,
          board_id    TEXT NOT NULL,
          uploader    TEXT NOT NULL COLLATE NOCASE,
          name        TEXT NOT NULL,
          orig_name   TEXT NOT NULL,
          size        INTEGER NOT NULL,
          received    INTEGER NOT NULL DEFAULT 0,
          sha256      TEXT,
          kind        TEXT,
          status      TEXT NOT NULL,
          client_id   TEXT NOT NULL DEFAULT '',
          blob_id     TEXT,
          relay       INTEGER NOT NULL DEFAULT 0,
          img_w       INTEGER,
          img_h       INTEGER,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          deleted_at  INTEGER,
          deleted_by  TEXT,
          deleted_why TEXT)`);
      db.exec(`INSERT INTO chat_files_new (id, room_id, board_id, uploader, name, orig_name, size, received, sha256, kind, status, client_id, blob_id, relay, img_w, img_h, created_at, updated_at, expires_at, deleted_at, deleted_by, deleted_why)
               SELECT id, room_id, board_id, uploader, name, orig_name, size, received, sha256, kind, status, client_id, blob_id, relay, img_w, img_h, created_at, updated_at, expires_at, deleted_at, deleted_by, deleted_why FROM chat_files`);
      db.exec('DROP TABLE chat_files');
      db.exec('ALTER TABLE chat_files_new RENAME TO chat_files');
      db.exec('CREATE INDEX IF NOT EXISTS chat_files_room ON chat_files(room_id, status, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS chat_files_dm ON chat_files(dm_thread, status, created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS chat_files_expiry ON chat_files(status, expires_at)');
    },
  },
  {
    version: 19,
    name: 'chat: chat_memberships.last_active, when the user last typed or sent (active/inactive presence dot)',
    up: (db) => {
      db.exec('ALTER TABLE chat_memberships ADD COLUMN last_active INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 20,
    name: 'chat: chat_settings, hub-wide chat settings the admin panel sets (active window)',
    up: (db) => {
      db.exec('CREATE TABLE IF NOT EXISTS chat_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    },
  },
  {
    version: 21,
    name: 'chat: chat_rooms.archived_at, when a sysop archived the room (hidden, history kept)',
    // LiveChat's Archive Channel hides a channel from every list but keeps its
    // messages and files; deleted_at alone cannot tell an archive from a delete.
    up: (db) => {
      db.exec('ALTER TABLE chat_rooms ADD COLUMN archived_at INTEGER');
    },
  },
  {
    version: 22,
    name: 'chat: chat_sessions.pl_room and pl_canvas, the Partyline room and /draw mode a resume returns to',
    // The screen lives in the hub process; a restart loses it while the session row stays.
    // LIVECHAT keeps its room and canvas across a socket reconnect, so a resume must too.
    up: (db) => {
      db.exec("ALTER TABLE chat_sessions ADD COLUMN pl_room TEXT NOT NULL DEFAULT ''");
      db.exec('ALTER TABLE chat_sessions ADD COLUMN pl_canvas INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 23,
    name: 'chat: chat_user_notes, the Partyline Add Note store shared by telnet, web and Amiga',
    // The reference chat wrote notes into one board's account editor; Partyline callers come
    // from many boards and clients, so the hub keeps one store all of them read.
    up: (db) => {
      db.exec(`CREATE TABLE chat_user_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        board_id TEXT NOT NULL DEFAULT '',
        target TEXT NOT NULL,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      db.exec('CREATE INDEX chat_user_notes_target ON chat_user_notes (lower(target))');
    },
  },
  {
    version: 24,
    name: 'chat: chat_bots, the users a board opened as a bot (shown as [BOT] <handle>, handle reserved)',
    // Kept apart from chat_sessions: a bot's history and its reserved handle outlive its session.
    up: (db) => {
      db.exec('CREATE TABLE chat_bots (user TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
    },
  },
  {
    version: 25,
    name: 'accounts: players become the one Partyline identity (password, profile, bot), plus board links, tokens and reset codes',
    // D7: no second table. A player without a password (pw_hash '') is an achievements-only
    // player; it becomes a chat account through the emailed password reset.
    up: (db) => {
      db.exec("ALTER TABLE players ADD COLUMN pw_hash TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE players ADD COLUMN realname TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE players ADD COLUMN location TEXT NOT NULL DEFAULT ''");
      db.exec('ALTER TABLE players ADD COLUMN bot INTEGER NOT NULL DEFAULT 0');
      db.exec(`CREATE TABLE account_links (
        board_id TEXT NOT NULL,
        bbs_user TEXT NOT NULL,
        account_id INTEGER NOT NULL REFERENCES players(id),
        linked_at INTEGER NOT NULL,
        PRIMARY KEY (board_id, bbs_user)
      )`);
      db.exec('CREATE INDEX account_links_account ON account_links (account_id)');
      db.exec(`CREATE TABLE account_tokens (
        token_hash TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES players(id),
        created_at INTEGER NOT NULL
      )`);
      db.exec(`CREATE TABLE account_reset_codes (
        account_id INTEGER PRIMARY KEY REFERENCES players(id),
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      )`);
    },
  },
  {
    version: 26,
    name: 'accounts: account tokens expire 30 days after their last use (D10)',
    // Tokens issued before this get a fresh 30 days, so nobody is logged out by the upgrade.
    up: (db) => {
      db.exec('ALTER TABLE account_tokens ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
      db.exec("UPDATE account_tokens SET expires_at = CAST(strftime('%s','now') AS INTEGER) + 30 * 24 * 3600");
    },
  },
];
