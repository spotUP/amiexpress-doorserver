import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import { buildManifest, renderListTxt, renderListTxtCached, _clearListCacheForTests } from '../src/manifest';
import type { ServerConfig } from '../src/config';

let dir: string;
let cfg: ServerConfig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-man-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  fs.writeFileSync(path.join(dir, 'Archives', 'ACC-V103.LHA'), 'x');
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: path.join(dir, 'Archives'), port: 3010, adminKeys: [], jwtSecret: null };
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

beforeEach(() => {
  _clearListCacheForTests();
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
    // The description column no longer reaches list.txt - it is read out of
    // FILE_ID.DIZ now (src/describe.ts) - so the one-row/one-line invariant
    // is exercised through a field that still comes from the catalog
    // verbatim, plus a DIZ that spans lines.
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, file_id_diz, indexed_at)
       VALUES ('id2', 'NL.LHA', 'NL.LHA', 'Name one\nName two', 'XIM',
               'Sysop paging door for /X\nwith a second line', 1700000000)`
    ).run();
    db.close();
    const body = renderListTxt(buildManifest(cfg)).toString('latin1');
    expect(body).toContain('Name one Name two');
    const dataLines = body.split('\r\n').filter((l) => l.length > 0 && !l.startsWith('DOORREPO|'));
    expect(dataLines).toHaveLength(2);
    for (const line of dataLines) expect(line.split('|')).toHaveLength(10);
  });

  it('separates every row with CRLF and terminates the body with one', () => {
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id2', 'B.LHA', 'B.LHA', 'Bee', 'XIM', 1700000000)`
    ).run();
    db.close();
    const body = renderListTxt(buildManifest(cfg)).toString('latin1');
    expect(body.endsWith('\r\n')).toBe(true);
    expect(body).not.toMatch(/[^\r]\n/);
    expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(3);
  });

  it('writes high-bit text as single Latin-1 bytes and replaces what Latin-1 cannot hold', () => {
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id3', 'UML.LHA', 'UML.LHA', 'Gr` + `üße Ж', 'XIM', 1700000000)`
    ).run();
    db.close();
    const body = renderListTxt(buildManifest(cfg));
    // u-umlaut and sharp-s are ONE Latin-1 byte each, never a UTF-8 pair.
    expect(body.includes(Buffer.from([0xfc]))).toBe(true);
    expect(body.includes(Buffer.from([0xdf]))).toBe(true);
    expect(body.includes(Buffer.from([0xc3, 0xbc]))).toBe(false);
    // Cyrillic ZHE has no Latin-1 byte, so it becomes a literal '?' rather
    // than the silent low-byte truncation Buffer.from(..., 'latin1') does.
    expect(body.toString('latin1')).toContain('Grüße ?');
  });

  it('escapes a pipe so a field cannot invent a column', () => {
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, description, indexed_at)
       VALUES ('id4', 'PIPE.LHA', 'PIPE.LHA', 'A|B', 'XIM', 'has | a pipe', 1700000000)`
    ).run();
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, file_id_diz, indexed_at)
       VALUES ('id5', 'PIPE2.LHA', 'PIPE2.LHA', 'Pipe Two', 'XIM',
               'A chat door | with a pipe in its own DIZ', 1700000000)`
    ).run();
    db.close();
    const body = renderListTxt(buildManifest(cfg)).toString('latin1');
    expect(body).toContain('A!B');
    // A pipe cannot reach the description from a DIZ at all: in a box it IS
    // a pillar, so the classifier splits the line on it and describes the
    // cell (src/describe.ts, CELL_SPLIT). Either way no field can invent a
    // column - asserted for every row by the field count below.
    const pipe2 = body.split('\r\n').find((l) => l.startsWith('PIPE2.LHA'));
    expect(pipe2).toContain('with a pipe in its own DIZ');
    const dataLines = body.split('\r\n').filter((l) => l.length > 0 && !l.startsWith('DOORREPO|'));
    for (const line of dataLines) {
      expect(line.split('|')).toHaveLength(10);
    }
  });
});

describe('renderListTxtCached', () => {
  it('serves a repeat call from the cache while the revision is unchanged', () => {
    const first = renderListTxtCached(cfg).toString('latin1');
    const db = openDb(cfg);
    // Same row count and same max(indexed_at), so the revision - and the
    // cache key - do not move. A cache hit must therefore still show the
    // OLD name, while the uncached path sees the new one.
    db.prepare("UPDATE door_catalog SET name = 'Renamed Editor' WHERE id = 'id1'").run();
    db.close();
    expect(renderListTxtCached(cfg).toString('latin1')).toBe(first);
    expect(renderListTxtCached(cfg).toString('latin1')).not.toContain('Renamed Editor');
    expect(renderListTxt(buildManifest(cfg)).toString('latin1')).toContain('Renamed Editor');
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
