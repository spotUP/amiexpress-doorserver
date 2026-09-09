/**
 * releases.db: own file, own schema, own migrations — doors.db untouched.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { applyReleasesSchema, initReleasesDb, withReleasesDb } from '../../src/releases/db';
import { loadReleasesConfig } from '../../src/releases/config';

describe('releases config', () => {
  it('is null when RELEASES_DB is unset (surface off, door repo unaffected)', () => {
    expect(loadReleasesConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('refuses a directory that does not exist', () => {
    expect(() => loadReleasesConfig({ RELEASES_DB: '/nope/missing/releases.db' } as NodeJS.ProcessEnv)).toThrow(
      /RELEASES_DB/
    );
  });
});

describe('releases db', () => {
  it('creates the file, schema and an empty migration run', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-rel-'));
    try {
      const rel = { dbPath: path.join(dir, 'releases.db') };
      expect(initReleasesDb(rel)).toEqual(['1:release_files group columns']);
      const tables = withReleasesDb(
        rel,
        (db) =>
          (
            db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
              name: string;
            }[]
          ).map((r) => r.name),
        { readonly: true }
      );
      expect(tables).toContain('release_files');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pre-v1 database boots: schema apply must not reference migrated columns', () => {
    // Live failure 2026-09-10: schema.sql created an index on a column only
    // migration v1 adds. applySchema runs before migrations on every boot,
    // so that combination crash-looped the server.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-relmig-'));
    try {
      const dbPath = path.join(dir, 'releases.db');
      const old = new Database(dbPath);
      try {
        old.exec(`
          CREATE TABLE release_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT, dir_no INTEGER NOT NULL,
            file_no INTEGER NOT NULL, filename TEXT NOT NULL, flag TEXT NOT NULL DEFAULT '',
            size_bytes INTEGER, size_note TEXT, date_iso TEXT NOT NULL,
            dl_count INTEGER, uploader TEXT, description TEXT, version TEXT,
            author TEXT, raw_desc TEXT NOT NULL,
            UNIQUE (dir_no, file_no, filename))`);
      } finally {
        old.close();
      }
      expect(initReleasesDb({ dbPath })).toEqual(['1:release_files group columns']);
      withReleasesDb(
        { dbPath },
        (db) => {
          db.prepare(
            `INSERT INTO release_files (dir_no, file_no, filename, flag, date_iso, release_group, raw_desc)
             VALUES (1, 1, 'A.LHA', 'P', '2020-01-02', 'ACME', 'x')`
          ).run();
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upserts on (dir_no, file_no)', () => {
    const db = new Database(':memory:');
    try {
      applyReleasesSchema(db);
      const upsert = db.prepare(
        `INSERT INTO release_files (dir_no, file_no, filename, flag, date_iso, raw_desc)
         VALUES (1, 1, 'A.LHA', 'P', '2020-01-02', 'x')
         ON CONFLICT(dir_no, file_no, filename) DO UPDATE SET filename = excluded.filename`
      );
      upsert.run();
      upsert.run();
      const n = (db.prepare('SELECT COUNT(*) AS n FROM release_files').get() as { n: number }).n;
      expect(n).toBe(1);
    } finally {
      db.close();
    }
  });
});
