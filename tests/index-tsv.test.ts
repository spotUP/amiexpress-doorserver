import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import { renderIndexTsv, renderIndexTsvCached, _clearIndexTsvCacheForTests } from '../src/index-tsv';
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
  cfg = { dbPath, archivesRoot: dir, port: 3010, adminKeys: [], jwtSecret: null };
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
    expect(header).toBe('Filename\tPath\tSize\tSystem\tDescription');
  });

  it('uses LF line endings, not CRLF', () => {
    const body = renderIndexTsv(cfg).toString('latin1');
    expect(body).not.toContain('\r');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('derives Path and System from the first archive_path segment', () => {
    const body = renderIndexTsv(cfg).toString('latin1');
    const row = body.split('\n').find((l: string) => l.startsWith('ACC-V103.LHA'));
    // "v1.0" is the door's own version and now leaves the description for
    // its own field (src/describe.ts), so the Description column carries the
    // name alone.
    expect(row).toBe('ACC-V103.LHA\tAmiExpress\t671K\tAmiExpress\tAccount Editor');
  });

  it('falls back to Unsorted when archive_path has no directory segment', () => {
    const body = renderIndexTsv(cfg).toString('latin1');
    const row = body.split('\n').find((l: string) => l.startsWith('LOOSE.LHA'));
    expect(row).toBe('LOOSE.LHA\tUnsorted\t2K\tUnsorted\tLoose');
  });

  it('formats sizes under 1024 bytes as NNNB with no K suffix', () => {
    const body = renderIndexTsv(cfg).toString('latin1');
    const row = body.split('\n').find((l: string) => l.startsWith('TINY.LHA'));
    expect(row).toBe('TINY.LHA\tAmiExpress\t512B\tAmiExpress\tTiny');
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
    expect(row?.split('\t')).toHaveLength(5);
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
               'Split Chat Door For /X +4.x, S!X and FAME', 1024, 1700000000)`
    ).run();
    db.close();
    const body = renderIndexTsv(cfg).toString('latin1');
    const row = body.split('\n').find((l: string) => l.startsWith('FULLCHAT.LHA'));
    // binary_name is a FILENAME: "FullChat" is split into words before it
    // is composed with the DIZ line.
    expect(row).toBe('FULLCHAT.LHA	AmiExpress	1K	AmiExpress	Full Chat - Split Chat Door For /X +4.x, S!X and FAME');
  });

  // Finding 4: Filename/Path/System get the same control-character strip
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
    expect(row).toBe('CTRL.LHA	Ami Express	0B	Ami Express	Ctrl');
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
