import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import { describeDoor, renderIndexTsv, renderIndexTsvCached, _clearIndexTsvCacheForTests } from '../src/index-tsv';
import type { ServerConfig } from '../src/config';

describe('describeDoor', () => {
  it('picks the first DIZ line that reads as real words', () => {
    const diz = '______    ________.  /\\    ______.__________\nAccount Editor v1.0\nmore art //\\\\';
    expect(describeDoor(diz, null, 'ACC-V103.LHA', null)).toBe('Account Editor v1.0');
  });

  it('falls back to name when every DIZ line is art', () => {
    const diz = '______    ________.  /\\    ______.__________\n____ _____________';
    expect(describeDoor(diz, 'Account Editor', 'ACC-V103.LHA', null)).toBe('Account Editor');
  });

  it('falls back to the archive base name when the DIZ and the name are both art', () => {
    const diz = '______    ________.  /\\    ______.__________';
    const name = '____ _________________________________ _  :····/ __';
    expect(describeDoor(diz, name, 'ACC-V103.LHA', null)).toBe('ACC-V103');
  });

  it('falls back to the archive base name when there is no DIZ at all', () => {
    expect(describeDoor(null, null, 'ACC-V103.LHA', null)).toBe('ACC-V103');
  });

  it('collapses whitespace and strips control characters', () => {
    const diz = 'Account   Editor\tv1.0\x01\x02 for real';
    expect(describeDoor(diz, null, 'ACC-V103.LHA', null)).toBe('Account Editor v1.0 for real');
  });

  it('caps the result at 60 characters', () => {
    const longLine = 'Account Editor supports every field of the AmiExpress config file format';
    expect(describeDoor(longLine, null, 'ACC-V103.LHA', null).length).toBeLessThanOrEqual(60);
    expect(describeDoor(longLine, null, 'ACC-V103.LHA', null)).toBe(longLine.slice(0, 60));
  });

  it('a pure box-drawing border line is treated as art', () => {
    // A border line built entirely from box-drawing punctuation, no run of
    // 3+ letters anywhere - still correctly rejected even after frame-trim
    // (there is no non-frame content to trim down to).
    const diz = '______    ________.  /\\    ______.__________';
    expect(describeDoor(diz, null, 'X.LHA', null)).toBe('X');
  });

  it('the real -D-CALC.LHA catalog DIZ: border art, a "brings" banner, then the real description', () => {
    // Captured verbatim from the live 3301-door catalog. The banner line
    // ("+---(bRinGs  ToDaY)---mk-+") itself stays rejected even
    // frame-trimmed (interior dashes still dominate the ratio), so
    // findDescriptiveLine falls through to the next line without needing
    // its own banner-substitution branch here.
    const diz =
      '______    ________.  /\\    ______.__________\n' +
      '\\____ \\/\\/  _  /  ¦_/\\/\\/\\/ ___/ ¦  \\  __  /\n' +
      '¦:  /   //    /\\  ¦ \\_ \\\\  /  \\     \\\\/  \\/\n' +
      '¦______/_______/_____/___\\____/__¦___/____\\\n' +
      '+-------------(bRinGs  ToDaY)-----------mk-+\n' +
      '       CALCULATOR V1.0 by VASCAL/DLT\n' +
      '+------------------------------------------+';
    expect(describeDoor(diz, diz.split('\n')[0], '-D-CALC.LHA', null)).toBe('CALCULATOR V1.0 by VASCAL/DLT');
  });

  // ── Finding 2.1: skip past a scene release banner ──────────────────────

  it('skips a "presents" banner line and uses a later real-word line instead', () => {
    const diz =
      '______    ________.  /\\    ______.__________\n' +
      '-*- iNDEPENDENT cONNECTION pRESENTS -*-\n' +
      '#18.12.1995#\n' +
      'This tool starts only for NEWUSERS /X';
    expect(describeDoor(diz, null, 'ALSTER.LHA', null)).toBe('This tool starts only for NEWUSERS /X');
  });

  it('uses the remainder of a banner line after the matched keyword when it reads as real words', () => {
    const diz = 'Some Group Presents SuperTool v1.0 for AmiExpress';
    expect(describeDoor(diz, null, 'ST.LHA', null)).toBe('SuperTool v1.0 for AmiExpress');
  });

  it('gives up on a banner with no usable substitute within 3 lines and keeps scanning', () => {
    const diz =
      'Cool Group Proudly Presents\n' +
      '###\n' +
      '###\n' +
      '###\n' +
      'A Real Description Line Here';
    expect(describeDoor(diz, null, 'X.LHA', null)).toBe('A Real Description Line Here');
  });

  // ── Finding 2.2: prefer binary_name ─────────────────────────────────────

  it('composes binary_name and the descriptive line with a dash', () => {
    const diz = 'Split Chat Door For /X +4.x, S!X and FAME';
    expect(describeDoor(diz, null, 'FULLCHAT.LHA', 'FullChat')).toBe(
      'FullChat - Split Chat Door For /X +4.x, S!X and FAME'
    );
  });

  it('uses binary_name alone when no descriptive line survives', () => {
    const diz = '______    ________.  /\\    ______.__________';
    expect(describeDoor(diz, null, 'X.LHA', 'Children')).toBe('Children');
  });

  it('skips the binary_name prefix when the descriptive line already contains it', () => {
    const diz = 'Snes-Tool v1.10';
    expect(describeDoor(diz, null, 'SNES.LHA', 'Snes-Tool')).toBe('Snes-Tool v1.10');
  });

  it('falls back to the existing chain when there is no binary_name', () => {
    const diz = 'Account Editor v1.0';
    expect(describeDoor(diz, null, 'ACC-V103.LHA', null)).toBe('Account Editor v1.0');
    expect(describeDoor(diz, null, 'ACC-V103.LHA', '')).toBe('Account Editor v1.0');
    expect(describeDoor(diz, null, 'ACC-V103.LHA', '   ')).toBe('Account Editor v1.0');
  });

  // ── Finding 2, residual defect 1: trim frame punctuation from both ends ─

  it('trims frame punctuation from both ends of the chosen line', () => {
    const diz = '### mCOMM . /X mAILCOMMENTING AIM dOOR ###';
    expect(describeDoor(diz, null, 'MCOMM.LHA', null)).toBe('mCOMM . /X mAILCOMMENTING AIM dOOR');
  });

  // ── Finding 2, residual defect 2: raise the decoration bar ──────────────

  it('rejects a line dominated by punctuation even when it contains a real word', () => {
    // "for" is a real word, but the line is otherwise almost entirely
    // frame punctuation (a hand-built worst case, not the exact prototype
    // string, tuned against this implementation's ratio rule).
    const diz = '\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/[for]\\/\\/\\/\\/\\/\\/\\/\\/\\/\\/\nGenuine Description Here';
    expect(describeDoor(diz, null, 'X.LHA', null)).toBe('Genuine Description Here');
  });

  // ── Finding 2, residual defect 3: skip copyright/year lines ─────────────

  it('skips a copyright-dominated line and prefers a later one', () => {
    const diz = 'hAUSfRAU!.exe - © FLi7e/SAD 1996\nHousewife simulator for AmiExpress';
    expect(describeDoor(diz, null, 'HAUSFRAU.LHA', null)).toBe('Housewife simulator for AmiExpress');
  });

  it('falls further back when a copyright line is the only candidate', () => {
    const diz = 'hAUSfRAU!.exe - © FLi7e/SAD 1996';
    expect(describeDoor(diz, 'Hausfrau Simulator', 'HAUSFRAU.LHA', null)).toBe('Hausfrau Simulator');
  });

  // ── Finding 3: Latin-1 diacritics count as letters ──────────────────────

  it('treats a Latin-1 diacritic as a letter, so a diacritic-only run still counts as a word', () => {
    // Without À-ÿ in the word-run test, "Größe" breaks into "Gr" (2 ASCII
    // letters) before "ö", never reaching a 3-letter run.
    expect(describeDoor('Größe', null, 'X.LHA', null)).toBe('Größe');
  });

  // Real corpus example (AE_DOORS.LHA): a repeated-character placeholder
  // trivially clears the word-run and ratio tests (no punctuation to
  // outweigh it) but is not a word.
  it('rejects a repeated-character placeholder and falls back to the archive base name', () => {
    expect(describeDoor('XXXX....', 'XXXX....', 'AE_DOORS.LHA', null)).toBe('AE_DOORS');
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
    expect(row).toBe('FULLCHAT.LHA	AmiExpress	1K	AmiExpress	FullChat - Split Chat Door For /X +4.x, S!X and FAME');
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
  it('substitutes a character with no Latin-1 equivalent with a literal ?', () => {
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
    // Must degrade to ASCII '?' - never a raw multi-byte UTF-8 sequence,
    // and never a silently-corrupted single byte.
    expect(body.toString('latin1')).toContain('Bob?s Amazing Doorway');
    expect(body.includes(Buffer.from([0xe2, 0x80, 0x99]))).toBe(false);
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
