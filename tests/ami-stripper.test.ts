/**
 * Tests for the scene ad/junk detection and archive stripping engine.
 *
 * Ports the key test cases from amiexpress-web's ami-stripper.lib.test.ts,
 * adapted for the doorserver's archive-reader.ts (LHA + ZIP) and CommonJS
 * module system.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyFile, deriveStripPlan, analyzeArchive, stripArchive, stripDizLines, type FingerprintDb } from '../src/ami-stripper';
import { findArchiverBinary, canDeleteMembers, deleteMembers, type ArchiveRunner } from '../src/lha-member-delete';

// ─── classifyFile (pure junk detection) ───────────────────────────────────────

describe('classifyFile', () => {
  const patterns = ['*read_this_first*', 'ad-*.txt'];
  const fingerprints: FingerprintDb = {
    [crypto.createHash('md5').update('known-junk-bytes').digest('hex')]: {
      filename: 'fingerprinted.txt',
      archiveCount: 12,
    },
  };

  it('flags a filename matching a scene-strip pattern', () => {
    expect(classifyFile('READ_THIS_FIRST.txt', Buffer.from('hello'), patterns, {})).toBe('pattern');
  });

  it('flags a filename matching an MD5 fingerprint regardless of its own name', () => {
    expect(classifyFile('totally-innocuous.dat', Buffer.from('known-junk-bytes'), [], fingerprints)).toBe('md5');
  });

  it('keeps a file that matches neither a pattern nor a fingerprint', () => {
    expect(classifyFile('DOOR.FIM', Buffer.from('binary door bytes'), patterns, fingerprints)).toBeNull();
  });

  it('protects a genuine Workbench .info icon even if its name matches a strip pattern', () => {
    const iconBuf = Buffer.concat([Buffer.from([0x00, 0x00, 0x03, 0xe7]), Buffer.from('icon data')]);
    expect(classifyFile('ad-this-is-junk.info', iconBuf, ['ad-*.info'], {})).toBeNull();
  });

  it('protects a genuine AmigaDOS hunk binary with no extension', () => {
    const hunkBuf = Buffer.concat([Buffer.from([0x00, 0x00, 0x03, 0xf3]), Buffer.from('code')]);
    expect(classifyFile('MYDOOR', hunkBuf, ['*'], {})).toBeNull();
  });

  it('protects a genuine AmigaGuide document', () => {
    const guideBuf = Buffer.from('@database MyDoc\n@node Main\nHello\n@endnode\n');
    expect(classifyFile('manual.guide', guideBuf, ['*.guide'], {})).toBeNull();
  });

  it('protects a binary .cfg but allows a text .cfg through to pattern/md5 checks', () => {
    const binaryCfg = Buffer.from([0x01, 0x02, 0xff, 0xfe, 0x00, 0x10]);
    expect(classifyFile('door.cfg', binaryCfg, ['door.cfg'], {})).toBeNull();

    const textCfg = Buffer.from('access=100\n');
    expect(classifyFile('door.cfg', textCfg, ['door.cfg'], {})).toBe('pattern');
  });

  it('always protects file_id.diz', () => {
    expect(classifyFile('file_id.diz', Buffer.from('call us at +1 555-1234'), ['file_id.diz'], {})).toBeNull();
  });

  it('flags filenames with illegal chars (#?*@|) as pattern', () => {
    // istrip06's whole design: random-rename ads use these chars
    expect(classifyFile('#?#?#?banner', Buffer.from('x'), [], {})).toBe('pattern');
    expect(classifyFile('*.*', Buffer.from('x'), [], {})).toBe('pattern');
    expect(classifyFile('foo@bar.txt', Buffer.from('x'), [], {})).toBe('pattern');
  });
});

// ─── stripDizLines (DIZ ad-phrase removal) ────────────────────────────────────

describe('stripDizLines', () => {
  it('drops lines matching ad phrases and keeps the rest', () => {
    const diz = 'A really cool door\nSPREAD BY ALPHA COURIERS\nGreat door for BBSes';
    const out = stripDizLines(diz, ['alpha couriers']);
    expect(out).toBe('A really cool door\nGreat door for BBSes');
  });

  it('returns null when every line is an ad phrase', () => {
    const diz = 'SPREAD BY RISC\nLEECHED FROM BEST BBS';
    expect(stripDizLines(diz, ['spread by', 'leeched from'])).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(stripDizLines('', ['anything'])).toBeNull();
  });

  it('is a no-op when no patterns match', () => {
    const diz = 'A clean door\nNo ads here';
    expect(stripDizLines(diz, ['spread by'])).toBe(diz);
  });
});

// ─── deriveStripPlan (strip-plan derivation) ──────────────────────────────────

describe('deriveStripPlan', () => {
  it('sorts entries into kept/stripped and records the reason per stripped path', () => {
    const plan = deriveStripPlan(
      [
        { path: 'DOOR.FIM', size: 100, buf: Buffer.from('binary door bytes') },
        { path: 'read_this_first.txt', size: 20, buf: Buffer.from('call the BBS at 555-1234') },
        { path: 'file_id.diz', size: 10, buf: Buffer.from('A cool door!') },
      ],
      ['read_this_first.txt'],
      {}
    );

    expect(plan.kept.map(e => e.path).sort()).toEqual(['DOOR.FIM', 'file_id.diz']);
    expect(plan.stripped.map(e => e.path)).toEqual(['read_this_first.txt']);
    expect(plan.reason['read_this_first.txt']).toBe('pattern');
  });

  it('computes a real md5 for every entry regardless of verdict', () => {
    const buf = Buffer.from('some content');
    const expectedMd5 = crypto.createHash('md5').update(buf).digest('hex');
    const plan = deriveStripPlan([{ path: 'a.txt', size: buf.length, buf }], [], {});
    expect(plan.kept[0].md5).toBe(expectedMd5);
  });

  it('returns everything kept for an empty pattern/fingerprint db', () => {
    const plan = deriveStripPlan(
      [{ path: 'anything.txt', size: 1, buf: Buffer.from('x') }],
      [],
      {}
    );
    expect(plan.stripped).toEqual([]);
    expect(plan.cleanedDiz).toBeNull();
  });

  it('produces cleanedDiz when FILE_ID.DIZ has ad-phrase lines', () => {
    const plan = deriveStripPlan(
      [
        { path: 'file_id.diz', size: 50, buf: Buffer.from('Great door!\nSPREAD BY ALPHA COURIERS\nVisit our BBS') },
        { path: 'door.bin', size: 100, buf: Buffer.from('binary') },
      ],
      [],
      {},
      ['spread by alpha couriers']
    );
    expect(plan.cleanedDiz).toBe('Great door!\nVisit our BBS');
  });
});

// ─── analyzeArchive (reads real ZIP files) ────────────────────────────────────

describe('analyzeArchive', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-strip-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeZip(entries: Array<{ name: string; content: string }>): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    for (const e of entries) {
      zip.addFile(e.name, Buffer.from(e.content));
    }
    const zipPath = path.join(tmpDir, 'test.zip');
    zip.writeZip(zipPath);
    return zipPath;
  }

  it('classifies files in a real ZIP archive', () => {
    // Use a pattern from the real seed data: "!call_diz_now!"
    const zipPath = writeZip([
      { name: 'DOOR.FIM', content: 'binary door bytes' },
      { name: '!call_diz_now!', content: 'some content' },
    ]);

    const result = analyzeArchive(zipPath);
    const allPaths = [...result.kept, ...result.stripped].map(e => e.path).sort();
    expect(allPaths).toContain('DOOR.FIM');
    expect(result.stripped.map(e => e.path)).toContain('!call_diz_now!');
  });

  it('throws for a non-existent file', () => {
    expect(() => analyzeArchive(path.join(tmpDir, 'nope.zip'))).toThrow();
  });

  it('throws for an unsupported format', () => {
    const rarPath = path.join(tmpDir, 'test.rar');
    fs.writeFileSync(rarPath, Buffer.from('not really RAR'));
    expect(() => analyzeArchive(rarPath)).toThrow(/unsupported/i);
  });

  it('ignores a bare "*" extra pattern instead of flagging every file as junk', () => {
    // Ad-randomizers often name their payload a literal '*'. If that
    // filename is ever "learned" as a junk pattern (e.g. a bad row already
    // in learned_junk_patterns, or a future call site that forgets to
    // guard on write), analyzeArchive must not let it nuke every member of
    // every other archive it previews.
    const zipPath = writeZip([
      { name: 'DOOR.FIM', content: 'binary door bytes' },
      { name: 'TOTALLY_SAFE_FILE.TXT', content: 'legit door documentation' },
      { name: '*', content: 'the ad-randomizer payload itself' },
    ]);

    const result = analyzeArchive(zipPath, ['*']);
    expect(result.kept.map((e) => e.path)).toContain('DOOR.FIM');
    expect(result.kept.map((e) => e.path)).toContain('TOTALLY_SAFE_FILE.TXT');
    // The literal '*' member is still caught on its own merits
    // (ILLEGAL_FILENAME_CHARS), just not via the poisoned glob.
    expect(result.stripped.map((e) => e.path)).toEqual(['*']);
  });
});

// ─── stripArchive (ZIP repack) ────────────────────────────────────────────────

describe('stripArchive', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-repack-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeZip(entries: Array<{ name: string; content: string }>): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    for (const e of entries) {
      zip.addFile(e.name, Buffer.from(e.content));
    }
    const zipPath = path.join(tmpDir, 'test.zip');
    zip.writeZip(zipPath);
    return zipPath;
  }

  it('forces the output extension to .zip regardless of the requested outPath extension', () => {
    const zipPath = writeZip([{ name: 'DOOR.FIM', content: 'binary door bytes' }]);
    const result = stripArchive(zipPath, path.join(tmpDir, 'clean.lha'));
    expect(result.outputPath).toBe(path.join(tmpDir, 'clean.zip'));
    expect(fs.existsSync(result.outputPath)).toBe(true);
  });

  it('drops junk files from the repacked archive', () => {
    const zipPath = writeZip([
      { name: 'DOOR.FIM', content: 'binary door bytes' },
      { name: '!call_diz_now!', content: 'some content' },
    ]);

    const result = stripArchive(zipPath, path.join(tmpDir, 'clean.zip'));
    expect(result.stripped.map(e => e.path)).toContain('!call_diz_now!');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AdmZip = require('adm-zip');
    const outZip = new AdmZip(result.outputPath);
    const outNames = outZip.getEntries().map((e: any) => e.entryName);
    expect(outNames).toContain('DOOR.FIM');
    expect(outNames).not.toContain('!call_diz_now!');
  });

  it('keeps a flagged file when its path is in preservePaths', () => {
    const zipPath = writeZip([
      { name: '!call_diz_now!', content: 'some content' },
    ]);

    const result = stripArchive(zipPath, path.join(tmpDir, 'clean.zip'), new Set(['!call_diz_now!']));
    expect(result.stripped.map(e => e.path)).toContain('!call_diz_now!');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AdmZip = require('adm-zip');
    const outZip = new AdmZip(result.outputPath);
    const outNames = outZip.getEntries().map((e: any) => e.entryName);
    expect(outNames).toContain('!call_diz_now!');
  });
});

// ─── lha-member-delete ────────────────────────────────────────────────────────

describe('lha-member-delete', () => {
  it('findArchiverBinary returns a path or null', () => {
    const result = findArchiverBinary();
    // On macOS with brew, this should find /opt/homebrew/bin/lha
    // On CI it may be null — that's fine, the function works correctly
    expect(typeof result === 'string' || result === null).toBe(true);
  });

  it('canDeleteMembers rejects non-LHA formats', () => {
    expect(canDeleteMembers('/tmp/test.lzx')).toEqual({
      ok: false,
      reason: 'LZX archives cannot be rewritten here: this server can read LZX but has no LZX writer.',
    });
  });

  it('canDeleteMembers rejects when no binary is available', () => {
    expect(canDeleteMembers('/tmp/test.lha', null)).toEqual({
      ok: false,
      reason: 'No archiver binary available on this server.',
    });
  });

  it('canDeleteMembers accepts LHA with a binary', () => {
    expect(canDeleteMembers('/tmp/test.lha', '/usr/bin/lha')).toEqual({ ok: true });
  });

  it('canDeleteMembers accepts LZH with a binary', () => {
    expect(canDeleteMembers('/tmp/test.lzh', '/usr/bin/lha')).toEqual({ ok: true });
  });

  it('deleteMembers returns early for empty member list', () => {
    const mockRunner: ArchiveRunner = () => ({ status: 0, stdout: '', stderr: '' });
    const result = deleteMembers('/tmp/test.lha', [], { binary: '/usr/bin/lha', runner: mockRunner });
    expect(result).toEqual({ ok: true, removed: 0 });
  });

  it('deleteMembers invokes lha d with all members', () => {
    const mockRunner: ArchiveRunner = (bin, args) => {
      expect(bin).toBe('/usr/bin/lha');
      expect(args[0]).toBe('dq');
      expect(args).toContain('--archive-kanji-code=latin1');
      expect(args).toContain('--system-kanji-code=utf8');
      expect(args).toContain('/tmp/test.lha');
      expect(args).toContain('file1.nfo');
      expect(args).toContain('file2.txt');
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = deleteMembers('/tmp/test.lha', ['file1.nfo', 'file2.txt'], {
      binary: '/usr/bin/lha',
      runner: mockRunner,
    });
    expect(result).toEqual({ ok: true, removed: 2 });
  });

  it('falls back to cap encoding when lha fails with iconv error', () => {
    let attempt = 0;
    const mockRunner: ArchiveRunner = (bin, args) => {
      attempt++;
      if (attempt === 1) {
        expect(args).toContain('--archive-kanji-code=latin1');
        return { status: 1, stdout: '', stderr: 'LHa: Error: iconv() failure: Illegal byte sequence' };
      }
      expect(args).toContain('--archive-kanji-code=cap');
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = deleteMembers('/tmp/test.lha', ['file.nfo'], {
      binary: '/usr/bin/lha',
      runner: mockRunner,
    });
    expect(result.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it('deleteMembers reports lha failures', () => {
    const mockRunner: ArchiveRunner = () => ({ status: 1, stdout: '', stderr: 'lha: archive not found' });
    const result = deleteMembers('/tmp/test.lha', ['file.nfo'], {
      binary: '/usr/bin/lha',
      runner: mockRunner,
    });
    expect(result.ok).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.reason).toContain('exited 1');
    expect(result.reason).toContain('lha: archive not found');
  });

  it('prefixes member names starting with - to avoid lha option parsing', () => {
    const mockRunner: ArchiveRunner = (bin, args) => {
      expect(args).toContain('./-foo.txt');
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = deleteMembers('/tmp/test.lha', ['-foo.txt'], {
      binary: '/usr/bin/lha',
      runner: mockRunner,
    });
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(1);
  });

  // Regression for a live incident: the classifier's illegal-filename-char
  // rule (# ? * @ |) deliberately catches obfuscated ad files literally
  // named things like "*" - passing that straight to `lha dq`/`7z d`
  // deletes EVERY member (both tools do their own glob matching on delete
  // args, independent of argv/shell quoting), and since lha auto-deletes
  // an archive once it's empty, this destroyed real catalog archives in
  // production. Reproduced against the real lha binary before writing
  // this fix: `lha dq test.lha '*'` on a 2-member archive left "Cannot
  // open archive" - the file was gone.
  it('refuses to delete a member named with a bare wildcard character', () => {
    const mockRunner: ArchiveRunner = () => {
      throw new Error('must not invoke the archiver for a wildcard-only member list');
    };
    const result = deleteMembers('/tmp/test.lha', ['*'], {
      binary: '/usr/bin/lha',
      runner: mockRunner,
    });
    expect(result.ok).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.skipped).toEqual(['*']);
    expect(result.reason).toContain('wildcard');
  });

  it('deletes the safe members and skips only the wildcard-named one', () => {
    const mockRunner: ArchiveRunner = (bin, args) => {
      expect(args).toContain('mastrb8.txt');
      expect(args).not.toContain('*');
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = deleteMembers('/tmp/test.lha', ['*', 'mastrb8.txt'], {
      binary: '/usr/bin/lha',
      runner: mockRunner,
    });
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(1);
    expect(result.skipped).toEqual(['*']);
  });

  it('also refuses a bare ? member name', () => {
    const mockRunner: ArchiveRunner = () => {
      throw new Error('must not invoke the archiver for a wildcard-only member list');
    };
    const result = deleteMembers('/tmp/test.lha', ['?'], {
      binary: '/usr/bin/lha',
      runner: mockRunner,
    });
    expect(result.ok).toBe(false);
    expect(result.skipped).toEqual(['?']);
  });
});
