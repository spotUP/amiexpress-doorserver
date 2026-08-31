import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import {
  resolveArchivePath, getCatalogEntryByArchive, getArchiveFiles,
  getCatalogRevision, getDoorCount, stripArchiveOnServer,
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

describe('stripArchiveOnServer', () => {
  // stripArchiveOnServer used to hardcode "only .lha/.lzh" and call the
  // always-lha-biased findArchiverBinary() regardless of the archive's own
  // format - a real, present 7z (which supports .zip natively) was never
  // even considered. ARCHIVER_COMMAND stubs the binary so this doesn't
  // depend on a real 7z/lha being on the CI host - deleteMembers() is never
  // actually invoked for an empty members list, so the stub only needs to
  // exist on disk for existsSync() to find it.
  let prevArchiverCommand: string | undefined;

  beforeEach(() => {
    prevArchiverCommand = process.env.ARCHIVER_COMMAND;
    const stubBinPath = path.join(dir, 'stub-archiver.sh');
    fs.writeFileSync(stubBinPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.ARCHIVER_COMMAND = stubBinPath;

    fs.writeFileSync(path.join(dir, 'Archives', 'FAME', 'ZTEST.zip'), 'x');
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id2', 'ZTEST.zip', 'FAME/ZTEST.zip', 'Zip Test', 'XIM', 1700000000)`
    ).run();
    db.close();
  });

  afterEach(() => {
    if (prevArchiverCommand === undefined) delete process.env.ARCHIVER_COMMAND;
    else process.env.ARCHIVER_COMMAND = prevArchiverCommand;
  });

  it('accepts a .zip archive instead of rejecting it as an unsupported format', () => {
    // canDeleteMembers recognises a 7z-capable binary by its filename
    // ending in "7z" - the shared beforeEach stub is named generically
    // (it stands in for lha in the other tests below), so this test needs
    // its own stub with a 7z-shaped name to exercise the .zip-via-7z path.
    const stub7zPath = path.join(dir, 'stub7z');
    fs.writeFileSync(stub7zPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.ARCHIVER_COMMAND = stub7zPath;

    const result = stripArchiveOnServer(cfg, 'ZTEST.zip', [], null);
    expect(result).toEqual({ ok: true, removed: 0, newJunkCount: 0 });
  });

  it('still rejects a genuinely unsupported format', () => {
    fs.writeFileSync(path.join(dir, 'Archives', 'FAME', 'DTEST.dms'), 'x');
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id3', 'DTEST.dms', 'FAME/DTEST.dms', 'DMS Test', 'XIM', 1700000000)`
    ).run();
    db.close();
    const result = stripArchiveOnServer(cfg, 'DTEST.dms', [], null);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('Unsupported archive format') });
  });

  it('still rejects LZX with its own explanatory reason', () => {
    fs.writeFileSync(path.join(dir, 'Archives', 'FAME', 'LTEST.lzx'), 'x');
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id4', 'LTEST.lzx', 'FAME/LTEST.lzx', 'LZX Test', 'XIM', 1700000000)`
    ).run();
    db.close();
    const result = stripArchiveOnServer(cfg, 'LTEST.lzx', [], null);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('LZX') });
  });
});
