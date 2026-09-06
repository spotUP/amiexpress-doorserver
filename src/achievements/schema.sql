-- The achievements database.
--
-- A SECOND SQLite file (ACHIEVEMENTS_DB), never doors.db: the catalog
-- database is rebuilt and re-indexed by the corpus tooling, and player data
-- must never sit inside something a re-index may touch. Nothing in this file
-- names a door-repo table, and a test asserts doors.db's table list is
-- unchanged after a full achievements run.
--
-- CREATE TABLE IF NOT EXISTS throughout, in the shape src/schema.sql already
-- uses: this file creates tables that do not exist yet and cannot change one
-- that does. Every column added after the first deploy is a numbered step in
-- src/achievements/migrations.ts, run by the SAME runMigrations() the door
-- repo uses against its OWN version counter (D5).

CREATE TABLE IF NOT EXISTS boards (
  id           TEXT PRIMARY KEY,             -- 'uprough'; also the ref prefix
  name         TEXT NOT NULL,
  contact      TEXT,
  key_hash     TEXT NOT NULL,                -- scrypt$..., src/auth.ts
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  suspended_at INTEGER
);

CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email_key   TEXT NOT NULL UNIQUE,          -- lower(trim(email)); the identity
  email       TEXT NOT NULL,                 -- as given, for the mail envelope
  handle      TEXT NOT NULL,
  verified_at INTEGER,
  private     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_handle ON players(handle COLLATE NOCASE);

-- One live code per kind per player. A new code REPLACES the old one, which
-- is what makes "resend" and "rotate" the same operation.
CREATE TABLE IF NOT EXISTS player_codes (
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('verify','link')),
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used_at    INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (player_id, kind)
);

CREATE TABLE IF NOT EXISTS links (
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  linked_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (board_id, player_id)
);

-- Append-only. The PK is the idempotency rule: a resent ref is a duplicate
-- by construction, not by a lookup somebody might forget to write.
CREATE TABLE IF NOT EXISTS events (
  board_id    TEXT NOT NULL,
  ref         TEXT NOT NULL,
  player_id   INTEGER NOT NULL,
  type        TEXT NOT NULL,
  key         TEXT,
  value       REAL NOT NULL DEFAULT 1,
  at          INTEGER NOT NULL,              -- CLAMPED, UTC epoch seconds
  received_at INTEGER NOT NULL,
  clamped     INTEGER NOT NULL DEFAULT 0,
  door        TEXT,
  client      TEXT,
  PRIMARY KEY (board_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_events_player_type_at ON events(player_id, type, at);

-- count / sum / first. Every event writes BOTH the keyless row (key = '')
-- and its keyed row, so a keyless rule never has to sum across keys.
CREATE TABLE IF NOT EXISTS counters (
  player_id INTEGER NOT NULL,
  type      TEXT NOT NULL,
  key       TEXT NOT NULL DEFAULT '',
  n         INTEGER NOT NULL DEFAULT 0,
  sum_value REAL NOT NULL DEFAULT 0,
  first_at  INTEGER,
  last_at   INTEGER,
  PRIMARY KEY (player_id, type, key)
);

-- distinct. grp = '' is the ungrouped row; grp = <event key> is the
-- key-grouped row, which is the only grouping the spec's rules use.
CREATE TABLE IF NOT EXISTS counter_dims (
  player_id INTEGER NOT NULL,
  type      TEXT NOT NULL,
  dim       TEXT NOT NULL,                   -- 'key' | 'board'
  grp       TEXT NOT NULL DEFAULT '',
  dim_value TEXT NOT NULL,
  first_at  INTEGER NOT NULL,
  PRIMARY KEY (player_id, type, dim, grp, dim_value)
);

-- streak. UTC calendar days, from the CLAMPED timestamp.
CREATE TABLE IF NOT EXISTS counter_days (
  player_id INTEGER NOT NULL,
  type      TEXT NOT NULL,
  day       TEXT NOT NULL,                   -- 'YYYY-MM-DD'
  PRIMARY KEY (player_id, type, day)
);

-- stat.snapshot, stored as max(existing, value). name = the counter type.
CREATE TABLE IF NOT EXISTS snapshots (
  player_id  INTEGER NOT NULL,
  name       TEXT NOT NULL,
  value      REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, name)
);

CREATE TABLE IF NOT EXISTS achievements (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  family      TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('bronze','silver','gold','platinum')),
  points      INTEGER NOT NULL,
  hidden      INTEGER NOT NULL DEFAULT 0,
  rule        TEXT NOT NULL,                 -- JSON, the operator
  digest      TEXT NOT NULL,                 -- sha256 over the definition (D8)
  source      TEXT NOT NULL,                 -- 'seed' | 'door:<command>'
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- The candidate index: which achievements can a given event type possibly
-- move. Without it every event scans the whole catalog.
CREATE TABLE IF NOT EXISTS achievement_types (
  achievement_id TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  PRIMARY KEY (achievement_id, type)
);
CREATE INDEX IF NOT EXISTS idx_achievement_types_type ON achievement_types(type);

CREATE TABLE IF NOT EXISTS unlocks (
  player_id      INTEGER NOT NULL,
  achievement_id TEXT NOT NULL,
  board_id       TEXT NOT NULL,              -- where it happened; never NULL
  season_id      TEXT NOT NULL,
  at             INTEGER NOT NULL,
  PRIMARY KEY (player_id, achievement_id)
);
CREATE INDEX IF NOT EXISTS idx_unlocks_ach ON unlocks(achievement_id);
CREATE INDEX IF NOT EXISTS idx_unlocks_board ON unlocks(board_id);
CREATE INDEX IF NOT EXISTS idx_unlocks_season ON unlocks(season_id);

CREATE TABLE IF NOT EXISTS seasons (
  id        TEXT PRIMARY KEY,                -- '2026Q3'
  starts_at INTEGER NOT NULL,
  ends_at   INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS rarity (
  achievement_id TEXT PRIMARY KEY,
  unlocked       INTEGER NOT NULL,
  verified       INTEGER NOT NULL,
  pct_tenths     INTEGER NOT NULL,           -- 81 = 8.1%; integers for C89
  bucket         TEXT NOT NULL,
  computed_at    INTEGER NOT NULL
);

-- A queue row has THREE states, not two: pending, sent, and given up on.
-- failed_at is what makes the third one representable. Without it the only
-- ways to stop retrying a dead address would be to set sent_at (a lie, and
-- the column a sysop reads to see what went out) or to push next_at into
-- the far future (a row that is pending for ever, inflating the one number
-- - pendingMail - that tells a sysop mail is broken). See src/achievements/
-- mail.ts for the backoff ladder and the three-day give-up.
--
-- This column is in schema.sql rather than in a migration because
-- achievements.db has never been deployed anywhere (AC-21 is the deploy
-- task) and no such file exists: there is no live database for a migration
-- to alter, and src/schema.sql sets the same precedent - it is the ORIGINAL
-- schema, and src/migrations.ts carries everything added after a deploy.
CREATE TABLE IF NOT EXISTS mail_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  sent_at    INTEGER,
  failed_at  INTEGER,                       -- gave up; never retried again
  last_error TEXT
);
-- The drain's own WHERE clause, in order: pending, not given up on, due.
CREATE INDEX IF NOT EXISTS idx_mail_due ON mail_queue(sent_at, failed_at, next_at);

CREATE TABLE IF NOT EXISTS door_catalog_digests (
  door       TEXT PRIMARY KEY,
  digest     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS board_audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT,
  action   TEXT NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_board_audit_at ON board_audit(at);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
