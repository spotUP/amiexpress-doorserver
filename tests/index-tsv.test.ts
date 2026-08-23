import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import { describeDoor, renderIndexTsv, renderIndexTsvCached, _clearIndexTsvCacheForTests } from '../src/index-tsv';
import type { ServerConfig } from '../src/config';

describe('describeDoor', () => {
  it('picks the first DIZ line that reads as real words', () => {
    const diz = '______    ________.  /\\    ______.__________\nAccount Editor v1.0\nmore art //\\\\';
    expect(describeDoor(diz, null, 'ACC-V103.LHA')).toBe('Account Editor v1.0');
  });

  it('falls back to name when every DIZ line is art', () => {
    const diz = '______    ________.  /\\    ______.__________\n____ _____________';
    expect(describeDoor(diz, 'Account Editor', 'ACC-V103.LHA')).toBe('Account Editor');
  });

  it('falls back to the archive base name when the DIZ and the name are both art', () => {
    const diz = '______    ________.  /\\    ______.__________';
    const name = '____ _________________________________ _  :····/ __';
    expect(describeDoor(diz, name, 'ACC-V103.LHA')).toBe('ACC-V103');
  });

  it('falls back to the archive base name when there is no DIZ at all', () => {
    expect(describeDoor(null, null, 'ACC-V103.LHA')).toBe('ACC-V103');
  });

  it('collapses whitespace and strips control characters', () => {
    const diz = 'Account   Editor\tv1.0\x01\x02 for real';
    expect(describeDoor(diz, null, 'ACC-V103.LHA')).toBe('Account Editor v1.0 for real');
  });

  it('caps the result at 60 characters', () => {
    const longLine = 'Account Editor supports every field of the AmiExpress config file format';
    expect(describeDoor(longLine, null, 'ACC-V103.LHA').length).toBeLessThanOrEqual(60);
    expect(describeDoor(longLine, null, 'ACC-V103.LHA')).toBe(longLine.slice(0, 60));
  });

  it('a real 3301-door catalog scene DIZ banner is treated as art', () => {
    // Real corpus example (see task description): a border built entirely
    // from box-drawing punctuation, no run of 3+ letters anywhere.
    const diz = '-D-CALC.LHA    ______    ________.  /\\    ______.__________ \\____ \\';
    expect(describeDoor(diz, null, '-D-CALC.LHA')).toBe('-D-CALC');
  });
});

let dir: string;
let cfg: ServerConfig;

beforeEach(() => {
  _clearIndexTsvCacheForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-tsv-'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: dir, port: 3010, adminKeys: [] };
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
    expect(row).toBe('ACC-V103.LHA\tAmiExpress\t671K\tAmiExpress\tAccount Editor v1.0');
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
