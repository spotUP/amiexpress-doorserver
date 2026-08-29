#!/usr/bin/env npx tsx

/**
 * Demozoo BBS Door Importer
 *
 * Imports AMIExpress BBS doors from demozoo.org into the local catalog.
 * Tags: amiex, daydream-amiga, fame
 *
 * Two phases:
 * Phase 1 — Backfill: for each demozoo production whose filename matches a local
 *   archive_name, backfill NULL columns with demozoo metadata.
 * Phase 2 — New doors: for demozoo productions with no local match, try to
 *   download from scene.org and insert directly into door_catalog.
 *
 * Re-runnable: tracks imported demozoo IDs in demozoo_imported table.
 * Admin identity for audit: NULL → 'system' via COALESCE fallback in recordAudit.
 */

import Database from 'better-sqlite3';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { recordAudit } from '../src/auth';

// Each tag entry knows what demozoo calls it AND what it implies about
// requires_bbs. The tag itself is descriptive (e.g. "mystic-bbs");
// the implies field is the value to write into door_catalog.requires_bbs
// for any production found under that tag. All of these are Amiga BBS
// systems — PC-only ones are kept below, commented out, so the curator
// can opt in to PC doors later by removing the //.
//
// Source: https://demozoo.org/pages/bbs-related-tags/  (curated by
// Demozoo — covers all known scene-BBS software).
const TAGS: { tag: string; implies: string }[] = [
  // ── Amiga BBS software ──────────────────────────────────────────────────
  { tag: 'amiex',         implies: 'AmiExpress' },        // 50+ productions
  { tag: 'ami-express-web',implies: 'AmiExpress-Web' },   // new web port
  { tag: 'amiex-web',     implies: 'AmiExpress-Web' },   // alt slug
  { tag: 's!x',           implies: 'S!X' },               // predecessor
  { tag: 'maxs',          implies: 'Maxs' },              // predecessor of S!X
  { tag: 'daydream-amiga',implies: 'DayDream' },          // 50+
  { tag: 'fame',          implies: 'FAME' },              // 47
  { tag: 'cnet-bbs',      implies: 'CNet' },              // 41
  { tag: 'mystic-bbs',    implies: 'Mystic' },            // 50+
  { tag: 'tempest-bbs',   implies: 'Tempest' },
  { tag: 'descent',       implies: 'Descent' },
  { tag: 'lame',          implies: 'Lame' },
  { tag: 'obbs',          implies: 'OBBS' },
  { tag: 's!x-bbs',       implies: 'S!X' },               // alt slug
  { tag: 'aquila-bbs-ripoff', implies: 'Aquila' },
  { tag: 'celerity-bbs',  implies: 'Celerity' },
  { tag: 'hysteria-bbs',  implies: 'Hysteria' },
  { tag: 'illusion-bbs',  implies: 'Illusion' },
  { tag: 'impulse-bbs',   implies: 'Impulse' },
  { tag: 'insanity-bbs',  implies: 'Insanity' },
  { tag: 'major-bbs',     implies: 'Major' },
  { tag: 'metro-bbs',     implies: 'Metro' },
  { tag: 'monarch-bbs',   implies: 'Monarch' },
  { tag: 'narcosys-bbs',  implies: 'Narcosys' },
  { tag: 'oblivion2',     implies: 'Oblivion' },
  { tag: 'opus-bbs',      implies: 'Opus' },
  { tag: 'original-bbs',  implies: 'Original' },
  { tag: 'paragon-bbs',   implies: 'Paragon' },
  { tag: 'pipeline-bbs',  implies: 'Pipeline' },
  { tag: 'revelation-bbs',implies: 'Revelation' },
  { tag: 'sentinel-bbs',  implies: 'Sentinel' },
  { tag: 'skylight-bbs-ripoff', implies: 'Skylight' },
  { tag: 'solarium-bbs-ripoff', implies: 'Solarium' },
  { tag: 'squid-bbs-ripoff', implies: 'Squid' },
  { tag: 'starport2-ripoff', implies: 'Starport' },
  { tag: 'vision-x',      implies: 'Vision-X' },
  { tag: 'vision2',      implies: 'Vision 2' },
  { tag: 'waffle-bbs',    implies: 'Waffle' },
  { tag: 'warning-bbs-ripoff', implies: 'Warning' },

  // ── PC BBS software (disabled — uncomment to enable) ──────────────────
  // { tag: 'pcboard',         implies: 'PCBoard' },
  // { tag: 'qbbs',            implies: 'QBBS' },
  // { tag: 'wildcat',         implies: 'WildCat' },
  // { tag: 'wwiv',            implies: 'WWIV' },
  // { tag: 'renegade-bbs',    implies: 'Renegade' },
  // { tag: 'remoteaccess',    implies: 'RemoteAccess' },
  // { tag: 'telegard',        implies: 'Telegard' },
  // { tag: 'synchronet',      implies: 'Synchronet' },
  // { tag: 'elebbs',          implies: 'EleBBS' },
  // { tag: 'flash-bbs',       implies: 'Flash' },
  // { tag: 'genesis-deluxe',  implies: 'Genesis' },
  // { tag: 'iniquity',        implies: 'Iniquity' },
  // { tag: 'proboard',        implies: 'ProBoard' },
  // { tag: 'smbx',            implies: 'SMBX' },
  // { tag: 'superbbs',        implies: 'SuperBBS' },
  // { tag: 'tbbs',            implies: 'TBBS' },
];
const DEMOZOO_API = 'https://demozoo.org/api/v1';
// Demozoo's rate limit is 1 request per second per IP. With MAX_CONCURRENT=3
// in flight, we need at least a 3s pause between batches to stay under it.
// 3.5s gives a small margin for slow responses.
const PAUSE_BETWEEN_REQUESTS_MS = 3500;
const PAUSE_EVERY_N_REQUESTS = 50;
const PAUSE_DURATION_MS = 15000;              // 15s break every 50 requests
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [2000, 8000, 30000, 60000, 120000];  // 2s, 8s, 30s, 1m, 2m

// ─── Types ───────────────────────────────────────────────────────────────────

interface DemozooDetail {
  id: number;
  title: string;
  release_date: string | null;
  platform: string | null;
  /** Demozoo returns platforms as an array of {id, name, url}. */
  platforms: { id: number; name: string; url: string }[];
  download_links: { url: string; type: string }[];
  credits: { nick: { name: string; releaser: { is_group: boolean } }; category: string; role: string }[];
  external_links: { url: string; type: string }[];
  screenshots: string[];
  description: string | null;
  author_nicks: {
    name: string;
    abbreviation: string;
    releaser: { id: number; name: string; is_group: boolean };
  }[];
  tags: string[];
}

interface ExistingDoor {
  id: string;
  archive_name: string;
  name: string | null;
  version: string | null;
  author: string | null;
  release_date: string | null;
  platform: string | null;
  download_url: string | null;
  credits: string | null;
  external_links: string | null;
  screenshots: string | null;
  release_group: string | null;
}

interface NewDoorCandidate {
  id: number;
  detail: DemozooDetail;
  filename: string;
  /** requires_bbs value inferred from the production's group / tags. */
  requiresBbs: string | null;
  /** Best download URL picked from download_links (prefers scene.org). */
  downloadUrl: string;
}

interface ImporterStats {
  processed: number;
  newDoors: number;
  backfilled: number;
  unmatched: number;
  errors: number;
  sceneOrgDownloads: number;
  sceneOrgFails: number;
  skippedNoDownload: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fetch(url: string, retries = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const doFetch = (attempt: number) => {
      // 60s per request — a slow demozoo page should never take this
      // long, so if it does we abort and retry (or fail). Without a
      // timeout, a hung TCP connection can stall the whole run.
      const req = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'AmiExpress-DoorServer/1.0' } }, (res) => {
        if (res.statusCode === 429 && attempt < MAX_RETRIES) {
          console.error(`[demozoo] 429 rate-limit, retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAYS_MS[attempt]}ms`);
          setTimeout(() => doFetch(attempt + 1), RETRY_DELAYS_MS[attempt]);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      // 60s wall-clock timeout — a hung connection can't stall the run.
      req.setTimeout(60_000, () => {
        req.destroy(new Error(`timeout after 60s for ${url}`));
      });
      req.on('error', (err) => {
        if (attempt < MAX_RETRIES) {
          console.error(`[demozoo] fetch error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
          setTimeout(() => doFetch(attempt + 1), RETRY_DELAYS_MS[attempt]);
        } else {
          reject(err);
        }
      });
    };
    doFetch(0);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function processBatch<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + concurrency < items.length) {
      await sleep(PAUSE_BETWEEN_REQUESTS_MS);
    }
  }
  return results;
}

async function concurrencyMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Math.min(concurrency, items.length);
  const inFlight: Promise<void>[] = [];

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      const item = items[i];
      try {
        results[i] = await fn(item, i);
      } catch (e) {
        results[i] = Promise.reject(e) as unknown as R;
      }
    }
  }

  for (let w = 0; w < workers; w++) {
    inFlight.push(worker());
  }
  await Promise.all(inFlight);
  return results;
}

function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Failed to parse JSON from response`);
  }
}

function parseFilenameFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    // Drop query string, take last path segment, decode percent-escapes.
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (!last) return null;
    return decodeURIComponent(last);
  } catch {
    return null;
  }
}

function parseFilenameFromHtml(html: string): string | null {
  const match = html.match(/Filename:\s*([^\s<]+)/i);
  return match ? match[1] : null;
}

function parseFilename(downloadUrl: string | undefined, html: string | null): string | null {
  // The download URL's last path segment is the filename on every production
  // we tested. The HTML "Filename:" section is only present for files actually
  // uploaded to demozoo (rare for BBS doors), so use URL first, HTML fallback.
  return parseFilenameFromUrl(downloadUrl ?? '') ?? parseFilenameFromHtml(html ?? '');
}

/** Parse the "Info files" list from a demozoo production detail page.
 *  Each entry is a filename + size (e.g. "UP-MD15.NFO - (19545 bytes)"). */
function parseInfoFiles(html: string): { name: string; size: number }[] {
  const m = html.match(/<ul class="info_files">([\s\S]*?)<\/ul>/);
  if (!m) return [];
  const items: { name: string; size: number }[] = [];
  for (const li of m[1].matchAll(/<a[^>]+title="([^"]+)\s+-\s+\((\d+)\s*bytes\)">([^<]+)<\/a>/g)) {
    // ti order: 1=name-with-extension, 2=size, 3=display-name
    // Some titles have format: "FILE_ID.DIZ - (533 bytes)" → split on " - ("
    const title = li[1];
    const name = title.replace(/\s*-\s*\(\d+\s*bytes\)\s*$/, '').trim();
    items.push({ name, size: Number(li[2]) });
  }
  return items;
}

/** Pick the primary "doc" file from demozoo's info-file list.
 *  Prefer .NFO (the standard scene extra-info file). Fall back to .TXT.
 *  Skip FILE_ID.DIZ — that goes into file_id_diz, not doc_raw. */
function pickDocFile(infoFiles: { name: string; size: number }[]): string | null {
  const candidates = infoFiles.filter((f) => !/^file_?id\.diz$/i.test(f.name));
  const nfo = candidates.find((f) => /\.nfo$/i.test(f.name));
  if (nfo) return nfo.name;
  const txt = candidates.find((f) => /\.txt$/i.test(f.name));
  if (txt) return txt.name;
  return candidates[0]?.name ?? null;
}

function parseCredits(credits: { nick?: { name?: string }; category?: string; role?: string }[]): string | null {
  if (!credits || credits.length === 0) return null;
  return JSON.stringify(credits);
}

function parseLinks(links: { url: string; type: string }[]): string | null {
  if (!links || links.length === 0) return null;
  return JSON.stringify(links);
}

function parseScreenshots(screenshots: string[]): string | null {
  if (!screenshots || screenshots.length === 0) return null;
  return JSON.stringify(screenshots);
}

/** Demozoo's `author_nicks` lists everyone who contributed. The first one
 *  with `is_group: true` is the release crew — that's what we want for
 *  `door_catalog.release_group` (abbreviation) and
 *  `release_groups.full_name` (e.g. "Up Rough /X Innovations"). */
function extractReleaseGroup(detail: DemozooDetail): { abbrev: string; fullName: string } | null {
  for (const nick of detail.author_nicks ?? []) {
    if (nick.releaser?.is_group && nick.abbreviation) {
      return { abbrev: nick.abbreviation, fullName: nick.releaser.name };
    }
  }
  return null;
}

/**
 * Best-effort `door_type` from demozoo's tags. The "xim" tag means the
 * archive contains an Amiga executable; "arexx" means it's an ARexx
 * script; "cli" is a CLI command. Returns null if no signal.
 */
const DOOR_TYPE_FROM_TAG: { match: RegExp; doorType: string }[] = [
  { match: /^xim$/i,    doorType: 'XIM' },
  { match: /^arexx$/i,  doorType: 'ARexx' },
  { match: /^cli$/i,    doorType: 'CLI' },
  { match: /^sim$/i,    doorType: 'SIM' },
  { match: /^rexx$/i,   doorType: 'REXX' },
  { match: /^cmd$/i,    doorType: 'CMD' },
];
function inferDoorType(detail: DemozooDetail): string | null {
  for (const tag of detail.tags ?? []) {
    for (const { match, doorType } of DOOR_TYPE_FROM_TAG) {
      if (match.test(tag)) return doorType;
    }
  }
  return null;
}

/**
 * Best-effort `requires_bbs` for a production, based on the production
 * data we have. Tries group-name match first, then falls back to the
 * known tag→BBS mapping. Returns null if no signal.
 */
function inferRequiresBbs(detail: DemozooDetail): string | null {
  const groupName = detail.author_nicks?.find((n) => n.releaser?.is_group)?.releaser.name ?? '';
  const lcGroup = groupName.toLowerCase();
  // Group-name signal: most release crews only release for one BBS.
  // This map covers all the well-known Amiga BBS scene groups.
  const GROUP_TO_BBS: { match: RegExp; bbs: string }[] = [
    { match: /up rough|amiexpress|\/x innovation/, bbs: 'AmiExpress' },
    { match: /ami-?express-?web|amiexweb/,         bbs: 'AmiExpress-Web' },
    { match: /quantum|hoodlum|tcs/,             bbs: 'S!X' },
    { match: /daydream/,                         bbs: 'DayDream' },
    { match: /^fame$|fame.*design/,              bbs: 'FAME' },
    { match: /demonic|phenom/,                  bbs: 'Mystic' },
    { match: /medellin|phenom productions/,     bbs: 'CNet' },
    { match: /sceptic|^scp$|sad-file/,           bbs: 'AmiExpress' }, // Sceptic/SAD = textadder crew
    { match: /shelter/,                          bbs: 'AmiExpress' }, // SLT! = Shelter, AmiExpress ad-tools
    { match: /outlaws|otl/,                     bbs: 'AmiExpress' }, // OTL = Outlaws, AmiExpress ad-tools
    { match: /decade|dcd/,                       bbs: 'AmiExpress' }, // Decade = AmiExpress ad-tools
    { match: /delta|logic|expose/,              bbs: 'Aquila' },
    { match: /insanity/,                         bbs: 'Insanity' },
  ];
  for (const { match, bbs } of GROUP_TO_BBS) {
    if (match.test(lcGroup)) return bbs;
  }
  // Tag-based signal. Many ami-express-* tags imply AmiExpress even
  // when the group isn't in the map above.
  const tags = detail.tags ?? [];
  for (const tag of tags) {
    if (/^amiex(?!-web)/i.test(tag)) return 'AmiExpress';
    if (/^amiex-?web/i.test(tag)) return 'AmiExpress-Web';
    if (/^s!x/i.test(tag)) return 'S!X';
    if (/^daydream/i.test(tag)) return 'DayDream';
    if (/^fame/i.test(tag)) return 'FAME';
    if (/^mystic/i.test(tag)) return 'Mystic';
    if (/^cnet/i.test(tag)) return 'CNet';
    if (/^tempest/i.test(tag)) return 'Tempest';
  }
  // Tag fallback: check if any tag matches the known TAGS list.
  for (const { tag, implies } of TAGS) {
    if (tags.includes(tag)) return implies;
  }
  return null;
}

interface DownloadResult {
  path: string;
  size: number;
  md5: string;
  sha256: string;
}

/**
 * Pick the best download URL from a demozoo production's download_links.
 * Preference order: files.scene.org > amigascne > anything else.
 * Skips broken/undesirable mirrors (currently the .se swedish mirror).
 */
function pickBestDownload(links: { url: string; type: string }[] | undefined | null): string | null {
  if (!links || links.length === 0) return null;
  // Drop known-bad mirrors first.
  const usable = links.filter((l) => !/\.se\b/.test(new URL(l.url).hostname));
  if (usable.length === 0) return null;
  // Prefer scene.org.
  const sceneOrg = usable.find((l) => l.url.includes('files.scene.org'));
  if (sceneOrg) return sceneOrg.url;
  // Then amigascne.
  const amigascne = usable.find((l) => l.url.includes('amigascne.org'));
  if (amigascne) return amigascne.url;
  // First remaining link.
  return usable[0].url;
}

/**
 * Compute md5 + sha256 + size of a local file. Used when registering
 * an existing-on-disk archive into the catalog without re-downloading.
 */
function statLocalFile(absPath: string): { size: number; md5: string; sha256: string } {
  const buf = fs.readFileSync(absPath);
  return {
    size: buf.length,
    md5: crypto.createHash('md5').update(buf).digest('hex'),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

/**
 * Walk archivesRoot recursively looking for a file with the given
 * basename (case-insensitive). Returns the absolute path if found, else null.
 */
function fileExistsUnderRoot(basename: string, archivesRoot: string): string | null {
  const want = basename.toLowerCase();
  function walk(dir: string): string | null {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return null; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === want) return p;
      if (e.isDirectory() && e.name !== 'Submitted' && e.name !== 'node_modules') {
        const found = walk(p);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(archivesRoot);
}

/**
 * Split a demozoo title into (name, version). Version is vN or vN.N...
 * followed by a non-digit, non-dot boundary so "Slt!ReAdd v1.o" (which
 * is elite casing where the trailing 'o' is a stylised zero) is still
 * captured as version="v1.0". The matching stops only at a true
 * non-digit, non-dot, non-letter boundary (i.e. end of string or
 * whitespace), so "Slt!ReAdd v1.o" still matches and "Door v2 abc"
 * (v followed by letter) does not.
 *
 * Elite casing note: scenes often render 0 as the letter O, so "v1.o"
 * is "v1.0". We replace the trailing 'o' with '0' before storing. The
 * name field is left with the elite casing intact for display.
 */
// Match the version-like suffix of a demozoo title: 'v' followed by
// digits, periods, and possibly an elite-cased trailing zero (the
// scene's stylised 'o'/'O' for '0'). e.g. matches all of:
//   'v1', 'v1.0', 'v1.0.1', 'v1.o', 'v2.3.O', 'v1.O.0'
// Then a normalise + validate pass converts the elite zero to '0'
// and rejects strings that contain any other letter (so "Door v2 abc"
// doesn't get misread as v2 with "abc" left over).
const VERSION_RE = /\s+v([\d.]*[\doO]+)/i;
function splitNameAndVersion(title: string, fallbackBasename?: string): { name: string; version: string | null } {
  const m = title.match(VERSION_RE);
  if (!m) {
    return { name: (title || fallbackBasename || '').trim(), version: null };
  }
  // Validate: if the capture contains any letter other than o/O, the
  // match was a false positive (e.g. "Door v2abc" → captured "v2abc"
  // would still match, but the "abc" isn't part of a version).
  if (/[a-zA-Z]/.test(m[1].replace(/[oO]/g, ''))) {
    return { name: (title || fallbackBasename || '').trim(), version: null };
  }
  // Strip trailing dots (handles "v1." with no digits after).
  // Convert any trailing o/O to 0 (elite zero).
  let raw = m[1].replace(/\.+$/, '').replace(/[oO]$/, '0');
  // If after translation the result isn't a valid version (digits and
  // dots only), reject the match — the regex would have matched too
  // much on inputs like "v1abc" or "v 1.2".
  if (!/^\d+(\.\d+)*$/.test(raw)) {
    return { name: (title || fallbackBasename || '').trim(), version: null };
  }
  // Strip the matched version (using the original elite casing) from
  // the name field so "Slt!ReAdd v1.o" becomes name="Slt!ReAdd"
  // and version="v1.0".
  const escapedMatch = m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = (title || fallbackBasename || '')
    .replace(new RegExp(escapedMatch, 'i'), '').replace(/\s+$/, '').trim();
  return { name, version: `v${raw}` };
}

interface RegisterArgs {
  candidate: NewDoorCandidate;
  where: string;
  db: Database.Database;
  archivesRoot: string;
  dryRun: boolean;
}

/**
 * Register an archive that already exists on disk into door_catalog,
 * then backfill demozoo fields. Used when the file is found locally
 * but has never been added to the catalog — common for legacy archives
 * that predate the demozoo import.
 */
async function registerExistingFile(args: RegisterArgs): Promise<void> {
  const { candidate, where, db, archivesRoot, dryRun } = args;
  const { id, detail, filename, downloadUrl, requiresBbs } = candidate;
  const basename = path.basename(where);
  const archivePath = path.relative(archivesRoot, where);
  const relPath = archivePath.split(path.sep).join('/');
  // If the row already exists in the catalog, just backfill (the
  // normal path handles this — we never get here for catalog hits
  // because the caller checks door_catalog first).
  const existing = db
    .prepare('SELECT id, archive_name FROM door_catalog WHERE archive_name = ?')
    .get(basename) as { id: string; archive_name: string } | undefined;
  if (existing) {
    process.stderr.write(`[demozoo] id=${id} "${filename}" already in catalog (${existing.id}), nothing to register\n`);
    return;
  }
  // Compute file stats. For large archives this is cheap (single read).
  let stats;
  try { stats = statLocalFile(where); }
  catch (e: any) {
    process.stderr.write(`[demozoo] ERROR reading ${where}: ${e.message}\n`);
    return;
  }
  // Extract version from title and strip it from the name.
  const { name, version: versionFromTitle } = splitNameAndVersion(
    detail.title,
    path.basename(filename, path.extname(filename))
  );
  const group = extractReleaseGroup(detail);
  if (group) {
    db.prepare(
      'INSERT INTO release_groups (abbreviation, full_name) VALUES (?, ?) ON CONFLICT(abbreviation) DO UPDATE SET full_name = excluded.full_name'
    ).run(group.abbrev, group.fullName);
  }
  process.stderr.write(`[demozoo] id=${id} registering local ${where} (${stats.size} bytes)\n`);
  if (dryRun) {
    process.stderr.write(`[demozoo] DRY: would INSERT ${basename} (${relPath}) — name="${name}" version="${versionFromTitle ?? '(none)'}"\n`);
  } else {
    const catalogId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO door_catalog
         (id, archive_name, archive_path, name, door_type, version, author,
          description, release_date, platform, download_url, credits,
          external_links, screenshots, release_group, archive_size, md5, sha256, source, indexed_at)
       VALUES (?, ?, ?, ?, 'XIM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demozoo', strftime('%s','now'))`
    ).run(
      catalogId,
      basename,
      relPath,
      name,
      versionFromTitle,
      detail.credits?.[0]?.nick?.name ?? null,
      detail.description ?? null,
      detail.release_date ?? null,
      detail.platforms?.map((p) => p.name).join(', ') ?? null,
      downloadUrl,
      parseCredits(detail.credits ?? []),
      parseLinks(detail.external_links ?? []),
      parseScreenshots(detail.screenshots ?? []),
      group?.abbrev ?? null,
      stats.size,
      stats.md5,
      stats.sha256
    );
    recordAudit(db, null, 'import-demozoo', basename, { source: 'local' });
  }
  // Mark as imported so we don't re-process this production on
  // a subsequent run.
  try {
    if (dryRun) {
      process.stderr.write(`[demozoo] DRY: would mark id=${id} imported\n`);
    } else {
      db.prepare('INSERT OR IGNORE INTO demozoo_imported (id, imported_at) VALUES (?, ?)').run(id, Date.now());
    }
  } catch { /* already imported concurrently */ }
}

function downloadToFile(url: string, destPath: string, expectedBasename: string, retries = 0): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    const doDownload = (attempt: number) => {
      const hashMd5 = crypto.createHash('md5');
      const hashSha256 = crypto.createHash('sha256');
      let size = 0;

      const req = https.get(url, { headers: { 'User-Agent': 'AmiExpress-DoorServer/1.0' } }, (res) => {
        if (res.statusCode === 429 && attempt < MAX_RETRIES) {
          console.error(`[demozoo] scene.org 429, retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAYS_MS[attempt]}ms`);
          setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]);
          return;
        }
        if (res.statusCode === 302 || res.statusCode === 301) {
          const location = res.headers.location;
          if (!location) { reject(new Error('redirect without location')); return; }
          req.destroy();
          https.get(location, { headers: { 'User-Agent': 'AmiExpress-DoorServer/1.0' } }, (res2) => {
            if (res2.statusCode !== 200) {
              if (attempt < MAX_RETRIES) { setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]); return; }
              reject(new Error(`scene.org redirect returned ${res2.statusCode}`));
              return;
            }
            const file = fs.createWriteStream(destPath);
            res2.on('data', (chunk) => { hashMd5.update(chunk); hashSha256.update(chunk); size += chunk.length; });
            res2.pipe(file);
            file.on('finish', () => { file.close(); resolve({ path: destPath, size, md5: hashMd5.digest('hex'), sha256: hashSha256.digest('hex') }); });
            file.on('error', reject);
          }).on('error', (err) => { if (attempt < MAX_RETRIES) { setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]); } else { reject(err); } });
          return;
        }
        if (res.statusCode !== 200) {
          if (attempt < MAX_RETRIES) { setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]); return; }
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(destPath);
        res.on('data', (chunk) => { hashMd5.update(chunk); hashSha256.update(chunk); size += chunk.length; });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve({ path: destPath, size, md5: hashMd5.digest('hex'), sha256: hashSha256.digest('hex') }); });
        file.on('error', reject);
      }).on('error', (err) => {
        if (attempt < MAX_RETRIES) { setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]); } else { reject(err); }
      });
    };
    doDownload(0);
  });
}

// ─── Core Logic ──────────────────────────────────────────────────────────────

async function enumerateProductionIds(): Promise<number[]> {
  const cacheFile = path.join('/tmp', 'demozoo-ids-bbs-doors.json');
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as number[];
      // Reject poisoned caches: an enumeration that returned the unfiltered
      // total (388K) would have been written here before the sanity check
      // existed. Treat any cache over the sanity threshold as corrupt and
      // force a re-fetch.
      if (cached.length > 50000) {
        process.stderr.write(`[demozoo] WARNING: cache ${cacheFile} has ${cached.length} IDs (>50000) — treating as poisoned, re-enumerating\n`);
        fs.unlinkSync(cacheFile);
      } else {
        process.stderr.write(`[demozoo] enumerate loaded ${cached.length} BBS-Door IDs from cache ${cacheFile}\n`);
        return cached;
      }
    } catch {
      // fall through to fresh enumeration
    }
  }

  const ids: number[] = [];
  // production_type=53 is the demozoo ID for "BBS Door". Demozoo's JSON
  // production API ignores tag filters (returns the unfiltered 388K
  // total), so we scrape the HTML listing pages instead. The HTML
  // search form accepts the production_type param and filters correctly.
  // URL: https://demozoo.org/productions/?platform=&production_type=53
  // (no tag, no platform — gets every BBS Door regardless of scene
  // group; per-BBS inference happens later from the actual production
  // data, not the tag).
  const TYPE_BBS_DOOR = 53;
  let page = 1;
  const seen = new Set<number>();
  const PROD_LINK_RE = /\/productions\/(\d+)\//g;
  let consecutiveEmpty = 0;

  while (true) {
    const url = `https://demozoo.org/productions/?production_type=${TYPE_BBS_DOOR}&page=${page}`;
    process.stderr.write(`[demozoo] enumerate BBS-Door page=${page} url=${url}\n`);
    const html = await fetch(url);
    const matches = [...html.matchAll(PROD_LINK_RE)];
    let addedThisPage = 0;
    for (const m of matches) {
      const id = Number(m[1]);
      if (!seen.has(id)) { seen.add(id); ids.push(id); addedThisPage++; }
    }
    process.stderr.write(`[demozoo] page=${page} found ${addedThisPage} new IDs (${ids.length} total)\n`);
    // Persist the cache after every page so a crash mid-enumeration
    // doesn't lose the 1000s of IDs we've already paginated through.
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(ids));
    } catch (e: any) {
      process.stderr.write(`[demozoo] WARNING: failed to write ID cache: ${e.message}\n`);
    }
    if (addedThisPage === 0) {
      // Could be either end-of-list OR rate-limit. Retry once after
      // a long pause; if still empty, treat as end-of-list.
      consecutiveEmpty++;
      if (consecutiveEmpty > 2) break;
      process.stderr.write(`[demozoo] page=${page} empty — could be rate-limited, retrying after 10s\n`);
      await sleep(10000);
      continue;
    }
    consecutiveEmpty = 0;
    page++;
    if (page > 1000) {
      // Safety cap: there are ~1K pages of BBS Door productions on
      // demozoo (50 IDs each = ~50K total). If we're past 1000 pages,
      // something is wrong.
      process.stderr.write(`[demozoo] WARNING: hit 1000-page safety cap, aborting\n`);
      break;
    }
    await sleep(PAUSE_BETWEEN_REQUESTS_MS);
  }

  process.stderr.write(`[demozoo] enumeration complete: ${ids.length} IDs\n`);

  return ids;
}

async function fetchDetailJson(id: number): Promise<DemozooDetail> {
  const url = `${DEMOZOO_API}/productions/${id}/?format=json`;
  const body = await fetch(url);
  return parseJson<DemozooDetail>(body);
}

async function fetchDetailHtml(id: number): Promise<string> {
  const url = `https://demozoo.org/productions/${id}/`;
  return fetch(url);
}

async function main() {
  process.stderr.write('[demozoo] starting\n');
  const dryRun = process.argv.includes('--dry-run');
  const noDownload = process.argv.includes('--no-download');
  if (dryRun) process.stderr.write('[demozoo] DRY RUN — no changes will be written\n');
  if (noDownload) process.stderr.write('[demozoo] NO DOWNLOAD — skipping Phase 2 archive downloads\n');

  const cfg = loadConfig();
  process.stderr.write(`[demozoo] loaded config: db=${cfg.dbPath} archives=${cfg.archivesRoot}\n`);
  const db = openSqlite(cfg.dbPath);
  applySchema(db);
  runMigrations(db);
  process.stderr.write('[demozoo] db ready\n');

  const archivesRoot = cfg.archivesRoot;
  const submittedDir = path.join(archivesRoot, 'Submitted');
  if (!fs.existsSync(submittedDir)) {
    fs.mkdirSync(submittedDir, { recursive: true });
  }

  const stats: ImporterStats = {
    processed: 0, newDoors: 0, backfilled: 0, unmatched: 0,
    errors: 0, sceneOrgDownloads: 0, sceneOrgFails: 0, skippedNoDownload: 0,
  };
  const errorLog: string[] = [];

  const existingDoors = db
    .prepare('SELECT id, archive_name, name, version, author, release_date, platform, download_url, credits, external_links, screenshots, release_group FROM door_catalog WHERE archive_name IS NOT NULL')
    .all() as ExistingDoor[];

  const archiveNameToDoor = new Map(existingDoors.map((d) => [d.archive_name.toLowerCase(), d]));

  const imported = new Set<number>(
    (db.prepare('SELECT id FROM demozoo_imported').all() as { id: number }[]).map((r) => r.id)
  );

  const newDoorCandidates: NewDoorCandidate[] = [];
  let requestCount = 0;

  // ── Phase 1: enumerate and backfill existing doors ──────────────────────────
  // CLI: --ids=123,456,789 skips enumeration and processes only the
  // given demozoo production IDs. Useful for testing a handful of
  // doors without scraping 50K productions.
  const idsArg = process.argv.find((a) => a.startsWith('--ids='));
  let ids: number[];
  if (idsArg) {
    ids = idsArg.slice('--ids='.length).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    process.stderr.write(`[demozoo] using --ids from CLI: ${ids.join(', ')}\n`);
  } else {
    process.stderr.write(`[demozoo] Phase 1: enumerating all BBS-Door productions\n`);
    try {
      ids = await enumerateProductionIds();
    } catch (e: any) {
      process.stderr.write(`[demozoo] ERROR enumerating: ${e.message}\n`);
      errorLog.push(`enumerate: ${e.message}`);
      process.exit(1);
    }
    process.stderr.write(`[demozoo] found ${ids.length} BBS-Door productions\n`);
  }

    const toProcess = ids.filter((id) => !imported.has(id));
    process.stderr.write(`[demozoo] ${toProcess.length} to process (${ids.length - toProcess.length} already imported)\n`);

    let batchStart = 0;
    while (batchStart < toProcess.length) {
      const batch = toProcess.slice(batchStart, batchStart + MAX_CONCURRENT);
      batchStart += MAX_CONCURRENT;

      const fetched = await Promise.all(
        batch.map(async (id) => {
          try {
            const [detail, html] = await Promise.all([fetchDetailJson(id), fetchDetailHtml(id)]);
            return { id, detail, html, error: null };
          } catch (e: any) {
            return { id, detail: null, html: null, error: e.message };
          }
        })
      );

      for (const { id, detail, html, error } of fetched) {
        requestCount++;
        if (error) {
          process.stderr.write(`[demozoo] ERROR fetching id=${id}: ${error}\n`);
          errorLog.push(`fetch:${id}: ${error}`);
          stats.errors++;
          continue;
        }

        stats.processed++;
        const downloadUrl = detail!.download_links?.[0]?.url;
        const filename = parseFilename(downloadUrl, html!);

        if (!filename) {
          process.stderr.write(`[demozoo] id=${id} "${detail!.title}" — no filename in URL or HTML, skipping\n`);
          errorLog.push(`nofilename:${id}: ${detail!.title}`);
          stats.unmatched++;
          continue;
        }

        const lookup = filename.toLowerCase();
        const match = archiveNameToDoor.get(lookup);
        const implies = inferRequiresBbs(detail!);

        if (!match) {
          // Pick the best download URL. Prefer files.scene.org (most
          // reliable mirror) and skip .se mirrors (the broken swedish
          // mirror). Amigascne is a fine fallback.
          const pickUrl = pickBestDownload(detail!.download_links);
          if (pickUrl) {
            newDoorCandidates.push({ id, detail: detail!, filename, requiresBbs: implies, downloadUrl: pickUrl });
          } else {
            process.stderr.write(`[demozoo] id=${id} "${detail!.title}" filename="${filename}" — no usable download URL, skipping\n`);
            errorLog.push(`nomatch+nodl:${id}:${filename}:${detail!.title}`);
            stats.skippedNoDownload++;
          }
          stats.unmatched++;
          continue;
        }

        const patch: Record<string, unknown> = {};
        // Demozoo's metadata is the authoritative source for these fields.
        // Overwrite the row values — curator edits live in door_catalog_overrides
        // and are layered on at read time, so nothing user-edited is lost.
        if (detail!.release_date) patch.release_date = detail!.release_date;
        if (detail!.platforms?.length) patch.platform = detail!.platforms.map((p) => p.name).join(', ');
        const dl = detail!.download_links?.[0]?.url;
        if (dl) patch.download_url = dl;
        // Author: the first coder credit in demozoo's credits array.
        // The credits array is `[{nick: {name, ...}, category, role}]`
        // where the nick is the individual coder (or a group they
        // released under). author_nicks only carries the release group,
        // so we can't fall back to it for the personal author.
        const firstPerson = detail!.credits?.[0]?.nick?.name ?? null;
        if (firstPerson) patch.author = firstPerson;
        const creds = parseCredits(detail!.credits ?? []);
        if (creds) patch.credits = creds;
        const links = parseLinks(detail!.external_links ?? []);
        if (links) patch.external_links = links;
        const shots = parseScreenshots(detail!.screenshots ?? []);
        if (shots) patch.screenshots = shots;
        const group = extractReleaseGroup(detail!);
        if (group) {
          patch.release_group = group.abbrev;
          db.prepare(
            'INSERT INTO release_groups (abbreviation, full_name) VALUES (?, ?) ON CONFLICT(abbreviation) DO UPDATE SET full_name = excluded.full_name'
          ).run(group.abbrev, group.fullName);
        }
        // The tag itself is a strong signal for which BBS this door runs on.
        // e.g. tag "amiex" → requires_bbs "AmiExpress" /X.
        if (implies) patch.requires_bbs = implies;
        // Door executable type: "xim" → XIM, "arexx" → ARexx, etc.
        const doorType = inferDoorType(detail!);
        if (doorType) patch.door_type = doorType;

        if (Object.keys(patch).length > 0) {
          const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
          const vals = Object.values(patch);
          if (dryRun) {
            process.stderr.write(`[demozoo] DRY: would UPDATE ${match.archive_name} SET ${sets}\n`);
          } else {
            db.prepare(`UPDATE door_catalog SET ${sets} WHERE id = ?`).run(...vals, match.id);
            recordAudit(db, null, 'import-demozoo', match.archive_name, { enriched: Object.keys(patch) });
          }
          process.stderr.write(`[demozoo] backfilled id=${id} "${match.archive_name}" with ${Object.keys(patch).join(', ')}\n`);
          stats.backfilled++;
        } else {
          process.stderr.write(`[demozoo] id=${id} "${match.archive_name}" already enriched\n`);
        }

        // Always mark as imported when the archive already exists in
        // the catalog, even if no new fields were patched (avoid
        // re-scanning the same production on every run).
        try {
          if (dryRun) { process.stderr.write(`[demozoo] DRY: would mark id=${id} imported\n`); } else { db.prepare("INSERT OR IGNORE INTO demozoo_imported (id, imported_at) VALUES (?, ?)").run(id, Date.now()); }
        } catch {
          // already imported concurrently
        }
      }

      if (batchStart % PAUSE_EVERY_N_REQUESTS < MAX_CONCURRENT) {
        process.stderr.write(`[demozoo] processed ${batchStart}/${toProcess.length}, pausing ${PAUSE_DURATION_MS}ms\n`);
        await sleep(PAUSE_DURATION_MS);
      } else {
        await sleep(PAUSE_BETWEEN_REQUESTS_MS);
      }
    }

  // ── Pre-pass: register any candidates whose archive already exists
  // locally into the catalog. Runs regardless of --no-download so a
  // curator doing a test run still sees the existing files registered.
  for (const candidate of newDoorCandidates) {
    const { filename } = candidate;
    const destBasename = filename;
    const destPath = path.join(submittedDir, destBasename);
    const existingAtDest = fs.existsSync(destPath);
    let existingUnderRoot: string | null = null;
    if (!existingAtDest) {
      const want = destBasename.toLowerCase();
      function walk(dir: string): void {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isFile() && e.name.toLowerCase() === want) {
            existingUnderRoot = p;
            return;
          }
          if (e.isDirectory() && e.name !== 'Submitted' && e.name !== 'node_modules') {
            walk(p);
            if (existingUnderRoot) return;
          }
        }
      }
      walk(archivesRoot);
    }
    if (existingAtDest || existingUnderRoot) {
      const where = existingAtDest ? destPath : existingUnderRoot!;
      await registerExistingFile({
        candidate, where, db, archivesRoot, dryRun,
      });
    }
  }

  // ── Phase 2: download new doors from scene.org ──────────────────────────────
  if (newDoorCandidates.length > 0) {
    if (noDownload) {
      // Re-list after the pre-pass: any candidate whose local file was
      // found is already registered. Show the rest as "would download".
      const remaining = newDoorCandidates.filter((c) =>
        !fs.existsSync(path.join(submittedDir, c.filename)) &&
        !fileExistsUnderRoot(c.filename, archivesRoot)
      );
      if (remaining.length > 0) {
        process.stderr.write(`[demozoo] Phase 2: SKIPPED (--no-download). ${remaining.length} candidates not downloaded:\n`);
        for (const c of remaining) {
          process.stderr.write(`  - id=${c.id} "${c.detail.title}" → ${c.downloadUrl}\n`);
        }
      } else {
        process.stderr.write(`[demozoo] Phase 2: SKIPPED (--no-download) — all candidates already on disk\n`);
      }
    } else {
      process.stderr.write(`[demozoo] Phase 2: ${newDoorCandidates.length} new door candidates\n`);

    for (const candidate of newDoorCandidates) {
      const { id, detail, filename, downloadUrl } = candidate;
      const sceneOrgUrl = downloadUrl;
      if (!sceneOrgUrl) {
        stats.skippedNoDownload++;
        continue;
      }

      const destBasename = filename;
      const destPath = path.join(submittedDir, destBasename);

      // Skip if the file already exists anywhere — pre-pass already
      // registered it in the catalog if it was missing.
      if (fs.existsSync(destPath) || fileExistsUnderRoot(destBasename, archivesRoot)) {
        const where = fs.existsSync(destPath) ? destPath : fileExistsUnderRoot(destBasename, archivesRoot)!;
        process.stderr.write(`[demozoo] id=${id} "${filename}" already exists at ${where}, registered in pre-pass\n`);
        continue;
      }

      const tmpPath = path.join(submittedDir, `.tmp.${id}.${destBasename}`);
      requestCount++;
      if (requestCount % PAUSE_EVERY_N_REQUESTS === 0) {
        process.stderr.write(`[demozoo] download request count ${requestCount}, pausing ${PAUSE_DURATION_MS}ms\n`);
        await sleep(PAUSE_DURATION_MS);
      } else {
        await sleep(PAUSE_BETWEEN_REQUESTS_MS);
      }

      let dlResult: DownloadResult;
      try {
        dlResult = await downloadToFile(sceneOrgUrl, tmpPath, destBasename);
        stats.sceneOrgDownloads++;
      } catch (e: any) {
        process.stderr.write(`[demozoo] download failed id=${id} "${filename}": ${e.message}\n`);
        errorLog.push(`download:${id}:${filename}: ${e.message}`);
        stats.sceneOrgFails++;
        // Don't record in demozoo_imported — re-run will retry
        continue;
      }

      // Verify the downloaded file's basename matches what we expect
      const downloadedBasename = path.basename(dlResult.path);
      if (downloadedBasename.toLowerCase() !== destBasename.toLowerCase()) {
        process.stderr.write(`[demozoo] filename mismatch: expected "${destBasename}", got "${downloadedBasename}", deleting\n`);
        fs.unlinkSync(tmpPath);
        errorLog.push(`filename mismatch:${id}:${destBasename}:${downloadedBasename}`);
        stats.errors++;
        continue;
      }

      // Move to final location
      fs.renameSync(tmpPath, destPath);

      // Insert into door_catalog
      const catalogId = crypto.randomUUID();
      // Demozoo titles usually look like "Door Name v1.0" or "Door v1.2.3".
      // Split out the trailing version so it goes into the version column
      // rather than being part of the name. The version must be vN or
      // vN.N or vN.N.N — followed by a non-digit, non-dot boundary so
      // "v1.o" (literal letter o) is NOT misread as "v1.0".
      const { name, version: versionFromTitle } = splitNameAndVersion(
        detail.title,
        path.basename(destBasename, path.extname(destBasename))
      );
      const group = extractReleaseGroup(detail);
      if (group) {
        db.prepare(
          'INSERT INTO release_groups (abbreviation, full_name) VALUES (?, ?) ON CONFLICT(abbreviation) DO UPDATE SET full_name = excluded.full_name'
        ).run(group.abbrev, group.fullName);
      }

      try {
        db.prepare(
          `INSERT INTO door_catalog
             (id, archive_name, archive_path, name, door_type, version, author,
              description, release_date, platform, download_url, credits,
              external_links, screenshots, release_group, archive_size, md5, sha256, source, indexed_at)
           VALUES (?, ?, ?, ?, 'XIM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demozoo', strftime('%s','now'))`
        ).run(
          catalogId,
          destBasename,
          path.posix.join('Submitted', destBasename),
          name,
          versionFromTitle,
      detail.credits?.[0]?.nick?.name ?? null,
          detail.description ?? null,
          detail.release_date ?? null,
          detail.platforms?.map((p) => p.name).join(', ') ?? null,
          sceneOrgUrl,
          parseCredits(detail.credits ?? []),
          parseLinks(detail.external_links ?? []),
          parseScreenshots(detail.screenshots ?? []),
          group?.abbrev ?? null,
          dlResult.size,
          dlResult.md5,
          dlResult.sha256
        );
        if (dryRun) { process.stderr.write(`[demozoo] DRY: would mark id=${id} imported\n`); } else { db.prepare("INSERT OR IGNORE INTO demozoo_imported (id, imported_at) VALUES (?, ?)").run(id, Date.now()); }
        recordAudit(db, null, 'import-demozoo', destBasename, { new: true, catalogId });
        process.stderr.write(`[demozoo] new door inserted id=${id} "${destBasename}" catalogId=${catalogId}\n`);
        stats.newDoors++;
      } catch (e: any) {
        process.stderr.write(`[demozoo] INSERT failed id=${id} "${destBasename}": ${e.message}\n`);
        errorLog.push(`insert:${id}:${destBasename}: ${e.message}`);
        stats.errors++;
        // File is on disk but DB insert failed — don't record as imported, re-run will retry
      }
    }
    }
  }

  process.stderr.write(`\n[demozoo] Done. stats=${JSON.stringify(stats)}\n`);
  if (errorLog.length > 0) {
    process.stderr.write(`[demozoo] Errors (${errorLog.length}):\n`);
    for (const e of errorLog.slice(0, 50)) {
      process.stderr.write(`  ${e}\n`);
    }
    if (errorLog.length > 50) process.stderr.write(`  ... and ${errorLog.length - 50} more\n`);
  }

  db.close();
}

function openSqlite(p: string): Database.Database {
  return new Database(p);
}

main().catch((e) => {
  console.error('[demozoo] fatal:', e);
  process.exit(1);
});
