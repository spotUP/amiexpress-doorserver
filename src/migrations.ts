/**
 * Forward-only schema migrations.
 *
 * schema.sql creates tables that do not exist yet; it cannot change a table
 * that does. The live catalog is a seeded volume, so every column added
 * after the first deploy needs a migration, and the deploy is unattended -
 * it has to run itself, exactly once, before the server serves anything.
 *
 * Each migration is a numbered, idempotent step recorded in
 * schema_migrations. A step that has already run is skipped; a step that
 * throws stops startup rather than serving a half-migrated catalog.
 */
import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

/** Does `table` already have a column called `column`? */
export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'door_catalog.requires_bbs',
    up: (db) => {
      // Which BBS version a door needs ("/X 3.38+") is the fact a sysop
      // checks before installing it, and it is not the door's own version.
      if (!hasColumn(db, 'door_catalog', 'requires_bbs')) {
        db.exec('ALTER TABLE door_catalog ADD COLUMN requires_bbs TEXT');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_door_catalog_requires ON door_catalog(requires_bbs)');
    },
  },
  {
    version: 2,
    name: 'admin tables: overrides, users, submissions, audit',
    up: (db) => {
      // Per-field human corrections. A row exists only for a field someone
      // touched, so a corpus re-scan can rewrite door_catalog freely and an
      // edit is reverted by DELETEing one row - never by guessing what the
      // scanner would have said. See src/effective.ts.
      db.exec(`
        CREATE TABLE IF NOT EXISTS door_catalog_overrides (
          catalog_id TEXT NOT NULL,
          field      TEXT NOT NULL,
          value      TEXT,
          -- ON DELETE SET NULL: an edit outlives the person who made it.
          -- Deleting an admin must not delete the corrections they made, nor
          -- fail because those corrections exist.
          edited_by  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
          edited_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY (catalog_id, field)
        )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_overrides_edited_at ON door_catalog_overrides(edited_at)');

      // Admins. Passwords are argon2id hashes; the bootstrap account is
      // created from DOORSERVER_ADMIN_KEYS on first start (phase 2).
      db.exec(`
        CREATE TABLE IF NOT EXISTS admin_users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL DEFAULT 'admin',
          created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          last_login_at INTEGER
        )`);

      // Anonymous submissions wait here. The file itself sits in
      // /data/quarantine and is never served until a human approves it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS door_submissions (
          id              TEXT PRIMARY KEY,
          archive_name    TEXT NOT NULL,
          quarantine_path TEXT NOT NULL,
          size            INTEGER NOT NULL,
          md5             TEXT NOT NULL,
          sha256          TEXT NOT NULL,
          submitter_note  TEXT,
          submitter_ip    TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'pending',
          reject_reason   TEXT,
          parsed_name     TEXT,
          parsed_diz      TEXT,
          parsed_files    TEXT,
          created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          decided_by      INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
          decided_at      INTEGER
        )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_status ON door_submissions(status)');

      // Who changed what. Every admin write appends one row.
      db.exec(`
        CREATE TABLE IF NOT EXISTS admin_audit (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          -- The audit trail is the point: it must survive the account it
          -- describes being removed.
          admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
          action   TEXT NOT NULL,
          target   TEXT NOT NULL,
          detail   TEXT,
          at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_audit_at ON admin_audit(at)');
    },
  },
  {
    version: 3,
    name: 'door_hidden',
    up: (db) => {
      // Taking a door out of the repository is not a DELETE. door_catalog is
      // machine-written: the next corpus scan would simply put the row back,
      // and the archive would still be on disk. So a removal is recorded
      // beside the catalog, exactly like an edit - which also makes it
      // reversible and auditable.
      db.exec(`
        CREATE TABLE IF NOT EXISTS door_hidden (
          catalog_id TEXT PRIMARY KEY,
          reason     TEXT,
          hidden_by  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
          hidden_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_hidden_at ON door_hidden(hidden_at)');
    },
  },
  {
    version: 4,
    name: 'release_groups',
    up: (db) => {
      // Abbreviation-to-full-name mapping for release groups.  The catalog
      // stores the short tag (e.g. "SAD"); this table lets admins add the
      // human-readable name ("Sceptic Anti Design") that the UI can show
      // alongside it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS release_groups (
          abbreviation TEXT PRIMARY KEY,
          full_name    TEXT NOT NULL,
          updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        )`);
    },
  },
  {
    version: 5,
    name: 'door_tags',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS door_tags (
          catalog_id TEXT NOT NULL,
          tag        TEXT NOT NULL,
          added_by   INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
          added_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY (catalog_id, tag)
        )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_door_tags_tag ON door_tags(tag)');
    },
  },
];

function appliedVersions(db: Database.Database): Set<number> {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
     )`
  );
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

/**
 * Run every migration this database has not seen, in order. Returns the
 * names of the migrations that actually ran, so startup can report them.
 */
export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): string[] {
  const done = appliedVersions(db);
  const ran: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    const apply = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    });
    apply();
    ran.push(`${m.version}:${m.name}`);
  }
  return ran;
}
