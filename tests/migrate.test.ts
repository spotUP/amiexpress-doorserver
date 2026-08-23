import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migrateFromBbs } from '../scripts/migrate-from-bbs';

let dir: string;
let source: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-mig-'));
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
  db.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, doc_raw,
      installed, installed_as, install_dir, indexed_at)
     VALUES ('id1','ACC-V103.LHA','FAME/ACC-V103.LHA','Account Editor','XIM',
             char(12) || 'doc with a form feed', 1, 'ACC', 'Doors/ACC', 1700000000)`
  ).run();
  db.prepare(
    `INSERT INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason)
     VALUES ('id1','Account/AccEd.Rexx',25552,0,NULL)`
  ).run();
  db.close();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('migrateFromBbs', () => {
  it('copies every catalog row and file row', () => {
    const counts = migrateFromBbs({ sourceDb: source, targetDb: target });
    expect(counts).toEqual({ entries: 1, files: 1 });
  });

  it('leaves the per-node install columns behind', () => {
    migrateFromBbs({ sourceDb: source, targetDb: target });
    const db = new Database(target, { readonly: true });
    const cols = db.prepare('PRAGMA table_info(door_catalog)').all()
      .map((r) => (r as { name: string }).name);
    db.close();
    expect(cols).not.toContain('installed');
  });

  it('preserves control bytes in doc_raw', () => {
    migrateFromBbs({ sourceDb: source, targetDb: target });
    const db = new Database(target, { readonly: true });
    const row = db.prepare('SELECT doc_raw FROM door_catalog WHERE id = ?').get('id1') as { doc_raw: string };
    db.close();
    expect(row.doc_raw.charCodeAt(0)).toBe(12);
  });

  it('is idempotent - re-running does not duplicate rows', () => {
    migrateFromBbs({ sourceDb: source, targetDb: target });
    const second = migrateFromBbs({ sourceDb: source, targetDb: target });
    expect(second.entries).toBe(1);
    const db = new Database(target, { readonly: true });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM door_catalog').get() as { n: number }).n;
    db.close();
    expect(n).toBe(1);
  });

  it('refuses to migrate a database into itself', () => {
    expect(() => migrateFromBbs({ sourceDb: source, targetDb: source }))
      .toThrow(/same file|itself/i);
  });

  // The live BBS writes to its database while this runs. Attaching it
  // read-write from a second process would contend for its WAL locks, so
  // the script must copy before it attaches - and must leave no trace
  // beside the original.
  it('does not write to, or lock, the source database', () => {
    const before = fs.statSync(source).mtimeMs;
    migrateFromBbs({ sourceDb: source, targetDb: target });
    expect(fs.statSync(source).mtimeMs).toBe(before);
    expect(fs.existsSync(`${source}-wal`)).toBe(false);
    expect(fs.existsSync(`${source}-shm`)).toBe(false);
  });

  it('carries every migrated column, not just the row count', () => {
    const db = new Database(source);
    db.prepare(
      `UPDATE door_catalog SET binary_name='BIN', version='1.2', author='AUTH',
         release_group='GRP', description='DESC', file_id_diz='DIZ',
         doc_filename='DOC.txt', suggested_tooltypes='TT', category='CAT',
         archive_size=4711, junk_count=3, corpus_id='CORP', source='scan',
         md5='aa', sha256='bb' WHERE id='id1'`
    ).run();
    db.close();
    migrateFromBbs({ sourceDb: source, targetDb: target });
    const out = new Database(target, { readonly: true });
    const row = out.prepare('SELECT * FROM door_catalog WHERE id = ?').get('id1') as Record<string, unknown>;
    out.close();
    expect(row).toMatchObject({
      binary_name: 'BIN', version: '1.2', author: 'AUTH', release_group: 'GRP',
      description: 'DESC', file_id_diz: 'DIZ', doc_filename: 'DOC.txt',
      suggested_tooltypes: 'TT', category: 'CAT', archive_size: 4711,
      junk_count: 3, corpus_id: 'CORP', source: 'scan', md5: 'aa', sha256: 'bb',
    });
  });
});
