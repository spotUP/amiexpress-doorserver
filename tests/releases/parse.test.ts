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
  matchExplicitUploader,
  normalizeUploader,
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
    // Uniform 33-padding lifts then strips: net left-aligned
    expect(entries[0].descLines).toEqual([
      'Double Dragon - Just like the arcade!',
      'Graphics could be a lot better though.',
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

  it('strips an inline DL\'s stamp, keeps art columns and the count', async () => {
    const text = [
      '[ File #3376 ]                   ·===============·',
      'FLT-TT2.DMS  DUMMY-SIZE  00-00-00  _______  /\\  _____',
      "                       DL's: 10  \\  ___//\\\\/ _  //",
      '                                 d/L tIMES: 14',
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries).toHaveLength(1);
    // d/L line wins over the stamp; stamp spaces restore the art columns
    expect(entries[0].dlCount).toBe(14);
    expect(entries[0].descLines[1]).toBe('\\  ___//\\\\/ _  //');
  });

  it('takes the stamp count when no d/L line exists', async () => {
    const text = [
      '[ File #1 ]                     ·===============·',
      'FOO.LHA      P 1234  01-01-90  _______  /\\',
      "                       DL's: 07      / __  /\\",
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries[0].dlCount).toBe(7);
    expect(entries[0].descLines[1]).toBe('/ __  /\\');
  });

  it('re-indents an art first line to its siblings, leaves prose alone', async () => {
    const pad = ' '.repeat(33);
    const text = [
      '[ File #1 ]                     ·===============·',
      'BK-HL1.DMS   P 856845  02-02-96  _|__  ___  __|_',
      `${pad}\\___)(___\\(___/ |`,
      '[ File #2 ]                     ·===============·',
      'DRAGON.WRP   N 756736  12-31-88  Double Dragon!',
      `${pad}Graphics could be a lot better though.`,
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries[0].descLines[0]).toBe('_|__  ___  __|_');
    expect(entries[1].descLines[0]).toBe('Double Dragon!');
  });

  it('aligns a sparse art block whose second line carries wide gaps', async () => {
    const pad = ' '.repeat(33);
    const text = [
      '[ File #9805 ]                  ·===============·',
      'BK-HSLH.LHA  P  83264  12-02-95  ______          __   __',
      `${pad}T ___ \\         | | / /`,
      `${pad}| | / /_______  ! l/ /_______  _  ___`,
    ].join('\n');
    const { entries } = await collect(text);
    // Uniform padding lifts then strips: net aligned at 0
    expect(entries[0].descLines[0]).toBe('______          __   __');
  });

  it('dedents uniform BBS column padding, keeping relative alignment', async () => {
    const pad = ' '.repeat(33);
    const text = [
      '[ File #1 ]                     ·===============·',
      'BK-HL1.DMS   P 856845  02-02-96  _|__  ___',
      `${pad}\\___)(___\\`,
      `${pad}  indented-two-deeper`,
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries[0].descLines).toEqual(['_|__  ___', '\\___)(___\\', '  indented-two-deeper']);
  });

  it('leaves prose and mixed-indent blocks alone', async () => {
    const text = [
      '[ File #1 ]                     ·===============·',
      'DRAGON.WRP   N 756736  12-31-88  Double Dragon!',
      '                                 Graphics here.',
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries[0].descLines[0]).toBe('Double Dragon!');
  });

  it('indents a ragged prose title to its sibling, no dedent under 15', async () => {
    const text = [
      '[ File #6325 ]                  ·===============·',
      'HF-HSL1.DMS  P 420799  11-30-95  Hillsea Lido ECS/AGA Disk [1/2]',
      '                    (c) Vulcan Software',
      '                              Iggy, The Newcomer..',
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries[0].descLines).toEqual([
      '                    Hillsea Lido ECS/AGA Disk [1/2]',
      '                    (c) Vulcan Software',
      '                              Iggy, The Newcomer..',
    ]);
  });

  it('repairs double-encoded Latin-1 (Â¬ -> ¬, Ã© -> é)', () => {
    expect(parseEntryLine('SUPERSKI.WRP P 397436  06-14-90  Super Ski [ Â© 1988 ]')?.firstDesc).toBe(
      'Super Ski [ © 1988 ]'
    );
    expect(parseEntryLine('FOO.LHA P 1  01-01-90  Grüße Âge Ã©')?.firstDesc).toBe('Grüße Âge é');
  });

  it('dedents a bulk indent with deeper outliers, keeping them relative', async () => {
    const pad = ' '.repeat(33);
    const text = [
      '[ File #9799 ]                  ·===============·',
      'FIX-HILL.LHA P 688128  12-02-95  ________.___',
      `${pad}\\_   ___|_`,
      ' '.repeat(39) + '¬\\____',
      ' '.repeat(45) + '(C) Vulka',
      `${pad}06:01:33  -=-  nODE:  1  -=-  cPS:  970  -=-`,
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries[0].descLines).toEqual([
      '________.___',
      '\\_   ___|_',
      '      ¬\\____',
      '            (C) Vulka',
      '06:01:33  -=-  nODE:  1  -=-  cPS:  970  -=-',
    ]);
  });

  it('drops trailing ornament and date lines of the next entry', async () => {
    const text = [
      '[ File #6449 ]                  ·===============·',
      'TURBO_T.NFO  P 1234  01-01-90  Turbo Trax info',
      '                                 :::[ MDR ]:::',
      '',
      '                                            _¸,ø*¤°¬°¤*ø,¸_',
      '      ¸,ø*¤°¬¯¬°¤*ø,¸ 08-21-95',
      '[ File #6450 ]                  ·===============·',
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries[0].descLines).toEqual(['Turbo Trax info', ':::[ MDR ]:::']);
  });

  it('records an anomaly when no entry line follows a marker', async () => {
    const { entries, anomalies } = await collect('[ File #9 ]\n[ End of File List ]\n');
    expect(entries).toHaveLength(0);
    expect(anomalies).toHaveLength(1);
  });
});

describe('explicit uploader trailers', () => {
  it('normalizes wrapping but keeps stylized nicks intact', () => {
    expect(normalizeUploader('  *** BLUEBEARD *** ')).toBe('BLUEBEARD');
    expect(normalizeUploader('-----[  EddiE  ]-----')).toBe('EddiE');
    expect(normalizeUploader('sHANE/CRUX!')).toBe('sHANE/CRUX!');
    expect(normalizeUploader('Sonic!')).toBe('Sonic!');
    expect(normalizeUploader('  SiDeSaLaD  ')).toBe('SiDeSaLaD');
  });

  it('rejects placeholder credits that name nobody', () => {
    expect(normalizeUploader('unknown')).toBeNull();
    expect(normalizeUploader(' - ')).toBeNull();
    expect(normalizeUploader('???')).toBeNull();
    expect(normalizeUploader('')).toBeNull();
  });

  it('matches the explicit credit forms and nothing else', () => {
    expect(matchExplicitUploader('Sent by: SiDeSaLaD')).toBe('SiDeSaLaD');
    expect(matchExplicitUploader('sent by AMON')).toBe('AMON');
    expect(matchExplicitUploader('Uploaded by THE TEA DRINKER')).toBe('THE TEA DRINKER');
    expect(matchExplicitUploader('Smashed by:   Belø\\X/ 0')).toBe('Belø\\X/ 0');
    expect(matchExplicitUploader('Supplied by DPJ/MYSTIC')).toBe('DPJ/MYSTIC');
    expect(matchExplicitUploader('Brought to you by QuAtRo')).toBe('QuAtRo');
    expect(matchExplicitUploader('Uploader: Amon HF')).toBe('Amon HF');
    expect(matchExplicitUploader('Another Graff-tastic upload by Graffito')).toBe('Graffito');
    // Courier/greet art and roles are NOT uploaders.
    expect(matchExplicitUploader('[-fAShbACk!-]¼[-sCX-][-mYtH-]')).toBeNull();
    expect(matchExplicitUploader('[-------------------------------( CASE )---]')).toBeNull();
    expect(matchExplicitUploader('Courier: Xad/Nightfall')).toBeNull();
    expect(matchExplicitUploader('Deep Core Fix (Classic Crack)')).toBeNull();
  });

  it('pulls a last-line Sent by credit out of the description', async () => {
    const text = [
      '[ File #1 ]                     ·===============·',
      'FIX.LHA      P 1234  01-01-90  Deep Core Fix (Classic Crack)',
      '                                 SideSalad',
      '                                 Sent by: SiDeSaLaD',
      '[ File #2 ]                     ·===============·',
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].uploader).toBe('SiDeSaLaD');
    expect(entries[0].descLines).toEqual(['Deep Core Fix (Classic Crack)', 'SideSalad']);
  });

  it('reads a top-of-block Uploader email header, keeps art credits as description', async () => {
    const text = [
      '[ File #1 ]                     ·===============·',
      'TOOL.LHA     P 1234  01-01-90  Uploader: Amon HF',
      '                                 A useful tool.',
      '                                 [-fAShbACk!-]¼[-sCX-][-mYtH-]',
      '[ File #2 ]                     ·===============·',
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].uploader).toBe('Amon HF');
    expect(entries[0].descLines).toContain('[-fAShbACk!-]¼[-sCX-][-mYtH-]');
  });

  it('does not read art title chevrons as uploaders', async () => {
    const text = [
      '[ File #1 ]                     ·===============·',
      'BEAST.LHA    P 1234  01-01-90  >>>>> -+- The Beast of Scoopex -+- welcome! <<<<<',
      '[ File #2 ]                     ·===============·',
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].uploader).toBeNull();
    expect(entries[0].descLines).toEqual(['>>>>> -+- The Beast of Scoopex -+- welcome! <<<<<']);
  });

  it('leaves entries with no credit line at null uploader', async () => {
    const text = [
      '[ File #1 ]                     ·===============·',
      'NOCRED.LHA   P 1234  01-01-90  Just a file.',
      '                                 [---( CASE )---]',
      '[ File #2 ]                     ·===============·',
    ].join('\n');
    const { entries } = await collect(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].uploader).toBeNull();
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
