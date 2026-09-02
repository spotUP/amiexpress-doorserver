import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import {
  RECENT_DEFAULT,
  RECENT_MAX,
  clampRecent,
  renderIndexTsv,
  renderIndexTsvCached,
  _clearIndexTsvCacheForTests,
} from '../src/index-tsv';
import type { ServerConfig } from '../src/config';

// What a Description SAYS is decided in src/describe.ts and tested in
// tests/describe.test.ts. This file tests the RENDERER: columns, sizes,
// encoding, filtering and the cache.

let dir: string;
let cfg: ServerConfig;

beforeEach(() => {
  _clearIndexTsvCacheForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-tsv-'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: dir, port: 3010, adminKeys: [], jwtSecret: null, learnKey: null };
  const db = openDb(cfg);
  applySchema(db);
  db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, name, door_type, file_id_diz, archive_size, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'AmiExpress/ACC-V103.LHA', 'Account Editor', 'XIM',
             'Account Editor v1.0', 687104, 1700000000)`
  ).run();
  db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, name, door_type, file_id_diz, archive_size, indexed_at)
     VALUES ('id2', 'TINY.LHA', 'AmiExpress/TINY.LHA', 'Tiny', 'XIM', NULL, 512, 1700000000)`
  ).run();
  db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, name, door_type, file_id_diz, archive_size, indexed_at)
     VALUES ('id3', 'LOOSE.LHA', 'LOOSE.LHA', 'Loose', 'DD', NULL, 2048, 1700000000)`
  ).run();
  db.close();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('renderIndexTsv', () => {
  it('emits the header row with Filename and Path first', () => {
    const body = renderIndexTsv(cfg).toString('latin1');
    const [header] = body.split('\n');
    expect(header).toBe('Filename\tPath\tSize\tDescription');
  });

  // uhcsearch asked for the System column to go: it repeated Path on every
  // row, and Path already reads as what it is.
  it('has no System column', () => {
    const body = renderIndexTsv(cfg).toString('latin1');
    const [header, ...rows] = body.trimEnd().split('\n');
    expect(header).not.toContain('System');
    for (const row of rows) expect(row.split('\t')).toHaveLength(4);
  });

  it('uses LF line endings, not CRLF', () => {
    const body = renderIndexTsv(cfg).toString('latin1');
    expect(body).not.toContain('\r');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('derives Path from the first archive_path segment', () => {
    const body = renderIndexTsv(cfg).toString('latin1');
    const row = body.split('\n').find((l: string) => l.startsWith('ACC-V103.LHA'));
    // "v1.0" is the door's own version and now leaves the description for
    // its own field (src/describe.ts), so the Description column carries the
    // name alone.
    expect(row).toBe('ACC-V103.LHA\tAmiExpress\t671K\tAccount Editor');
  });

  it('falls back to Unsorted when archive_path has no directory segment', () => {
    const body = renderIndexTsv(cfg).toString('latin1');
    const row = body.split('\n').find((l: string) => l.startsWith('LOOSE.LHA'));
    expect(row).toBe('LOOSE.LHA\tUnsorted\t  2K\tLoose');
  });

  it('formats sizes under 1024 bytes as NNNB with no K suffix', () => {
    const body = renderIndexTsv(cfg).toString('latin1');
    const row = body.split('\n').find((l: string) => l.startsWith('TINY.LHA'));
    expect(row).toBe('TINY.LHA\tAmiExpress\t512B\tTiny');
  });

  it('is ISO-8859-1 encoded: high-bit metadata becomes a single Latin-1 byte, not UTF-8', () => {
    // 'works' gives the name a 3-letter run so it passes the description
    // classifier's real-words test (see describeDoor tests above) and the
    // umlaut/sharp-s actually reach the rendered row instead of being
    // replaced by the archive-basename fallback.
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id4', 'UML.LHA', 'AmiExpress/UML.LHA', 'Grüßeworks', 'XIM', 1700000000)`
    ).run();
    db.close();
    const body = renderIndexTsv(cfg);
    expect(body.includes(Buffer.from([0xfc]))).toBe(true);
    expect(body.includes(Buffer.from([0xc3, 0xbc]))).toBe(false);
  });

  it('strips a tab or newline embedded in a field rather than corrupting the columns', () => {
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id5', 'TAB.LHA', 'Weird\tPath/TAB.LHA', 'Tab\tName', 'XIM', 1700000000)`
    ).run();
    db.close();
    const body = renderIndexTsv(cfg).toString('latin1');
    const row = body.split('\n').find((l: string) => l.startsWith('TAB.LHA'));
    expect(row).toBeDefined();
    expect(row?.split('\t')).toHaveLength(4);
  });

  it('honours ?type= and ?q= the same way the manifest does', () => {
    const byType = renderIndexTsv(cfg, { type: 'DD' }).toString('latin1');
    expect(byType).toContain('LOOSE.LHA');
    expect(byType).not.toContain('ACC-V103.LHA');

    const byQuery = renderIndexTsv(cfg, { q: 'Account' }).toString('latin1');
    expect(byQuery).toContain('ACC-V103.LHA');
    expect(byQuery).not.toContain('TINY.LHA');
  });

  // Finding 2.2 end-to-end: binary_name flows from the DB row into the
  // rendered Description column, composed with the DIZ-derived line.
  it('composes binary_name into the rendered Description column', () => {
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, binary_name, name, door_type, file_id_diz, archive_size, indexed_at)
       VALUES ('id6', 'FULLCHAT.LHA', 'AmiExpress/FULLCHAT.LHA', 'FullChat', 'Full Chat', 'XIM',
               'Split Chat Door', 1024, 1700000000)`
    ).run();
    db.close();
    const body = renderIndexTsv(cfg).toString('latin1');
    const row = body.split('\n').find((l: string) => l.startsWith('FULLCHAT.LHA'));
    // binary_name is a FILENAME: "FullChat" is split into words before it
    // is composed with the DIZ line.
    expect(row).toBe('FULLCHAT.LHA	AmiExpress	  1K	Full Chat - Split Chat Door');
  });

  // Finding 4: Filename and Path get the same control-character strip
  // Description already gets, not just a tab/CR/LF replace.
  it('strips a raw control byte from Filename the same way Description does', () => {
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id7', 'CTRL.LHA', 'Ami\x01Express/CTRL.LHA', 'Ctrl', 'XIM', 1700000000)`
    ).run();
    db.close();
    const body = renderIndexTsv(cfg).toString('latin1');
    const row = body.split('\n').find((l: string) => l.startsWith('CTRL.LHA'));
    expect(row).toBe('CTRL.LHA	Ami Express	  0B	Ctrl');
  });

  // Encoding note: the DIZ text is UTF-8 in the database; the TSV is
  // ISO-8859-1. A character with NO Latin-1 representation (curly
  // apostrophe, U+2019 - unlike an umlaut, which DOES have one) must
  // degrade to the documented '?' substitution, not a mangled byte.
  it('never emits a raw UTF-8 sequence for a character with no Latin-1 equivalent', () => {
    // U+2019 (curly apostrophe) has NO Latin-1 byte, unlike an umlaut
    // (which does - see the earlier Grueszeworks test). Bound as a
    // parameter, not inlined into the SQL string, so its exact code point
    // reaches the database untouched by any quoting/escaping concern.
    const diz = 'Bob\u2019s Amazing Doorway for /X';
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, file_id_diz, indexed_at)
       VALUES ('id8', 'CURLY.LHA', 'AmiExpress/CURLY.LHA', 'Curly', 'XIM', ?, 1700000000)`
    ).run(diz);
    db.close();
    const body = renderIndexTsv(cfg);
    // The classifier drops a character it cannot represent before the row is
    // encoded, so the apostrophe becomes a space rather than reaching
    // toLatin1Safe's '?' substitution - either way, never a raw multi-byte
    // UTF-8 sequence and never a silently-corrupted single byte.
    expect(body.toString('latin1')).toContain('Bob s Amazing Doorway');
    expect(body.includes(Buffer.from([0xe2, 0x80, 0x99]))).toBe(false);

    // The '?' substitution itself still guards fields the classifier never
    // touches: an archive name is rendered verbatim.
    const db2 = openDb(cfg);
    db2.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id8b', ?, 'AmiExpress/CURLY2.LHA', 'Curly Two', 'XIM', 1700000000)`
    ).run('CUR\u2019LY.LHA');
    db2.close();
    _clearIndexTsvCacheForTests();
    const withName = renderIndexTsv(cfg);
    expect(withName.toString('latin1')).toContain('CUR?LY.LHA');
    expect(withName.includes(Buffer.from([0xe2, 0x80, 0x99]))).toBe(false);
  });
});

describe('the recent index', () => {
  /** n rows, each stamped a second later than the last. */
  function seedByAge(count: number): void {
    const db = openDb(cfg);
    const insert = db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES (?, ?, ?, ?, 'XIM', ?)`
    );
    for (let i = 0; i < count; i++) {
      const n = String(i).padStart(3, '0');
      insert.run(`age${n}`, `AGE${n}.LHA`, `AmiExpress/AGE${n}.LHA`, `Age ${n}`, 1800000000 + i);
    }
    db.close();
    _clearIndexTsvCacheForTests();
  }

  function rowsOf(body: string): string[] {
    return body.trimEnd().split('\n').slice(1);
  }

  it('serves the newest rows first', () => {
    seedByAge(5);
    const rows = rowsOf(renderIndexTsv(cfg, { recent: 3 }).toString('latin1'));
    expect(rows.map((r) => r.split('\t')[0])).toEqual(['AGE004.LHA', 'AGE003.LHA', 'AGE002.LHA']);
  });

  it('carries no more rows than asked for', () => {
    seedByAge(50);
    expect(rowsOf(renderIndexTsv(cfg, { recent: 10 }).toString('latin1'))).toHaveLength(10);
  });

  it('serves the same header and column count as the full index', () => {
    seedByAge(5);
    const full = renderIndexTsv(cfg).toString('latin1').split('\n')[0];
    const recent = renderIndexTsv(cfg, { recent: 3 }).toString('latin1');
    expect(recent.split('\n')[0]).toBe(full);
    for (const row of rowsOf(recent)) expect(row.split('\t')).toHaveLength(4);
  });

  // A recent index that recognised no release tags would describe the same
  // door differently from the full index - see catalog.ts's corpusGroupTags.
  it('describes a door exactly as the full index describes it', () => {
    const db = openDb(cfg);
    const insert = db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, binary_name, name, door_type, indexed_at)
       VALUES (?, ?, ?, ?, ?, 'XIM', ?)`
    );
    // Four archives carry the "MB" prefix, so it counts as a release tag -
    // but only when the whole corpus is in view. A 1-row render sees one.
    for (let i = 1; i <= 3; i++) {
      insert.run(`mb${i}`, `MB-OTHER${i}.LHA`, `AmiExpress/MB-OTHER${i}.LHA`, `MB-Other${i}`, `Other ${i}`, 1700000000);
    }
    insert.run('mbmaker', 'MB-MAKER.LHA', 'AmiExpress/MB-MAKER.LHA', 'MB-Maker', 'Maker', 1900000000);
    db.close();
    _clearIndexTsvCacheForTests();

    const fromFull = renderIndexTsv(cfg)
      .toString('latin1')
      .split('\n')
      .find((l) => l.startsWith('MB-MAKER.LHA'));
    const fromRecent = renderIndexTsv(cfg, { recent: 1 })
      .toString('latin1')
      .split('\n')
      .find((l) => l.startsWith('MB-MAKER.LHA'));
    expect(fromRecent).toBe(fromFull);
  });

  it('orders rows sharing one indexed_at second by name, so the bytes are stable', () => {
    const db = openDb(cfg);
    const insert = db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES (?, ?, ?, ?, 'XIM', 1900000000)`
    );
    // A bulk import stamps every row with the same second.
    for (const n of ['CCC', 'AAA', 'BBB']) {
      insert.run(n.toLowerCase(), `${n}.LHA`, `AmiExpress/${n}.LHA`, n);
    }
    db.close();
    _clearIndexTsvCacheForTests();
    const rows = rowsOf(renderIndexTsv(cfg, { recent: 3 }).toString('latin1'));
    expect(rows.map((r) => r.split('\t')[0])).toEqual(['AAA.LHA', 'BBB.LHA', 'CCC.LHA']);
  });

  it('caches the recent index apart from the full one', () => {
    seedByAge(5);
    const recent = renderIndexTsvCached(cfg, { recent: 2 }).toString('latin1');
    const full = renderIndexTsvCached(cfg).toString('latin1');
    expect(rowsOf(recent)).toHaveLength(2);
    expect(rowsOf(full).length).toBeGreaterThan(2);
    expect(renderIndexTsvCached(cfg, { recent: 2 }).toString('latin1')).toBe(recent);
  });
});

describe('clampRecent', () => {
  it('defaults when the caller names no number', () => {
    expect(clampRecent(undefined)).toBe(RECENT_DEFAULT);
    expect(clampRecent(Number.NaN)).toBe(RECENT_DEFAULT);
  });

  it('refuses to render more than the maximum', () => {
    expect(clampRecent(100000)).toBe(RECENT_MAX);
  });

  it('never renders fewer than one row', () => {
    expect(clampRecent(0)).toBe(1);
    expect(clampRecent(-5)).toBe(1);
  });

  it('takes a whole number of rows', () => {
    expect(clampRecent(7.9)).toBe(7);
  });
});

describe('renderIndexTsvCached', () => {
  it('serves a repeat call from the cache while the revision is unchanged', () => {
    const first = renderIndexTsvCached(cfg).toString('latin1');
    const db = openDb(cfg);
    db.prepare("UPDATE door_catalog SET name = 'Renamed' WHERE id = 'id1'").run();
    db.close();
    expect(renderIndexTsvCached(cfg).toString('latin1')).toBe(first);
  });

  it('re-renders after the catalog revision changes', () => {
    const before = renderIndexTsvCached(cfg).toString('latin1');
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id9', 'NEW.LHA', 'AmiExpress/NEW.LHA', 'New', 'XIM', 1700000001)`
    ).run();
    db.close();
    expect(renderIndexTsvCached(cfg).toString('latin1')).not.toBe(before);
  });
});
