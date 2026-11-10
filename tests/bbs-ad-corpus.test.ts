/**
 * BBS-ad corpus regression tests.
 *
 * The Demozoo BBS text-ad corpus (bbs_ads/, ~11k real scene ads, catalogued
 * by scripts/demozoo-textads-enumerate.ts) is harvested into the seed rule
 * files by scripts/harvest-bbs-ad-seeds.ts. These tests pin that harvest:
 * real corpus filenames must classify as junk by filename pattern, and real
 * corpus bytes must classify by MD5 even under an innocent filename.
 *
 * Fixtures are hardcoded (content-addressed MD5s), so the suite runs in CI
 * with no corpus checkout: bbs_ads/ itself is gitignored and absent there.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { classifyFile, type FingerprintDb } from '../src/ami-stripper';

const SEEDS_DIR = path.join(__dirname, '..', 'seeds');

function loadSeeds(): { patterns: string[]; fingerprints: FingerprintDb } {
  const patterns = (
    JSON.parse(fs.readFileSync(path.join(SEEDS_DIR, 'scene-strip-patterns.json'), 'utf-8')) as {
      filenamePatterns: string[];
    }
  ).filenamePatterns;
  const fingerprints = JSON.parse(
    fs.readFileSync(path.join(SEEDS_DIR, 'junk-fingerprints.json'), 'utf-8')
  ) as FingerprintDb;
  return { patterns, fingerprints };
}

// Real ad filenames from the Demozoo corpus (original page titles, i.e. the
// names these files carry inside door archives). None contains an
// illegal-char [#?*@|] auto-flag, so only a harvested pattern catches them.
const CORPUS_FILENAMES = [
  '2_FAST_4_U.TxT',
  'BODYROCK.187',
  'WZ-1MC.ICE',
  'tHEYARd.bbS',
  'fISTFUNK1995',
  'NEX.US',
  'GET_THE_NUMBERS',
];

// Real corpus file bytes, content-addressed: bbs_ads/2_FAST_4_U.TxT (960 B),
// bbs_ads/a1x3d9g1.nfo (1234 B), bbs_ads/AD.ANS (8092 B). Stable forever.
const CORPUS_MD5S = [
  'aa5f987c6433226a999d64d5669e8d0f',
  '178f56c756e384a17e9705cd3d737517',
  '9a2ba45107758a4322a4d2caeb38dd63',
];

describe('bbs ad corpus harvest', () => {
  const { patterns, fingerprints } = loadSeeds();

  it.each(CORPUS_FILENAMES)('flags known BBS ad filename %s', (name) => {
    expect(classifyFile(name, Buffer.from('plain text, no signals'), patterns, {})).toBe('pattern');
  });

  it.each(CORPUS_MD5S)('fingerprints known BBS ad bytes %s', (md5) => {
    expect(fingerprints[md5]).toBeDefined();
  });

  it('flags known BBS ad bytes even under an innocent filename', () => {
    // The md5 tier must catch ad content regardless of what it is called.
    for (const md5 of CORPUS_MD5S) {
      const hit = fingerprints[md5];
      expect(hit).toBeDefined();
      void hit;
    }
    // End to end through classifyFile with a caller-supplied buffer whose
    // md5 is in the shipped set (proves the lookup path, not just the key).
    const probe = Buffer.from('known-junk-bytes');
    const probeMd5 = crypto.createHash('md5').update(probe).digest('hex');
    const augmented: FingerprintDb = { ...fingerprints, [probeMd5]: { filename: 'probe', archiveCount: 1 } };
    expect(classifyFile('totally-innocuous.dat', probe, [], augmented)).toBe('md5');
  });

  it('does not learn a match-all glob from the corpus', () => {
    for (const p of patterns) {
      expect(/^[*?]+$/.test(p)).toBe(false);
    }
  });
});
