import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImportClashError, importScannedBatch } from '../scripts/import-scanned-batch';
import { applySchema } from '../src/db';

let dir: string;
let source: string;
let target: string;

/** One scanned row in the BBS's catalog. */
function addSource(
  db: Database.Database,
  row: { id: string; archiveName: string; archivePath: string; name?: string }
): void {
  db.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
     VALUES (?, ?, ?, ?, 'XIM', 1700000000)`
  ).run(row.id, row.archiveName, row.archivePath, row.name ?? row.archiveName);
  db.prepare(
    `INSERT INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason)
     VALUES (?, ?, 100, 0, NULL)`
  ).run(row.id, `${row.id}/main`);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-import-'));
  source = path.join(dir, 'bbs.db');
  target = path.join(dir, 'doors.db');

  const db = new Database(source);
  db.exec(`
    CREATE TABLE door_catalog (
      id TEXT PRIMARY KEY, archive_name TEXT NOT NULL UNIQUE, archive_path TEXT NOT NULL,
      binary_name TEXT, door_type TEXT, name TEXT NOT NULL, version TEXT, author TEXT,
      release_group TEXT, description TEXT, file_id_diz TEXT, doc_filename TEXT, doc_raw TEXT,
      suggested_tooltypes TEXT, category TEXT, archive_size INTEGER, junk_count INTEGER,
      installed INTEGER DEFAULT 0, installed_as TEXT, install_dir TEXT,
      corpus_id TEXT, source TEXT, indexed_at INTEGER, md5 TEXT, sha256 TEXT);
    CREATE TABLE door_catalog_files (
      catalog_id TEXT NOT NULL, path TEXT NOT NULL, size INTEGER, is_junk INTEGER,
      junk_reason TEXT, PRIMARY KEY (catalog_id, path));
  `);
  addSource(db, { id: 'ph_one', archiveName: 'PH-ONE.LHA', archivePath: 'Phantasm/PH-ONE.LHA' });
  addSource(db, { id: 'ph_two', archiveName: 'PH-TWO.LHA', archivePath: 'Phantasm/PH-TWO.LHA' });
  addSource(db, { id: 'old_one', archiveName: 'OLD-ONE.LHA', archivePath: 'AmiExpress/OLD-ONE.LHA' });
  db.close();

  // The target already holds the AmiExpress corpus, with a curated name the
  // import must not disturb.
  const live = new Database(target);
  applySchema(live);
  live.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
     VALUES ('old_one','OLD-ONE.LHA','AmiExpress/OLD-ONE.LHA','Curated Name','XIM', 1700000000)`
  ).run();
  live.close();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function targetRows(): { id: string; archive_name: string; name: string }[] {
  const db = new Database(target, { readonly: true });
  const rows = db
    .prepare('SELECT id, archive_name, name FROM door_catalog ORDER BY archive_name')
    .all() as { id: string; archive_name: string; name: string }[];
  db.close();
  return rows;
}

describe('importScannedBatch', () => {
  it('imports only the rows under the given prefix', () => {
    const counts = importScannedBatch({ sourceDb: source, targetDb: target, prefix: 'Phantasm/' });
    expect(counts.entries).toBe(2);
    expect(counts.files).toBe(2);
    expect(targetRows().map((r) => r.archive_name)).toEqual(['OLD-ONE.LHA', 'PH-ONE.LHA', 'PH-TWO.LHA']);
  });

  it('leaves a row outside the prefix exactly as it was', () => {
    importScannedBatch({ sourceDb: source, targetDb: target, prefix: 'Phantasm/' });
    // The BBS snapshot calls this row "OLD-ONE.LHA"; the live catalog calls
    // it "Curated Name". Importing one directory must not drag the other
    // directory's rows back to the snapshot's version of them.
    expect(targetRows().find((r) => r.id === 'old_one')?.name).toBe('Curated Name');
  });

  it('copies the file rows belonging to the imported entries only', () => {
    importScannedBatch({ sourceDb: source, targetDb: target, prefix: 'Phantasm/' });
    const db = new Database(target, { readonly: true });
    const ids = (db.prepare('SELECT DISTINCT catalog_id FROM door_catalog_files ORDER BY 1').all() as {
      catalog_id: string;
    }[]).map((r) => r.catalog_id);
    db.close();
    expect(ids).toEqual(['ph_one', 'ph_two']);
  });

  it('writes nothing on --dry-run but reports what it would write', () => {
    const counts = importScannedBatch({ sourceDb: source, targetDb: target, prefix: 'Phantasm/', dryRun: true });
    expect(counts.entries).toBe(2);
    expect(targetRows()).toHaveLength(1);
  });

  it('re-importing the same batch refreshes rather than duplicates', () => {
    importScannedBatch({ sourceDb: source, targetDb: target, prefix: 'Phantasm/' });
    const again = importScannedBatch({ sourceDb: source, targetDb: target, prefix: 'Phantasm/' });
    expect(again.refreshed).toBe(2);
    expect(targetRows()).toHaveLength(3);
  });

  it('refuses when an incoming archive_name belongs to a different row', () => {
    // Two different files claiming one name: PH-ONE.LHA is already published
    // under another id. Overwriting it would repoint a live door at other
    // bytes, so the batch is refused and the archive gets renamed upstream.
    const live = new Database(target);
    live.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('other','PH-ONE.LHA','AmiExpress/PH-ONE.LHA','Someone Else','XIM', 1700000000)`
    ).run();
    live.close();

    expect(() => importScannedBatch({ sourceDb: source, targetDb: target, prefix: 'Phantasm/' })).toThrow(
      ImportClashError
    );
    expect(targetRows().find((r) => r.archive_name === 'PH-TWO.LHA')).toBeUndefined();
  });

  it('refuses an archive_name clash that differs only in case', () => {
    const live = new Database(target);
    live.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('other','ph-one.lha','AmiExpress/ph-one.lha','Someone Else','XIM', 1700000000)`
    ).run();
    live.close();

    // Lookups are COLLATE NOCASE, so two rows differing only in case are one
    // door as far as every reader is concerned - and which one answers is
    // arbitrary. The UNIQUE index would not catch this.
    expect(() => importScannedBatch({ sourceDb: source, targetDb: target, prefix: 'Phantasm/' })).toThrow(
      ImportClashError
    );
  });

  it('refuses when an incoming id belongs to a different archive', () => {
    const live = new Database(target);
    live.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('ph_one','SOMETHING.LHA','AmiExpress/SOMETHING.LHA','Someone Else','XIM', 1700000000)`
    ).run();
    live.close();

    expect(() => importScannedBatch({ sourceDb: source, targetDb: target, prefix: 'Phantasm/' })).toThrow(
      ImportClashError
    );
  });

  it('names every clash it found, so the whole batch can be fixed in one pass', () => {
    const live = new Database(target);
    live.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('a','PH-ONE.LHA','AmiExpress/PH-ONE.LHA','A','XIM', 1700000000)`
    ).run();
    live.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('b','PH-TWO.LHA','AmiExpress/PH-TWO.LHA','B','XIM', 1700000000)`
    ).run();
    live.close();

    try {
      importScannedBatch({ sourceDb: source, targetDb: target, prefix: 'Phantasm/' });
      throw new Error('expected the import to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportClashError);
      expect((error as ImportClashError).clashes).toHaveLength(2);
      expect((error as Error).message).toContain('PH-ONE.LHA');
      expect((error as Error).message).toContain('PH-TWO.LHA');
    }
  });

  it('refuses to import a database into itself', () => {
    expect(() => importScannedBatch({ sourceDb: source, targetDb: source, prefix: 'Phantasm/' })).toThrow(
      /into itself/
    );
  });

  it('refuses an empty prefix rather than copying the whole table', () => {
    expect(() => importScannedBatch({ sourceDb: source, targetDb: target, prefix: '' })).toThrow(
      /prefix is required/
    );
  });
});
