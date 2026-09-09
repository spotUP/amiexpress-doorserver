/**
 * The AquaScan file-listing parser: unit fixtures plus corpus counts.
 *
 * The corpus test needs the real 179 MB capture and SKIPS when it is not
 * configured (same pattern as tests/parity.test.ts) — set FILELIST_PATH.
 * A skipped corpus run is not a passing one; run it explicitly whenever
 * src/releases/parse.ts changes.
 */
import * as fs from 'fs';
import {
  parseEntryLine,
  parseLines,
  parseFilelist,
  pivotYear,
  splitSize,
  toIsoDate,
  type FileListEntry,
} from '../../src/releases/parse';

async function collect(text: string): Promise<{ entries: FileListEntry[]; anomalies: string[] }> {
  const entries: FileListEntry[] = [];
  const res = await parseLines(text.split('\n'), (e) => entries.push(e));
  return { entries, anomalies: res.anomalies };
}

describe('parseEntryLine', () => {
  it('parses a normal entry line', () => {
    expect(parseEntryLine('BETTER.WRP   N 324864  12-12-88  Better Dead than Alien! Kool game!')).toEqual({
      filename: 'BETTER.WRP',
      flag: 'N',
      sizeField: '324864',
      mm: '12',
      dd: '12',
      yy: '88',
      firstDesc: 'Better Dead than Alien! Kool game!',
    });
  });

  it('keeps spaces inside the 13-column filename', () => {
    const p = parseEntryLine('BIBLE3 WRP   N 359636  05-19-90  King James Bible');
    expect(p?.filename).toBe('BIBLE3 WRP');
    expect(p?.flag).toBe('N');
  });

  it('upper-cases a lowercase flag', () => {
    const p = parseEntryLine('ABREED1.DMS  p 750777  10-24-91  Alien Breed');
    expect(p?.flag).toBe('P');
  });

  it('parses a blank flag column as no flag', () => {
    const p = parseEntryLine('PARKTRN.WRP     12611  05-12-90  Theme Park Trainer');
    expect(p?.filename).toBe('PARKTRN.WRP');
    expect(p?.flag).toBe('');
    expect(p?.sizeField).toBe('12611');
  });

  it('parses flag jammed against the size', () => {
    const p = parseEntryLine('WP-FSH10.LHA P1115140  09-09-26  Fish!');
    expect(p?.flag).toBe('P');
    expect(p?.sizeField).toBe('1115140');
  });

  it('parses the [DELETED] form as flag D with no size', () => {
    const p = parseEntryLine('TP5-ANDR.LHA [DELETED] 12-30-95  .----...');
    expect(p?.filename).toBe('TP5-ANDR.LHA');
    expect(p?.flag).toBe('D');
    expect(p?.sizeField).toBe('DELETED');
  });

  it('parses a flagless long size', () => {
    const p = parseEntryLine('mwi-karm.lha 16193257  09-18-01  Winning demo');
    expect(p?.filename).toBe('mwi-karm.lha');
    expect(p?.flag).toBe('');
    expect(p?.sizeField).toBe('16193257');
  });

  it('rejects ornament and prompt lines', () => {
    expect(parseEntryLine('      ¸,ø*¤°¬°¤*ø,¸ 12-12-88')).toBeNull();
    expect(parseEntryLine('More? (Y/n/ns), (C)lear, (F/R) Flag, (?) Help, (Q)uit: n')).toBeNull();
    expect(parseEntryLine('')).toBeNull();
  });
});

describe('splitSize + dates', () => {
  it('reads byte sizes incl. comma thousands', () => {
    expect(splitSize('324864')).toEqual({ sizeBytes: 324864, sizeNote: null });
    expect(splitSize('754,951')).toEqual({ sizeBytes: 754951, sizeNote: null });
  });

  it('keeps nuke reasons as notes', () => {
    expect(splitSize('>NUKED<')).toEqual({ sizeBytes: null, sizeNote: '>NUKED<' });
    expect(splitSize('ONLINE!')).toEqual({ sizeBytes: null, sizeNote: 'ONLINE!' });
  });

  it('pivots the century at 80', () => {
    expect(toIsoDate('12', '12', '88')).toBe('1988-12-12');
    expect(toIsoDate('01', '02', '20')).toBe('2020-01-02');
    expect(pivotYear(80)).toBe(1980);
    expect(pivotYear(79)).toBe(2079);
  });
});

describe('parseLines blocks', () => {
  it('assigns dir 1 implicitly and dir 2 after its marker', async () => {
    const text = [
      '[ File #1 ]                     ·===============·',
      'BETTER.WRP   N 324864  12-12-88  Better Dead!',
      '[ End of File List ]',
      'Scanning dir 2 from top... Ok!',
      '[ File #1 ]                     ·===============·',
      'ASYND.WRP    N 421010  02-08-89  Alien Syndrome',
    ].join('\n');
    const { entries, anomalies } = await collect(text);
    expect(anomalies).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0].dirNo).toBe(1);
    expect(entries[0].fileNo).toBe(1);
    expect(entries[1].dirNo).toBe(2);
  });

  it('joins wrapped description lines and pulls d/L + uploader metadata out', async () => {
    const text = [
      '[ File #1 ]                     ·===============·',
      'DRAGON.WRP   N 756736  12-31-88  Double Dragon - Just like the arcade!',
      '                                 Graphics could be a lot better though.',
      '                                 d/L tIMES: 14',
      '                                 Bigophone >>last Belgian Trader <<',
      '[ File #2 ]                     ·===============·',
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].dlCount).toBe(14);
    expect(entries[0].uploader).toBe('Bigophone');
    expect(entries[0].descLines).toEqual([
      'Double Dragon - Just like the arcade!',
      '                                 Graphics could be a lot better though.',
    ]);
  });

  it('keeps inline art DIZ lines in the description', async () => {
    const text = [
      '[ File #2 ]                     ·===============·',
      'PRISM2V2.LHA P 420431  01-03-20  -------------------------------------------',
      '                                         Prism2v2.Device for WiFi!',
      '[ File #3 ]                     ·===============·',
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].descLines.join('\n')).toContain('Prism2v2.Device for WiFi!');
  });

  it('records an anomaly when no entry line follows a marker', async () => {
    const { entries, anomalies } = await collect('[ File #9 ]\n[ End of File List ]\n');
    expect(entries).toHaveLength(0);
    expect(anomalies).toHaveLength(1);
  });
});

describe('corpus counts', () => {
  const filePath = process.env.FILELIST_PATH ?? '/Users/spot/Downloads/BBS_filelist (1).txt';
  const available = fs.existsSync(filePath);
  const itIf = available ? it : it.skip;

  itIf('parses 299437 entries with a stable flag histogram', async () => {
    const flags: Record<string, number> = {};
    const res = await parseFilelist(filePath, (e) => {
      flags[e.flag || '-'] = (flags[e.flag || '-'] ?? 0) + 1;
    });
    expect(res.entries).toBe(299437);
    expect(res.anomalies).toEqual([]);
    // Measured 2026-09-09; a drift means the file changed, not the parser.
    // Measured 2026-09-10: P 264866 / N 24591 / D 6189 / - 3766 / F 15 / O 10.
    expect(flags['P']).toBeGreaterThan(260000);
    expect(flags['N']).toBeGreaterThan(24000);
    expect(flags['D']).toBeGreaterThan(6000);
    expect(flags['-']).toBeGreaterThan(3500);
    expect(flags['F']).toBe(15);
    expect(flags['O']).toBe(10);
  }, 300000);

  itIf('every BBS_files_2026.txt entry is contained in the main file', async () => {
    const sub = '/Users/spot/Downloads/BBS_files_2026.txt';
    if (!fs.existsSync(sub)) return;
    const names = new Set<string>();
    await parseFilelist(filePath, (e) => names.add(`${e.filename}\0${e.dateIso}`));
    const missing: string[] = [];
    await parseFilelist(sub, (e) => {
      if (!names.has(`${e.filename}\0${e.dateIso}`)) missing.push(`${e.filename} ${e.dateIso}`);
    });
    expect(missing).toEqual([]);
  }, 300000);
});
