#!/usr/bin/env npx tsx

/**
 * BBS text-ads database import.
 *
 * Joins two sources into data/bbs_ads.db:
 *   1. bbs_ads/           - flat dump of raw ad files from Demozoo's bbs_ads/
 *                           media store (Django FileField; name collisions got
 *                           a _XXXXXXX suffix before the extension).
 *   2. data/demozoo-textads-index.jsonl - the public-page census:
 *                           {bbs_id, bbs_name, ad_id, filename, filesize, page_url}
 *
 * Linkage key is (filename, filesize): exact match first, then Django-suffix
 * stripped. Files with no census row go in unlinked; census rows with no file
 * are reported (dump gap).
 *
 * Schema:
 *   bbs(bbs_id PK, name, bbs_url)
 *   text_ad(ad_id PK, bbs_id FK, filename, filesize, stored_filename,
 *           content BLOB, sha1, size_bytes, is_ansi, encoding_used,
 *           text, page_url, imported_at)
 *   text_ad_fts(fts5 over filename + text)
 *
 * Decoding: raw bytes are scene text, usually CP437 (ANSI/ASCII art) or
 * Latin-1/Amiga. Try UTF-8 strict first (some are clean ASCII/UTF-8), then
 * CP437, which never fails and keeps box-drawing intact. encoding_used
 * records which one won.
 *
 * Usage:
 *   npx tsx scripts/demozoo-textads-import.ts [--db data/bbs_ads.db]
 *   npx tsx scripts/demozoo-textads-import.ts --db /tmp/test.db --index data/demozoo-textads-index.jsonl --dir bbs_ads
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseAd, maskPhone } from '../contract/bbsad';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (n: string, d: string): string => {
    const i = args.indexOf(n);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
  };
  return {
    db: get('--db', 'data/bbs_ads.db'),
    index: get('--index', 'data/demozoo-textads-index.jsonl'),
    dir: get('--dir', 'bbs_ads'),
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

/** Strip Django's _XXXXXXX collision suffix. Returns base + hadSuffix. */
function stripDjangoSuffix(name: string): { base: string; stripped: boolean } {
  const m = /^(.+)_([A-Za-z0-9]{7})(\.[^.]*?)?$/.exec(name);
  if (!m) return { base: name, stripped: false };
  return { base: m[1] + (m[3] ?? ''), stripped: true };
}

/**
 * The dump's filenames went through a slugify on the way out. Observed
 * through (census → dump) pairs: NFD + combining marks stripped (À→A,
 * Î→I), shell-unsafe chars removed (! # & ' " · [ ] ( ) = ° +), spaces →
 * underscores, everything else (incl. ½ ¾ ^ $ ~) kept as-is.
 * Fingerprint both sides through the same sieve. Edge underscores squeeze
 * to one (a removed "=" next to a space leaves a doubled edge the dump
 * does not have); interior runs are kept (ACE__BBS.6_0 proves it).
 */
const FINGER_STRIP_RE = /[!#&'"·[\]()=°+~^%$¨¯¸®¬■¡@`\u00a0\u00ad;─-╿▉-▟]/g;

/**
 * Slug fingerprints, with and without combining-mark stripping: most
 * stored names flatten À→A, but some keep precomposed Ó/Æ. Both variants
 * are indexed and queried; a hit on either (size-strict) links.
 */
function fingerprints(name: string): [string, string] {
  const scrubbed = name.replace(FINGER_STRIP_RE, '').replace(/ /g, '_');
  const flat = scrubbed.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const edge = (s: string): string => s.replace(/^_+/, '_').replace(/_+$/, '_');
  return [edge(flat), edge(scrubbed)];
}

/** CP437 upper half (0x80-0xFF). 0x00-0x7F is plain ASCII. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(buf: Buffer): string {
  let out = '';
  for (const b of buf) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

function decodeScene(buf: Buffer): { text: string; encoding: string } {
  // Strict UTF-8 first: clean ASCII/UTF-8 files decode exactly.
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text: t, encoding: 'utf-8' };
  } catch { /* fall through */ }
  // CP437: the scene encoding for ANSI/ASCII art; decodes every byte,
  // keeps box-drawing (0xB0-0xDF) intact instead of mojibake-ing it.
  return { text: decodeCp437(buf), encoding: 'cp437' };
}

function main(): void {
  const { db, index, dir } = parseArgs();

  const rows: CensusRow[] = fs
    .readFileSync(index, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CensusRow);
  console.log(`census rows: ${rows.length}`);

  // Index dump files by (name, size) and by stripped (name, size).
  // NOTE: stripDjangoSuffix false-positives on legit names ending in
  // _XXXXXXX (e.g. 5nds_po_brennet), so the fingerprint map carries BOTH
  // the full name and the stripped base; full-name hits win.
  const files = fs.readdirSync(dir);
  const exact = new Map<string, string[]>(); // "name\0size" -> stored names
  const stripped = new Map<string, string[]>();
  const finger = new Map<string, string[]>(); // slugified "name\0size"
  const fingerFull = new Set<string>(); // keys with a full-name (non-suffix) contributor
  const nocase = new Map<string, string[]>(); // lower("name\0size")
  const nocaseSlug = new Map<string, string[]>(); // lower(slug("name\0size"))
  for (const name of files) {
    const st = fs.statSync(path.join(dir, name));
    if (!st.isFile()) continue;
    const k = `${name}\0${st.size}`;
    if (!exact.has(k)) exact.set(k, []);
    exact.get(k)!.push(name);
    const kl = `${name.toLowerCase()}\0${st.size}`;
    if (!nocase.has(kl)) nocase.set(kl, []);
    nocase.get(kl)!.push(name);
    const addFinger = (keyName: string, full: boolean): void => {
      for (const fp of fingerprints(keyName)) {
        const kf = `${fp}\0${st.size}`;
        if (!finger.has(kf)) finger.set(kf, []);
        finger.get(kf)!.push(name);
        if (full) fingerFull.add(`${kf}\0${name}`);
        const kl = `${fp.toLowerCase()}\0${st.size}`;
        if (!nocaseSlug.has(kl)) nocaseSlug.set(kl, []);
        nocaseSlug.get(kl)!.push(name);
      }
    };
    addFinger(name, true);
    const { base, stripped: was } = stripDjangoSuffix(name);
    if (was) {
      const ks = `${base}\0${st.size}`;
      if (!stripped.has(ks)) stripped.set(ks, []);
      stripped.get(ks)!.push(name);
      addFinger(base, false);
    }
  }
  console.log(`dump files: ${files.length}`);

  if (fs.existsSync(db)) fs.unlinkSync(db);
  const d = new Database(db);
  d.exec(`
    CREATE TABLE bbs(
      bbs_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      bbs_url TEXT NOT NULL
    );
    CREATE TABLE text_ad(
      ad_id INTEGER PRIMARY KEY,
      bbs_id INTEGER NOT NULL REFERENCES bbs(bbs_id),
      filename TEXT NOT NULL,
      filesize INTEGER NOT NULL,
      stored_filename TEXT NOT NULL,
      link_method TEXT NOT NULL,
      content BLOB NOT NULL,
      sha1 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      is_ansi INTEGER NOT NULL,
      encoding_used TEXT NOT NULL,
      text TEXT NOT NULL,
      page_url TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      size_mismatch INTEGER NOT NULL DEFAULT 0,
      phones_json TEXT NOT NULL DEFAULT '[]',
      nodes INTEGER,
      handles_json TEXT NOT NULL DEFAULT '[]',
      groups_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX idx_text_ad_bbs ON text_ad(bbs_id);
    CREATE VIRTUAL TABLE text_ad_fts USING fts5(filename, text, content='text_ad', content_rowid='ad_id');
  `);

  const insBbs = d.prepare(
    `INSERT OR IGNORE INTO bbs(bbs_id, name, bbs_url) VALUES(?, ?, ?)`
  );
  const insAd = d.prepare(
    `INSERT INTO text_ad(ad_id, bbs_id, filename, filesize, stored_filename, link_method,
       content, sha1, size_bytes, is_ansi, encoding_used, text, page_url, size_mismatch,
       phones_json, nodes, handles_json, groups_json)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insFts = d.prepare(
    `INSERT INTO text_ad_fts(rowid, filename, text) VALUES(?, ?, ?)`
  );

  let linked = 0;
  let ambiguous = 0;
  let missing = 0;
  const usedFiles = new Set<string>();
  const missingRows: CensusRow[] = [];

  /** Size-strict match: exact, Django-suffix, then slug fingerprint. */
  function matchStrict(r: CensusRow): { stored: string; method: string } | 'ambiguous' | null {
    const k = `${r.filename}\0${r.filesize}`;
    const ex = (exact.get(k) ?? []).filter((n) => !usedFiles.has(n));
    if (ex.length > 0) return { stored: ex[0], method: 'exact' };
    const st = (stripped.get(k) ?? []).filter((n) => !usedFiles.has(n));
    if (st.length === 1) return { stored: st[0], method: 'suffix' };
    if (st.length > 1) return 'ambiguous';
    // Slugified dump names. Both variants (marks stripped / kept) are
    // queried; union, dedupe, prefer full-name-derived hits over
    // suffix-derived ones (a legit _XXXXXXX tail is indexed both ways).
    const seen = new Set<string>();
    const fullC: string[] = [];
    const sufC: string[] = [];
    for (const fp of fingerprints(r.filename)) {
      const kf = `${fp}\0${r.filesize}`;
      for (const n of finger.get(kf) ?? []) {
        if (usedFiles.has(n) || seen.has(n)) continue;
        seen.add(n);
        (fingerFull.has(`${kf}\0${n}`) ? fullC : sufC).push(n);
      }
    }
    const uniq = [...new Set(fullC.length > 0 ? fullC : sufC)];
    if (uniq.length === 1) return { stored: uniq[0], method: 'finger' };
    if (uniq.length > 1) return 'ambiguous';
    // Case drift between the page title and the stored file (observed:
    // advert→aDVERt, advanced.pulse→ADVANCED.PULSE). Size still exact.
    // bLACK_mOON!→Black_Moon needs slug+case together, hence nocaseSlug.
    const nc = (nocase.get(k.toLowerCase()) ?? []).filter((n) => !usedFiles.has(n));
    if (nc.length === 1) return { stored: nc[0], method: 'nocase' };
    if (nc.length > 1) return 'ambiguous';
    const ncs = new Set<string>();
    for (const fp of fingerprints(r.filename)) {
      for (const n of nocaseSlug.get(`${fp.toLowerCase()}\0${r.filesize}`) ?? []) {
        if (!usedFiles.has(n)) ncs.add(n);
      }
    }
    if (ncs.size === 1) return { stored: [...ncs][0], method: 'nocase_slug' };
    if (ncs.size > 1) return 'ambiguous';
    return null;
  }

  function insert(r: CensusRow, stored: string, method: string): void {
    const buf = fs.readFileSync(path.join(dir, stored));
    const { text, encoding } = decodeScene(buf);
    const sizeMismatch = buf.length !== r.filesize ? 1 : 0;
    const parsed = parseAd(text);
    insAd.run(
      r.ad_id,
      r.bbs_id,
      r.filename,
      r.filesize,
      stored,
      method,
      buf,
      crypto.createHash('sha1').update(buf).digest('hex'),
      buf.length,
      buf.includes(0x1b) && buf.includes(0x5b) ? 1 : 0,
      encoding,
      text,
      r.page_url,
      sizeMismatch,
      JSON.stringify(parsed.phones.map(maskPhone)),
      parsed.nodes,
      JSON.stringify(parsed.handles),
      JSON.stringify(parsed.groups)
    );
    insFts.run(r.ad_id, r.filename, text);
    usedFiles.add(stored);
    linked++;
  }

  const txn = d.transaction(() => {
    for (const r of rows) {
      insBbs.run(r.bbs_id, r.bbs_name, `https://demozoo.org/bbs/${r.bbs_id}/`);
    }
    // Pass 1: size-strict. Pass 2 (name-only, records size_mismatch) runs
    // after so drift rows can never steal a size-correct row's file.
    const deferred: CensusRow[] = [];
    for (const r of rows) {
      const m = matchStrict(r);
      if (m === 'ambiguous') {
        ambiguous++;
      } else if (m) {
        insert(r, m.stored, m.method);
      } else {
        deferred.push(r);
      }
    }
    for (const r of deferred) {
      const byName = files.filter(
        (n) => !usedFiles.has(n) && (n === r.filename || stripDjangoSuffix(n).base === r.filename)
      );
      if (byName.length === 1) {
        insert(r, byName[0], 'name_drift');
      } else {
        if (byName.length > 1) ambiguous++;
        else {
          missing++;
          missingRows.push(r);
        }
      }
    }
  });
  txn();

  const unlinked = files.filter((n) => {
    try {
      return fs.statSync(path.join(dir, n)).isFile() && !usedFiles.has(n);
    } catch {
      return false;
    }
  });

  const stats = d.prepare(
    `SELECT COUNT(*) AS ads, COUNT(DISTINCT bbs_id) AS bbses,
            SUM(size_bytes) AS bytes, SUM(is_ansi) AS ansi,
            SUM(size_mismatch) AS mismatched FROM text_ad`
  ).get() as Record<string, number>;
  const enc = d.prepare(
    `SELECT encoding_used, COUNT(*) AS n FROM text_ad GROUP BY 1`
  ).all();

  console.log(
    `linked=${linked} ambiguous=${ambiguous} missing_file=${missing} unlinked_files=${unlinked.length}`
  );
  console.log(`db: ${stats.ads} ads, ${stats.bbses} bbses, ${stats.bytes} bytes, ansi=${stats.ansi}, size_mismatch=${stats.mismatched}`);
  console.log(`encodings: ${JSON.stringify(enc)}`);
  console.log(`methods: ${JSON.stringify(d.prepare(`SELECT link_method, COUNT(*) AS n FROM text_ad GROUP BY 1`).all())}`);
  if (missingRows.length > 0) {
    console.log(`first 10 missing: ${JSON.stringify(missingRows.slice(0, 10))}`);
  }
  if (unlinked.length > 0 && unlinked.length <= 20) {
    console.log(`unlinked: ${JSON.stringify(unlinked)}`);
  }
  d.close();
}

main();
