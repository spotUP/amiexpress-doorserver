import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import {
  resolveArchivePath, getCatalogEntryByArchive, getArchiveFiles,
  getCatalogRevision, getDoorCount,
} from '../src/catalog';
import type { ServerConfig } from '../src/config';

let dir: string;
let cfg: ServerConfig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-cat-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  fs.mkdirSync(path.join(dir, 'Archives', 'FAME'));
  fs.writeFileSync(path.join(dir, 'Archives', 'FAME', 'ACC-V103.LHA'), 'x');
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: path.join(dir, 'Archives'), port: 3010, adminKeys: [], jwtSecret: null, learnKey: null };
  const db = openDb(cfg);
  applySchema(db);
  db.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'FAME/ACC-V103.LHA', 'Account Editor', 'XIM', 1700000000)`
  ).run();
  db.prepare(
    `INSERT INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason)
     VALUES ('id1', 'Account/AccEd.Rexx', 25552, 0, NULL), ('id1', 'TC.displayme', 1346, 1, 'ad')`
  ).run();
  db.close();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('catalog reads', () => {
  it('resolves a relative archive_path against the archives root', () => {
    expect(resolveArchivePath(cfg, 'FAME/ACC-V103.LHA'))
      .toBe(path.join(dir, 'Archives', 'FAME', 'ACC-V103.LHA'));
  });

  it('passes an absolute archive_path through unchanged', () => {
    expect(resolveArchivePath(cfg, '/somewhere/else/X.LHA')).toBe('/somewhere/else/X.LHA');
  });

  it('finds an entry by archive name', () => {
    const entry = getCatalogEntryByArchive(cfg, 'ACC-V103.LHA');
    expect(entry?.id).toBe('id1');
    expect(entry?.door_type).toBe('XIM');
  });

  it('returns null for an unknown archive name', () => {
    expect(getCatalogEntryByArchive(cfg, 'NOPE.LHA')).toBeNull();
  });

  it('finds an entry whose name differs only in case', () => {
    expect(getCatalogEntryByArchive(cfg, 'acc-v103.lha')?.id).toBe('id1');
  });

  it('returns the archive files in path order with junk flags', () => {
    const files = getArchiveFiles(cfg, 'id1');
    expect(files.map((f) => f.path)).toEqual(['Account/AccEd.Rexx', 'TC.displayme']);
    expect(files[1].is_junk).toBe(1);
  });

  it('builds the revision from count and newest indexed_at', () => {
    expect(getCatalogRevision(cfg)).toBe('c1-t1700000000');
  });

  it('counts doors without touching checksums', () => {
    expect(getDoorCount(cfg)).toBe(1);
  });

  it('reports revision "unknown" when the catalog cannot be read', () => {
    const broken: ServerConfig = { ...cfg, dbPath: path.join(dir, 'missing.db') };
    fs.writeFileSync(broken.dbPath, '');
    expect(getCatalogRevision(broken)).toBe('unknown');
  });
});
