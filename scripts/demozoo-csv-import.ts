#!/usr/bin/env npx tsx

/**
 * Demozoo BBS Door Importer — CSV edition (parallel, fast).
 *
 * Reads a Demozoo CSV (column order: Demozoo URL, Title, By, Release date,
 * Platform, Download URL) and:
 *   1. For each row whose filename matches an existing door_catalog row,
 *      backfill NULL columns with CSV data.
 *   2. For each row with no local match, download the archive to
 *      <archivesRoot>/Submitted/ and INSERT a new door_catalog row.
 *
 * Resumable via the `demozoo_csv_imported` table — every processed row's
 * CSV id is recorded so a re-run skips it.
 *
 * Performance:
 *   - Parallel downloads (default 8 workers, --concurrency=N to change)
 *   - Shared https.Agent with keep-alive per host (no per-request handshake)
 *   - No retry on 404/403 (definitive failures — saves 40s/URL on dead mirrors)
 *   - Retry on 429 / 5xx / network errors only
 *
 * Differs from scripts/demozoo-import.ts: that script scrapes the
 * demozoo.org API for every production. The CSV skips that step (the
 * admin has already done the enumeration) and goes straight to
 * match+backfill+download.
 *
 * Usage:
 *   npx tsx scripts/demozoo-csv-import.ts <path-to-csv> [--dry-run] [--no-download] [--concurrency=N]
 */

import Database from 'better-sqlite3';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { readLhaContents, readZipContents, readLzxContents, type ArchiveContents } from '../src/archive-reader';

// ─── CSV parser ──────────────────────────────────────────────────────────────

interface CsvRow {
  demozooUrl: string;
  title: string;
  author: string;
  releaseDate: string;
  platform: string;
  downloadUrl: string;
  /** Sequential row number in the CSV (1-based, after header). */
  rowNum: number;
}

/**
 * Minimal RFC 4180-ish parser: handles quoted fields, embedded commas,
 * and embedded "" (escaped quote). Does NOT handle embedded newlines —
 * the demozoo CSV doesn't use them.
 */
function readCsv(filePath: string): CsvRow[] {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
  const lines: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { cur.push(field); field = ''; }
      else if (ch === '\n') { cur.push(field); lines.push(cur); cur = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else { field += ch; }
    }
  }
  if (field.length || cur.length) { cur.push(field); lines.push(cur); }
  if (lines.length === 0) return [];
  const header = lines[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const out: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i];
    out.push({
      demozooUrl: (cells[idx('demozoo url')] ?? '').trim(),
      title: (cells[idx('title')] ?? '').trim(),
      author: (cells[idx('by')] ?? '').trim(),
      releaseDate: (cells[idx('release date')] ?? '').trim(),
      platform: (cells[idx('platform')] ?? '').trim(),
      downloadUrl: (cells[idx('download url')] ?? '').trim(),
      rowNum: i,
    });
  }
  return out;
}

// ─── Filename extraction ─────────────────────────────────────────────────────

function filenameFromUrl(rawUrl: string): string | null {
  if (!rawUrl) return null;
  // The "download url" column may contain multiple space-separated fallback
  // URLs. Pick the first one with a usable filename.
  for (const candidate of rawUrl.split(/\s+/)) {
    const t = candidate.trim();
    if (!t) continue;
    const fn = filenameFromSingleUrl(t);
    if (fn) return fn;
  }
  return null;
}

function filenameFromSingleUrl(target: string): string | null {
  try {
    const u = new URL(target);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (!last) return null;
    return decodeURIComponent(last);
  } catch {
    return null;
  }
}

// ─── Version extraction ──────────────────────────────────────────────────────

const VERSION_RE = /\s+v([\d.]*[\doO]+)/i;
function splitNameAndVersion(title: string, fallback: string): { name: string; version: string | null } {
  const m = title.match(VERSION_RE);
  if (!m) return { name: title || fallback, version: null };
  if (/[a-zA-Z]/.test(m[1].replace(/[oO]/g, ''))) {
    return { name: title || fallback, version: null };
  }
  let raw = m[1].replace(/\.+$/, '').replace(/[oO]$/, '0');
  if (!/^\d+(\.\d+)*$/.test(raw)) return { name: title || fallback, version: null };
  const escaped = m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = (title || fallback).replace(new RegExp(escaped, 'i'), '').replace(/\s+$/, '').trim();
  return { name, version: `v${raw}` };
}

// ─── By-field parsing (author + release_group) ───────────────────────────────

/**
 * Split the demozoo CSV "By" field into author + release_group. The
 * convention: when the field is a personal credit "X / Y", X is the
 * individual author and Y is the group. When it's a crossover like
 * "Up Rough /X Innovations", both sides are groups and the whole
 * string is one group name.
 *
 * Discriminator: is each side a known group? We learn "known group"
 * from the existing catalog (any author credit that appears 3 or more
 * times). Groups dominate demozoo's "By" field so the default for
 * ambiguous cases is "this whole thing is a group name".
 *
 *   "Ice-T Junior / Prozac"   → author=Ice-T Junior, group=Prozac
 *   "Up Rough /X Innovations" → author=null,         group=Up Rough /X Innovations
 *   "fANTASTiC/cracKerz"      → author=null,         group=fANTASTiC/cracKerz
 *   "Prozac" (known group)    → author=null,         group=Prozac
 *   "Alexander Corris" (unkn) → author=Alexander Corris, group=null
 */
function splitByAndGroup(
  by: string,
  knownGroups: ReadonlySet<string>,
): { author: string | null; releaseGroup: string | null } {
  const v = by.trim();
  if (!v) return { author: null, releaseGroup: null };

  // The 'X / Y' scene convention. Splits on the first ' / ' (spaces
  // around the slash) — the form used for "person / group". Tighter
  // patterns like ' /Y' (X Innovations) or 'X/Y' (Cracking/Ansi) are
  // crossovers between two groups; the whole string stays intact.
  const spaced = v.indexOf(' / ');
  if (spaced > 0) {
    const left = v.slice(0, spaced).trim();
    const right = v.slice(spaced + 3).trim();
    if (left && right) {
      const leftIsGroup = knownGroups.has(left);
      const rightIsGroup = knownGroups.has(right);
      if (leftIsGroup && rightIsGroup) {
        // Both are known groups — treat the whole thing as one group
        // name (crossover). Don't try to pick a side.
        return { author: null, releaseGroup: v };
      }
      if (rightIsGroup) {
        return { author: left, releaseGroup: right };
      }
      if (leftIsGroup) {
        return { author: right, releaseGroup: left };
      }
      // Neither is a known group. Demozoo's "By" is mostly groups,
      // so default to release_group rather than author.
      return { author: null, releaseGroup: v };
    }
  }

  // No ' / ' separator. Check if the whole string is a known group.
  if (knownGroups.has(v)) {
    return { author: null, releaseGroup: v };
  }

  // Single token that doesn't match any known group. Treat it as a
  // personal author credit (the alternative — release_group=null,
  // author=null — would discard the information entirely).
  return { author: v, releaseGroup: null };
}

/**
 * Build the set of known group names from the existing catalog. A
 * "group" is any non-empty author credit appearing 3 or more times.
 * This is a noisy heuristic but it lines up with the scene: real
 * groups produce a lot of releases, one-off author credits do not.
 */
function buildKnownGroups(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT author, COUNT(*) as n
      FROM door_catalog
     WHERE author IS NOT NULL AND author != ''
     GROUP BY author
    HAVING n >= 3
  `).all() as { author: string; n: number }[];
  const s = new Set<string>();
  for (const r of rows) s.add(r.author);
  return s;
}

/**
 * Extract the short release-group tag from an archive filename. The
 * scene convention is "TAG-suffix" where TAG is 1-5 alphanumeric
 * characters, e.g. UP-PL10.ZIP → UP, FLT-001.LHA → FLT, 5D-FOO.ZIP
 * → 5D. This is the same regex buildGroupTags() uses on the corpus.
 *
 * Returns uppercase or null if no recognizable prefix. We never guess
 * a group from the DIZ text — the filename is the only reliable
 * source when the curator hasn't set a release_group explicitly.
 */
const GROUP_TAG_RE = /^([A-Za-z0-9!$^&]{1,5})[-_^!.]/;
function releaseGroupFromFilename(archiveName: string): string | null {
  const m = GROUP_TAG_RE.exec(archiveName);
  if (!m) return null;
  return m[1].toUpperCase();
}

// ─── Download (parallel, keep-alive) ─────────────────────────────────────────

// Per-host keep-alive agent. scene.org is the dominant target — a single
// agent keyed by hostname lets us reuse TLS+TCP across hundreds of requests.
const AGENT_CACHE = new Map<string, https.Agent | http.Agent>();
function agentFor(url: string): https.Agent | http.Agent {
  const isHttps = url.startsWith('https:');
  const u = new URL(url);
  const key = `${isHttps ? 'https' : 'http'}://${u.host}`;
  let a = AGENT_CACHE.get(key);
  if (!a) {
    if (isHttps) {
      a = new https.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30_000 });
    } else {
      a = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 30_000 });
    }
    AGENT_CACHE.set(key, a);
  }
  return a;
}

interface DownloadResult { size: number; md5: string; sha256: string; bytesFromNetwork: number; redirects: number; }

const MAX_429_RETRIES = 3;
const RETRY_429_DELAYS_MS = [2000, 8000, 30000];
const MAX_5XX_RETRIES = 1;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Download a URL chain (following redirects) to a file. Returns metadata.
 *
 * Retry policy:
 *   - 404, 403, 410: NO retry. The resource is gone; retrying only burns time.
 *   - 429: retry up to 3x with backoff (2s, 8s, 30s).
 *   - 5xx: retry once after 5s (transient).
 *   - Network error / timeout: retry once after 2s.
 *
 * Note: scene.org rate-limits at ~30 req/s per IP, and the demozoo CSV is
 * bulk-imported by one user — pacing via concurrency (not per-request sleep)
 * is enough. The `--concurrency=N` flag controls parallelism.
 */
function downloadToFile(rawUrl: string, destPath: string): Promise<DownloadResult> {
  // scene.org serves the same content over HTTPS that the CSV lists as
  // FTP; rewrite ftp://scene.org to https:// to avoid needing an FTP
  // client. Other hosts (defacto2, aminet) are already HTTPS.
  const initialUrl = rawUrl.replace(/^ftp:\/\/ftp\.scene\.org\//i, 'https://ftp.scene.org/');
  return downloadWithRedirects(initialUrl, destPath, 0, { size: 0, md5: '', sha256: '', bytesFromNetwork: 0, redirects: 0 });
}

function downloadWithRedirects(
  url: string,
  destPath: string,
  redirectCount: number,
  accum: DownloadResult,
): Promise<DownloadResult> {
  if (redirectCount > 5) return Promise.reject(new Error('too many redirects'));
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const get = isHttps ? https.get : http.get;
    const req = get(url, { agent: agentFor(url), headers: { 'User-Agent': 'AmiExpress-DoorServer/1.0' } }, (res) => {
      // Redirects — re-issue with the same destPath. The new request
      // reuses the per-host keep-alive agent.
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) {
        const loc = res.headers.location;
        if (!loc) { reject(new Error(`redirect ${res.statusCode} without location`)); return; }
        res.resume();
        accum.redirects++;
        downloadWithRedirects(new URL(loc, url).toString(), destPath, redirectCount + 1, accum).then(resolve, reject);
        return;
      }
      if (res.statusCode === 404 || res.statusCode === 403 || res.statusCode === 410) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      if (res.statusCode === 429) {
        res.resume();
        if (redirectCount < MAX_429_RETRIES) {
          const delay = RETRY_429_DELAYS_MS[Math.min(redirectCount, RETRY_429_DELAYS_MS.length - 1)];
          setTimeout(() => {
            downloadWithRedirects(url, destPath, redirectCount + 1, accum).then(resolve, reject);
          }, delay);
        } else {
          reject(new Error('HTTP 429 (max retries)'));
        }
        return;
      }
      if (res.statusCode && res.statusCode >= 500) {
        res.resume();
        if (redirectCount < MAX_5XX_RETRIES) {
          setTimeout(() => {
            downloadWithRedirects(url, destPath, redirectCount + 1, accum).then(resolve, reject);
          }, 5000);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      // 200 — pipe to file.
      const hashMd5 = crypto.createHash('md5');
      const hashSha256 = crypto.createHash('sha256');
      const file = fs.createWriteStream(destPath);
      res.on('data', (chunk: Buffer) => {
        hashMd5.update(chunk);
        hashSha256.update(chunk);
        accum.size += chunk.length;
        accum.bytesFromNetwork += chunk.length;
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        accum.md5 = hashMd5.digest('hex');
        accum.sha256 = hashSha256.digest('hex');
        resolve(accum);
      });
      file.on('error', (err) => { res.destroy(); reject(err); });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`)); });
    req.on('error', (err) => {
      if (redirectCount < 1) {
        setTimeout(() => {
          downloadWithRedirects(url, destPath, redirectCount + 1, accum).then(resolve, reject);
        }, 2000);
      } else {
        reject(err);
      }
    });
  });
}

// ─── Concurrency limiter (no extra dep) ──────────────────────────────────────

class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];
  constructor(permits: number) { this.available = permits; }
  async acquire(): Promise<void> {
    if (this.available > 0) { this.available--; return; }
    await new Promise<void>((r) => this.waiters.push(r));
    this.available--;
  }
  release(): void {
    this.waiters.shift()?.();
    this.available++;
  }
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

interface ExistingDoor {
  id: string;
  archive_name: string;
  name: string | null;
  version: string | null;
  author: string | null;
  release_date: string | null;
  platform: string | null;
  download_url: string | null;
  release_group: string | null;
  demozoo_url: string | null;
}

function findExistingDoor(db: Database.Database, archiveName: string): ExistingDoor | null {
  const row = db
    .prepare(`SELECT id, archive_name, name, version, author, release_date, platform,
                     download_url, release_group, demozoo_url
                FROM door_catalog
               WHERE archive_name = ? COLLATE NOCASE`)
    .get(archiveName) as ExistingDoor | undefined;
  return row ?? null;
}

function applyBackfill(
  db: Database.Database,
  existing: ExistingDoor,
  row: CsvRow,
  split: { name: string; version: string | null },
  knownGroups: ReadonlySet<string>,
  dryRun: boolean,
): { changed: boolean; fields: string[] } {
  const patch: Record<string, string | null> = {};
  // release_group short tag: from filename. Only set if the existing
  // row has no group yet — we never overwrite a curator's choice.
  const filenameTag = releaseGroupFromFilename(existing.archive_name);
  if (!existing.release_group && filenameTag) patch.release_group = filenameTag;

  // author / release_group_full_name (via release_groups table): from
  // the CSV's "By" field. We split it into personal author vs group
  // full name, only filling NULLs. Author is only set when the field
  // parses to a personal credit (not a group name).
  const by = row.author ? splitByAndGroup(row.author, knownGroups) : null;
  if (!existing.author && by?.author) patch.author = by.author;
  // (release_group_full_name is stored in the release_groups table,
  //  not in door_catalog — see upsertReleaseGroup below.)

  if (!existing.release_date && row.releaseDate) patch.release_date = row.releaseDate;
  if (!existing.platform && row.platform) patch.platform = row.platform;
  if (!existing.download_url && row.downloadUrl) patch.download_url = row.downloadUrl;
  if (!existing.version && split.version) patch.version = split.version;
  if (!existing.demozoo_url && row.demozooUrl) patch.demozoo_url = row.demozooUrl;
  // Name: only overwrite if the existing name is missing/empty AND the CSV
  // title is non-empty. The CSV title is often the full "Door Name v1.0"
  // though, and our column is just "Door Name" — the splitter handles that.
  if ((!existing.name || existing.name.trim() === '') && split.name) {
    patch.name = split.name;
  }
  const fields = Object.keys(patch);
  if (fields.length === 0) return { changed: false, fields: [] };
  if (dryRun) {
    console.log(`[csv] DRY: would UPDATE ${existing.archive_name} SET ${fields.map((f) => `${f}=?`).join(', ')}`);
  } else {
    const sets = fields.map((f) => `${f} = ?`).join(', ');
    const vals = fields.map((f) => patch[f]);
    db.prepare(`UPDATE door_catalog SET ${sets} WHERE id = ?`).run(...vals, existing.id);
    if (filenameTag && by?.releaseGroup) {
      upsertReleaseGroup(db, filenameTag, by.releaseGroup);
    }
  }
  return { changed: true, fields };
}

/**
 * Upsert a (short tag, full name) entry into the release_groups table.
 * If the tag already exists with a different full name, the new name
 * is only adopted when the existing one is empty. This way the
 * curator's edits win.
 */
function upsertReleaseGroup(db: Database.Database, abbreviation: string, fullName: string): void {
  db.prepare(`
    INSERT INTO release_groups (abbreviation, full_name, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(abbreviation) DO UPDATE
      SET full_name = CASE
        WHEN release_groups.full_name IS NULL OR release_groups.full_name = ''
        THEN excluded.full_name
        ELSE release_groups.full_name
      END,
      updated_at = strftime('%s','now')
  `).run(abbreviation, fullName);
}

// ─── Progress reporter ───────────────────────────────────────────────────────

class Progress {
  private total: number;
  private done = 0;
  private errors = 0;
  private bytesDownloaded = 0;
  private start = Date.now();
  private lastReport = 0;
  private phase: 'backfill' | 'download';
  constructor(total: number, phase: 'backfill' | 'download') {
    this.total = total;
    this.phase = phase;
  }
  tick(ok: boolean, bytes = 0): void {
    this.done++;
    if (!ok) this.errors++;
    this.bytesDownloaded += bytes;
    const now = Date.now();
    if (now - this.lastReport > 2000) {
      this.report();
      this.lastReport = now;
    }
  }
  finish(): void { this.report(); }
  private report(): void {
    const elapsed = (Date.now() - this.start) / 1000;
    const rate = this.done / elapsed;
    const remaining = (this.total - this.done) / Math.max(rate, 0.001);
    const mb = (this.bytesDownloaded / 1024 / 1024).toFixed(1);
    process.stderr.write(
      `\r[csv] ${this.phase}: ${this.done}/${this.total} (${(rate * 60).toFixed(0)}/min, ${this.errors} err, ${mb} MB, ~${Math.ceil(remaining / 60)} min left)   `,
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const csvPath = args[0];
  if (!csvPath) {
    console.error('usage: npx tsx scripts/demozoo-csv-import.ts <csv> [--dry-run] [--no-download] [--concurrency=N]');
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');
  const noDownload = args.includes('--no-download');
  const concurrencyArg = args.find((a) => a.startsWith('--concurrency='));
  const concurrency = concurrencyArg ? Math.max(1, parseInt(concurrencyArg.split('=')[1], 10)) : 8;
  if (dryRun) console.error('[csv] DRY RUN — no DB writes, no downloads');
  if (noDownload) console.error('[csv] NO DOWNLOAD — Phase 2 skipped');
  console.error(`[csv] concurrency=${concurrency}`);

  const cfg = loadConfig();
  console.error(`[csv] db=${cfg.dbPath} archives=${cfg.archivesRoot}`);
  const db = new Database(cfg.dbPath);
  // WAL mode lets multiple connections read while one writes — important
  // for the running doorserver to keep serving traffic during import.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  applySchema(db);
  runMigrations(db);

  // Make sure the per-CSV resumability table exists (idempotent).
  db.exec(`
    CREATE TABLE IF NOT EXISTS demozoo_csv_imported (
      row_num     INTEGER PRIMARY KEY,
      demozoo_url TEXT,
      archive_name TEXT,
      imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  const rows = readCsv(csvPath);
  console.error(`[csv] read ${rows.length} rows from ${csvPath}`);

  const submittedDir = path.join(cfg.archivesRoot, 'Submitted');
  fs.mkdirSync(submittedDir, { recursive: true });

  const archiveNameToDoor = new Map<string, ExistingDoor>();
  for (const d of db.prepare(`SELECT id, archive_name, name, version, author, release_date, platform,
                                     download_url, release_group, demozoo_url
                                  FROM door_catalog`).all() as ExistingDoor[]) {
    archiveNameToDoor.set(d.archive_name.toLowerCase(), d);
  }
  console.error(`[csv] loaded ${archiveNameToDoor.size} existing doors`);

  const importedRows = new Set<number>(
    (db.prepare('SELECT row_num FROM demozoo_csv_imported').all() as { row_num: number }[]).map((r) => r.row_num),
  );
  console.error(`[csv] ${importedRows.size} rows already imported`);

  // Phase 1 — backfill matching rows. This is fast and serial is fine,
  // but we still wrap it for consistent progress reporting.
  const toBackfill: CsvRow[] = [];
  for (const row of rows) {
    if (importedRows.has(row.rowNum)) continue;
    const filename = filenameFromUrl(row.downloadUrl);
    if (!filename) continue; // counted in phase 2 skip
    const lookup = filename.toLowerCase();
    if (archiveNameToDoor.has(lookup)) toBackfill.push(row);
  }
  console.error(`[csv] phase 1: backfill ${toBackfill.length} matching rows`);

  const progress1 = new Progress(toBackfill.length, 'backfill');
  let backfilled = 0;
  const knownGroups = buildKnownGroups(db);
  for (const row of toBackfill) {
    const filename = filenameFromUrl(row.downloadUrl)!;
    const split = splitNameAndVersion(row.title, filename.replace(/\.(lha|lzx|lzh|zip|dms)$/i, ''));
    const existing = archiveNameToDoor.get(filename.toLowerCase())!;
    const { changed, fields } = applyBackfill(db, existing, row, split, knownGroups, dryRun);
    if (changed) {
      backfilled++;
      if (!dryRun) process.stderr.write(`\n[csv] backfilled row ${row.rowNum} ${existing.archive_name} (${fields.join(', ')})\n`);
    }
    if (!dryRun) {
      try { db.prepare('INSERT OR IGNORE INTO demozoo_csv_imported (row_num, demozoo_url, archive_name) VALUES (?, ?, ?)').run(row.rowNum, row.demozooUrl, existing.archive_name); } catch {}
    }
    progress1.tick(true);
  }
  progress1.finish();
  process.stderr.write('\n');

  if (noDownload) {
    let skippedNoDownload = 0;
    for (const row of rows) {
      if (importedRows.has(row.rowNum)) continue;
      const filename = filenameFromUrl(row.downloadUrl);
      if (!filename) continue;
      if (archiveNameToDoor.has(filename.toLowerCase())) continue; // already backfilled
      process.stderr.write(`[csv] row ${row.rowNum} "${row.title}" → ${row.downloadUrl} (would download)\n`);
      skippedNoDownload++;
    }
    const skippedNoFilename = rows.filter((r) => !importedRows.has(r.rowNum) && !filenameFromUrl(r.downloadUrl)).length;
    console.error(`\n[csv] Done. backfilled=${backfilled} newDoors=0 downloaded=0 downloadFails=0 skippedNoDownload=${skippedNoDownload} skippedNoFilename=${skippedNoFilename} errors=0`);
    db.close();
    return;
  }

  // Phase 2 — download new archives in parallel. The DB is single-writer
  // (better-sqlite3 is synchronous), so we serialize the INSERT but
  // pipeline the network I/O.
  const toDownload: CsvRow[] = [];
  let skippedNoFilename = 0;
  for (const row of rows) {
    if (importedRows.has(row.rowNum)) continue;
    const filename = filenameFromUrl(row.downloadUrl);
    if (!filename) { skippedNoFilename++; continue; }
    if (archiveNameToDoor.has(filename.toLowerCase())) continue; // backfilled above
    toDownload.push(row);
  }
  console.error(`[csv] phase 2: download ${toDownload.length} new archives (skipping ${skippedNoFilename} with no filename)`);

  // Sort by URL so all requests to the same host run in a burst —
  // better cache locality, fewer TLS handshakes.
  toDownload.sort((a, b) => a.downloadUrl.localeCompare(b.downloadUrl));

  const progress2 = new Progress(toDownload.length, 'download');
  let downloaded = 0;
  let downloadFails = 0;
  let newDoors = 0;
  let errors = 0;
  let skippedNoDownload = 0;

  // Prepared statements are reused across all workers. better-sqlite3
  // statements are bound to a single connection, so we must serialize
  // their execution — hence the small async lock.
  const insertStmt = db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, name, door_type, version, author,
        release_date, platform, download_url, demozoo_url, release_group,
        file_id_diz, doc_filename, doc_raw,
        archive_size, md5, sha256, source, indexed_at)
     VALUES (?, ?, ?, ?, 'XIM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demozoo', strftime('%s','now'))`
  );
  const trackStmt = db.prepare(
    'INSERT OR IGNORE INTO demozoo_csv_imported (row_num, demozoo_url, archive_name) VALUES (?, ?, ?)'
  );
  const insertFileStmt = db.prepare(
    'INSERT OR IGNORE INTO door_catalog_files (catalog_id, path, size) VALUES (?, ?, ?)'
  );

  // Pick the right archive reader based on extension. LZX support
  // requires the WASM module; if it isn't available, we get an empty
  // result rather than a crash, which is fine — the rest of the row
  // still goes in, the curator can fill the DIZ in by hand if needed.
  function readContents(archivePath: string): ArchiveContents {
    const buf = fs.readFileSync(archivePath);
    const ext = path.extname(archivePath).toLowerCase();
    if (ext === '.lha' || ext === '.lzh') return readLhaContents(buf, archivePath);
    if (ext === '.lzx') return readLzxContents(buf);
    if (ext === '.zip') return readZipContents(buf);
    return { files: [], fileIdDiz: null, docFilename: null, doc: null };
  }

  // Async lock — better-sqlite3 is synchronous so concurrent JS tasks
  // would interleave their .run() calls. Each DB write goes through
  // this lock to keep the statement sequence coherent.
  let dbLock: Promise<void> = Promise.resolve();
  const withDb = async <T>(fn: () => T): Promise<T> => {
    const prev = dbLock;
    let resolveNext!: () => void;
    dbLock = new Promise<void>((r) => { resolveNext = r; });
    await prev;
    try { return fn(); } finally { resolveNext(); }
  };

  // Register an existing file on disk: hash it, read its FILE_ID.DIZ,
  // insert the DB row + file list. The "file already exists" branch is
  // what makes a re-run after a partial download recover. The serial
  // version skipped this and just counted it as a skip — meaning the
  // local DB ended up with 0 demozoo rows even though 1600 files were
  // sitting in Submitted/. That was the silent-loss bug. Hashing 1600
  // small files takes a few seconds total and is much cheaper than
  // re-downloading them. Reading the DIZ is another few seconds.
  const registerExisting = async (row: CsvRow, destPath: string, filename: string) => {
    const split = splitNameAndVersion(row.title, filename.replace(/\.(lha|lzx|lzh|zip|dms)$/i, ''));
    const buf = fs.readFileSync(destPath);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const size = buf.length;
    const contents = readContents(destPath);
    const filenameTag = releaseGroupFromFilename(filename);
    const by = row.author ? splitByAndGroup(row.author, knownGroups) : null;
    if (dryRun) {
      newDoors++;
      await withDb(() => { try { trackStmt.run(row.rowNum, row.demozooUrl, filename); } catch {} });
      progress2.tick(true, size);
      return;
    }
    const catalogId = crypto.randomUUID();
    try {
      await withDb(() => {
        insertStmt.run(
          catalogId,
          filename,
          path.posix.join('Submitted', filename),
          split.name,
          split.version,
          by?.author || null,
          row.releaseDate || null,
          row.platform || null,
          row.downloadUrl || null,
          row.demozooUrl || null,
          filenameTag,
          contents.fileIdDiz,
          contents.docFilename,
          contents.doc,
          size,
          md5,
          sha256,
        );
        for (const f of contents.files) {
          try { insertFileStmt.run(catalogId, f.path, f.size); } catch {}
        }
        if (filenameTag && by?.releaseGroup) {
          upsertReleaseGroup(db, filenameTag, by.releaseGroup);
        }
        try { trackStmt.run(row.rowNum, row.demozooUrl, filename); } catch {}
      });
      newDoors++;
      if (process.env.CSV_VERBOSE) process.stderr.write(`\n[csv] registered existing row ${row.rowNum} ${filename} (${size} bytes, ${contents.fileIdDiz ? 'DIZ ' + contents.fileIdDiz.length + ' chars' : 'no DIZ'}, ${contents.files.length} files)\n`);
      progress2.tick(true, size);
    } catch (e: any) {
      errors++;
      progress2.tick(false);
      process.stderr.write(`\n[csv] INSERT failed row ${row.rowNum} ${filename}: ${e.message}\n`);
    }
  };

  const sem = new Semaphore(concurrency);
  const workers = toDownload.map(async (row) => {
    await sem.acquire();
    try {
      const filename = filenameFromUrl(row.downloadUrl)!;
      const destPath = path.join(submittedDir, filename);
      if (fs.existsSync(destPath)) {
        // File is on disk but DB row may be missing (e.g. DB was reset
        // but archives were kept). Register it instead of skipping.
        await registerExisting(row, destPath, filename);
        return;
      }
      const tmpPath = path.join(submittedDir, `.tmp.${row.rowNum}.${filename}`);
      let dl: DownloadResult;
      try {
        dl = await downloadToFile(row.downloadUrl, tmpPath);
        downloaded++;
      } catch (e: any) {
        try { fs.unlinkSync(tmpPath); } catch {}
        downloadFails++;
        errors++;
        progress2.tick(false);
        if (process.env.CSV_VERBOSE) process.stderr.write(`\n[csv] download failed row ${row.rowNum} ${filename}: ${e.message}\n`);
        return;
      }
      fs.renameSync(tmpPath, destPath);
      if (dryRun) {
        newDoors++;
        await withDb(() => { try { trackStmt.run(row.rowNum, row.demozooUrl, filename); } catch {} });
        progress2.tick(true, dl.bytesFromNetwork);
        return;
      }
      const split = splitNameAndVersion(row.title, filename.replace(/\.(lha|lzx|lzh|zip|dms)$/i, ''));
      const contents = readContents(destPath);
      const filenameTag = releaseGroupFromFilename(filename);
      const by = row.author ? splitByAndGroup(row.author, knownGroups) : null;
      const catalogId = crypto.randomUUID();
      try {
        await withDb(() => {
          insertStmt.run(
            catalogId,
            filename,
            path.posix.join('Submitted', filename),
            split.name,
            split.version,
            by?.author || null,
            row.releaseDate || null,
            row.platform || null,
            row.downloadUrl || null,
            row.demozooUrl || null,
            filenameTag,
            contents.fileIdDiz,
            contents.docFilename,
            contents.doc,
            dl.size,
            dl.md5,
            dl.sha256,
          );
          for (const f of contents.files) {
            try { insertFileStmt.run(catalogId, f.path, f.size); } catch {}
          }
          if (filenameTag && by?.releaseGroup) {
            upsertReleaseGroup(db, filenameTag, by.releaseGroup);
          }
          try { trackStmt.run(row.rowNum, row.demozooUrl, filename); } catch {}
        });
        newDoors++;
        if (process.env.CSV_VERBOSE) process.stderr.write(`\n[csv] new door inserted row ${row.rowNum} ${filename} (${dl.size} bytes, ${contents.fileIdDiz ? 'DIZ ' + contents.fileIdDiz.length + ' chars' : 'no DIZ'}, ${contents.files.length} files)\n`);
        progress2.tick(true, dl.bytesFromNetwork);
      } catch (e: any) {
        errors++;
        progress2.tick(false);
        process.stderr.write(`\n[csv] INSERT failed row ${row.rowNum} ${filename}: ${e.message}\n`);
      }
    } finally {
      sem.release();
    }
  });
  await Promise.all(workers);

  progress2.finish();
  process.stderr.write('\n');
  console.error(`\n[csv] Done. backfilled=${backfilled} newDoors=${newDoors} downloaded=${downloaded} downloadFails=${downloadFails} skippedNoDownload=${skippedNoDownload} skippedNoFilename=${skippedNoFilename} errors=${errors}`);
  db.close();
  for (const a of AGENT_CACHE.values()) a.destroy();
}

main().catch((e) => {
  console.error('[csv] fatal:', e);
  process.exit(1);
});
