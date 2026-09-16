#!/usr/bin/env npx tsx

/**
 * Harvest BBS-ad seeds from the Demozoo text-ad corpus.
 *
 *   patterns: every census ORIGINAL filename (the name the file carries
 *     inside door archives) not already covered, into
 *     seeds/scene-strip-patterns.json > filenamePatterns.
 *   fingerprints: md5 of every dump file into seeds/junk-fingerprints.json.
 *
 * Safety rules (the curation bar, from the existing seed set):
 *   - never a match-all glob (isMatchAllGlob guard, same as /learn routes).
 *   - skip names containing * ? # @ | - archive members with those are
 *     auto-flagged by classifyFile's illegal-char rule, so learning them
 *     adds nothing.
 *   - bare-generic short names (len < 5, pure alnum, e.g. AD, 1, 666) are
 *     left out: a false filename pattern strips a legit door file, while a
 *     miss only leaves junk listed. Byte-identical files are still caught
 *     by the md5 tier. Grandfathered shorts already in the seed set
 *     (add, readme, doc, info) are untouched.
 *   - fingerprints are byte-exact: zero false-positive risk beyond identity.
 *
 * Re-runnable: skips patterns/fingerprints already present. Re-run when the
 * census completes - the partial index undercounts the corpus.
 *
 * Usage:
 *   npx tsx scripts/harvest-bbs-ad-seeds.ts [--index data/demozoo-textads-index.jsonl --dir bbs_ads --dry]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (n: string, d: string): string => {
    const i = args.indexOf(n);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
  };
  return {
    index: get('--index', 'data/demozoo-textads-index.jsonl'),
    dir: get('--dir', 'bbs_ads'),
    dry: args.includes('--dry'),
  };
}

interface CensusRow {
  bbs_id: number;
  bbs_name: string;
  ad_id: number;
  filename: string;
  filesize: number;
  page_url: string;
}

/** Port of src/ami-stripper.ts matchesPattern (case-insensitive full glob). */
function matchesPattern(filename: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  try {
    return new RegExp(regexStr, 'i').test(filename);
  } catch {
    return false;
  }
}

/** Port of src/ami-stripper.ts isMatchAllGlob. */
function isMatchAllGlob(pattern: string): boolean {
  return /^[*?]+$/.test(pattern) || /^\.\*(\.\*)*$/.test(pattern);
}

const AUTO_CAUGHT = /[*?#@|]/;
const BARE_GENERIC = /^[A-Za-z0-9]{1,4}$/;
/**
 * Forensically cleared as MIXED content (scripts/probe-flagged-members.ts,
 * 2026-09-16): door archives carry legit files under these names (an IFF
 * ANIM + door docs for docs.TXT; release/dev notes for READ_ME.TXT), so the
 * name tier must not claim them. The md5 tier still catches byte-identical
 * ad copies.
 */
const HOLDOUT = new Set(['docs.txt', 'read_me.txt']);

function main(): void {
  const { index, dir, dry } = parseArgs();

  const rows: CensusRow[] = fs
    .readFileSync(index, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CensusRow);
  // Original page-title filenames, deduped case-insensitively.
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of rows) {
    const k = r.filename.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      names.push(r.filename);
    }
  }
  console.log(`census rows: ${rows.length}, distinct filenames: ${names.length}`);

  const patPath = path.join('seeds', 'scene-strip-patterns.json');
  const fpPath = path.join('seeds', 'junk-fingerprints.json');
  const patDb = JSON.parse(fs.readFileSync(patPath, 'utf8')) as {
    filenamePatterns: string[];
    dizPatterns: string[];
  };
  const fpDb = JSON.parse(fs.readFileSync(fpPath, 'utf8')) as Record<
    string,
    { filename: string; md5?: string; archiveCount: number; archives?: string[]; methods?: string[]; source?: string }
  >;
  const existing = patDb.filenamePatterns;

  let covered = 0;
  let skippedAuto = 0;
  let skippedGeneric = 0;
  let skippedGlob = 0;
  const fresh: string[] = [];
  for (const name of names) {
    if (isMatchAllGlob(name)) {
      skippedGlob++;
      continue;
    }
    if (HOLDOUT.has(name.toLowerCase())) {
      skippedGeneric++;
      continue;
    }
    if (AUTO_CAUGHT.test(name)) {
      skippedAuto++;
      continue;
    }
    if (BARE_GENERIC.test(name)) {
      skippedGeneric++;
      continue;
    }
    if (existing.some((p) => matchesPattern(name, p)) || fresh.some((p) => matchesPattern(name, p))) {
      covered++;
      continue;
    }
    fresh.push(name);
  }
  console.log(
    `patterns: fresh=${fresh.length} already_covered=${covered} auto_caught=${skippedAuto} bare_generic=${skippedGeneric} match_all=${skippedGlob}`
  );

  // Fingerprints: every dump file. Prefer the census original filename when
  // exactly one census row shares the file's (dump-name-insensitive) identity;
  // fall back to the stored name. Identity collisions collapse to one entry.
  const byStored = new Map<string, CensusRow[]>();
  for (const r of rows) {
    const k = `${r.filename}\0${r.filesize}`;
    if (!byStored.has(k)) byStored.set(k, []);
    byStored.get(k)!.push(r);
  }
  const files = fs.readdirSync(dir);
  let fpNew = 0;
  let fpDupBytes = 0;
  let fpPresent = 0;
  for (const name of files) {
    const fp = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(fp);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const md5 = crypto.createHash('md5').update(fs.readFileSync(fp)).digest('hex');
    if (fpDb[md5]) {
      fpPresent++;
      continue;
    }
    const owners = (byStored.get(`${name}\0${st.size}`) ?? []).map((r) => r.filename);
    const uniqOwners = [...new Set(owners)];
    fpDb[md5] = {
      filename: uniqOwners.length === 1 ? uniqOwners[0] : name,
      md5,
      archiveCount: 0,
      methods: ['md5'],
      source: 'demozoo-bbs-ad',
    };
    fpNew++;
    void fpDupBytes;
  }
  // Same bytes under two stored names collapse: count them for the report.
  const md5Count = new Map<string, number>();
  for (const name of files) {
    const fp = path.join(dir, name);
    try {
      if (!fs.statSync(fp).isFile()) continue;
      const md5 = crypto.createHash('md5').update(fs.readFileSync(fp)).digest('hex');
      md5Count.set(md5, (md5Count.get(md5) ?? 0) + 1);
    } catch { /* ignore */ }
  }
  let dupSets = 0;
  for (const [, n] of md5Count) if (n > 1) dupSets++;
  console.log(`fingerprints: new=${fpNew} already_present=${fpPresent} dup_byte_sets=${dupSets}`);

  if (dry) {
    console.log('dry run: seeds untouched');
    console.log(`pattern sample: ${JSON.stringify(fresh.slice(0, 10))}`);
    return;
  }
  patDb.filenamePatterns = [...existing, ...fresh];
  const orderedFp: typeof fpDb = {};
  for (const k of Object.keys(fpDb).sort()) orderedFp[k] = fpDb[k];
  fs.writeFileSync(patPath, JSON.stringify(patDb, null, 2) + '\n');
  fs.writeFileSync(fpPath, JSON.stringify(orderedFp, null, 2) + '\n');
  console.log('seeds written');
}

main();
