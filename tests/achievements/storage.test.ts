/**
 * AC-2 - the second database: config, open, schema, migrations.
 *
 * Nothing is mounted yet and nothing answers HTTP; these are the storage
 * bones. The test that matters most is the fourth one - a second database
 * file is this whole task's reason to exist, and the proof is doors.db's
 * table list being byte-identical before and after a full achievements run.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { loadConfig, ConfigError } from '../../src/config';
import { createApp } from '../../src/app';
import { openDb, applySchema } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import type { Migration } from '../../src/migrations';
import { initAchievementsDb, openAchievementsDb } from '../../src/achievements/db';
import { ACHIEVEMENTS_MIGRATIONS } from '../../src/achievements/migrations';
import type { AchievementsConfig } from '../../src/achievements/config';

let dir: string;

/** A usable doors.db with one door, so the catalog half is never the fault. */
function seedDoorsDb(dbPath: string, archivesRoot: string): void {
  fs.writeFileSync(dbPath, '');
  const db = openDb({
    dbPath,
    archivesRoot,
    port: 3010,
    adminKeys: [],
    jwtSecret: null,
    learnKey: null,
    achievements: null, releases: null,
  });
  applySchema(db);
  runMigrations(db);
  db.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'ACC-V103.LHA', 'Account Editor', 'XIM', 1700000000)`
  ).run();
  db.close();
}

/** Every object in doors.db, as SQLite itself describes it. */
function schemaObjects(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .prepare("SELECT type, name, COALESCE(sql, '') AS sql FROM sqlite_master ORDER BY type, name")
        .all() as { type: string; name: string; sql: string }[]
    ).map((r) => `${r.type} ${r.name} ${r.sql}`);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-ach-storage-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  seedDoorsDb(path.join(dir, 'doors.db'), path.join(dir, 'Archives'));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const baseEnv = (): NodeJS.ProcessEnv => ({
  DOORSERVER_DB: path.join(dir, 'doors.db'),
  DOOR_ARCHIVES_ROOT: path.join(dir, 'Archives'),
});

const achCfg = (): AchievementsConfig => ({
  dbPath: path.join(dir, 'achievements.db'),
  smtpUrl: 'smtp://127.0.0.1:1',
  mailFrom: 'achievements@example.invalid',
  publicBaseUrl: 'https://doors.example.invalid',
});

describe('the achievements database, as an operator meets it', () => {
  it('a server with no ACHIEVEMENTS_DB still serves the door catalog', async () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.achievements).toBeNull();

    const res = await request(createApp(cfg)).get('/api/door-repo/health');
    expect(res.status).toBe(200);
    expect(res.body.doors).toBe(1);
  });

  it('a set ACHIEVEMENTS_DB whose directory does not exist refuses to start, naming the variable', () => {
    const env = {
      ...baseEnv(),
      ACHIEVEMENTS_DB: path.join(dir, 'no-such-dir', 'achievements.db'),
      ACHIEVEMENTS_SMTP_URL: 'smtp://127.0.0.1:1',
      ACHIEVEMENTS_MAIL_FROM: 'achievements@example.invalid',
    };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/ACHIEVEMENTS_DB/);
  });

  it('a set ACHIEVEMENTS_DB whose file does not exist yet starts, and the file is created', () => {
    // D6: the DIRECTORY must exist, the file must not. A database that is
    // born empty is not a seeded volume.
    const env = {
      ...baseEnv(),
      ACHIEVEMENTS_DB: path.join(dir, 'achievements.db'),
      ACHIEVEMENTS_SMTP_URL: 'smtp://127.0.0.1:1',
      ACHIEVEMENTS_MAIL_FROM: 'achievements@example.invalid',
    };
    expect(fs.existsSync(path.join(dir, 'achievements.db'))).toBe(false);

    const cfg = loadConfig(env);
    expect(cfg.achievements).not.toBeNull();
    initAchievementsDb(cfg.achievements as AchievementsConfig);

    expect(fs.existsSync(path.join(dir, 'achievements.db'))).toBe(true);
  });

  it('ACHIEVEMENTS_DB without ACHIEVEMENTS_SMTP_URL refuses to start, naming the variable', () => {
    const env = {
      ...baseEnv(),
      ACHIEVEMENTS_DB: path.join(dir, 'achievements.db'),
      ACHIEVEMENTS_MAIL_FROM: 'achievements@example.invalid',
    };
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/ACHIEVEMENTS_SMTP_URL/);

    const noFrom = {
      ...baseEnv(),
      ACHIEVEMENTS_DB: path.join(dir, 'achievements.db'),
      ACHIEVEMENTS_SMTP_URL: 'smtp://127.0.0.1:1',
    };
    expect(() => loadConfig(noFrom)).toThrow(/ACHIEVEMENTS_MAIL_FROM/);
  });

  it("initialising the achievements database leaves the door catalog's tables untouched", () => {
    const doorsDbPath = path.join(dir, 'doors.db');
    const before = schemaObjects(doorsDbPath);
    expect(before.length).toBeGreaterThan(0);

    initAchievementsDb(achCfg());

    expect(schemaObjects(doorsDbPath)).toEqual(before);
    // And the converse: not one door-repo table leaked into the new file.
    // By exact name, not by substring - achievements.db legitimately holds a
    // door_catalog_digests table of its own, which is a record of a door's
    // manifest digest and has nothing to do with the door repo's catalog.
    const achTables = schemaObjects(path.join(dir, 'achievements.db'))
      .filter((o) => o.startsWith('table '))
      .map((o) => o.split(' ')[1]);
    expect(achTables).not.toContain('door_catalog');
    expect(achTables).not.toContain('door_catalog_files');
    expect(achTables).toContain('players');
  });

  it('running startup twice applies no migration the second time', () => {
    const ach = achCfg();
    const first = initAchievementsDb(ach);
    const second = initAchievementsDb(ach);

    // The first start applies every migration ACHIEVEMENTS_MIGRATIONS carries,
    // in version order; the second applies none.
    expect(first).toEqual(ACHIEVEMENTS_MIGRATIONS.map((m) => `${m.version}:${m.name}`));
    expect(first[0]).toBe('1:requests: the global-requests surface');
    expect(second).toEqual([]);

    // Prove the RUNNER is genuinely wired to this database and to its own
    // version counter (D5): a probe migration (a version the real array does
    // not use) runs exactly once and is then remembered in achievements.db's
    // own schema_migrations.
    const probe: Migration[] = [
      { version: 9999, name: 'probe', up: (db) => db.exec('CREATE TABLE IF NOT EXISTS probe (x INTEGER)') },
    ];
    const db = openAchievementsDb(ach);
    try {
      expect(runMigrations(db, probe)).toEqual(['9999:probe']);
      expect(runMigrations(db, probe)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('the achievements migration array has unique, ascending versions', () => {
    const versions = ACHIEVEMENTS_MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
  });
});
