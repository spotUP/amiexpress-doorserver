import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import { buildManifest, renderListTxt, renderListTxtCached } from '../src/manifest';
import type { ServerConfig } from '../src/config';

let dir: string;
let cfg: ServerConfig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-man-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  fs.writeFileSync(path.join(dir, 'Archives', 'ACC-V103.LHA'), 'x');
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: path.join(dir, 'Archives'), port: 3010, adminKeys: [] };
  const db = openDb(cfg);
  applySchema(db);
  db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, name, door_type, description, doc_raw,
        archive_size, md5, sha256, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'ACC-V103.LHA', 'Account Editor', 'XIM',
             'Line one\nLine two', 'the doc', 4711, 'aa', 'bb', 1700000000)`
  ).run();
  db.prepare(
    `INSERT INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason)
     VALUES ('id1', 'TC.displayme', 1346, 1, 'ad'), ('id1', 'Account/AccEd.Rexx', 25552, 0, NULL)`
  ).run();
  db.close();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('buildManifest', () => {
  it('publishes the live junk count, not the denormalised column', () => {
    const m = buildManifest(cfg);
    expect(m.doors[0].junkCount).toBe(1);
  });

  it('reports hasDoc from doc_raw', () => {
    expect(buildManifest(cfg).doors[0].hasDoc).toBe(true);
  });

  it('carries the catalog revision, not a git sha', () => {
    expect(buildManifest(cfg).revision).toBe('c1-t1700000000');
  });

  it('filters by door type', () => {
    expect(buildManifest(cfg, { type: 'AIM' }).doors).toHaveLength(0);
    expect(buildManifest(cfg, { type: 'XIM' }).doors).toHaveLength(1);
  });

  // The source's q filter also searched installed_as, a per-node column this
  // server does not have. Without dropping that term the query throws at
  // prepare time, so this test is what proves the port dropped it.
  it('searches by free text without touching per-node columns', () => {
    expect(buildManifest(cfg, { q: 'Account' }).doors).toHaveLength(1);
    expect(buildManifest(cfg, { q: 'nothing-matches-this' }).doors).toHaveLength(0);
  });
});

describe('renderListTxt', () => {
  it('emits a DOORREPO header whose count matches the data lines', () => {
    const body = renderListTxt(buildManifest(cfg)).toString('latin1');
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines[0]).toBe('DOORREPO|1|c1-t1700000000|1');
    expect(lines).toHaveLength(2);
  });

  it('collapses embedded newlines so one door is one line', () => {
    const body = renderListTxt(buildManifest(cfg)).toString('latin1');
    expect(body).toContain('Line one Line two');
  });

  it('terminates lines with CRLF', () => {
    expect(renderListTxt(buildManifest(cfg)).toString('latin1')).toContain('\r\n');
  });
});

describe('renderListTxtCached', () => {
  it('returns identical bytes on a repeat call', () => {
    const a = renderListTxtCached(cfg);
    const b = renderListTxtCached(cfg);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('re-renders after the catalog revision changes', () => {
    const before = renderListTxtCached(cfg).toString('latin1');
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id2', 'B.LHA', 'B.LHA', 'Bee', 'XIM', 1700000001)`
    ).run();
    db.close();
    expect(renderListTxtCached(cfg).toString('latin1')).not.toBe(before);
  });
});
