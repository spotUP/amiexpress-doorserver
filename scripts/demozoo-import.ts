#!/usr/bin/env npx tsx

/**
 * Demozoo BBS Door Importer
 *
 * Imports AMIExpress BBS doors from demozoo.org into the local catalog.
 * Tags: amiex, daydream-amiga, fame
 *
 * For each production on Demozoo:
 *   1. Fetch list page (JSON API) to get IDs
 *   2. Fetch detail (JSON API) for metadata
 *   3. Fetch detail HTML to extract the Filename: line
 *   4. Match against local archive_name set (strict lowercase)
 *   5. New door → download from scene.org → quarantine → door_submissions → approveSubmission → enrich
 *   6. Existing door → backfill NULL columns → recordAudit
 *
 * Re-runnable: tracks imported IDs in demozoo_imported table.
 * Admin identity for audit: NULL → 'system' via COALESCE fallback in recordAudit.
 */

import Database from 'better-sqlite3';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { recordAudit } from '../src/auth';

const TAGS = ['amiex', 'daydream-amiga', 'fame'];
const DEMOZOO_API = 'https://demozoo.org/api/v1';
const PAUSE_BETWEEN_REQUESTS_MS = 2000;
const PAUSE_EVERY_N_REQUESTS = 50;
const PAUSE_DURATION_MS = 10000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 4000, 16000];

// ─── Types ───────────────────────────────────────────────────────────────────

interface DemozooProduction {
  id: number;
  title: string;
  release_date: string | null;
  platform: string | null;
  download_links: { url: string; type: string }[];
  credits: { person: string; role: string }[];
  external_links: { url: string; type: string }[];
  screenshots: string[];
}

interface DemozooDetail {
  id: number;
  title: string;
  release_date: string | null;
  platform: string | null;
  download_links: { url: string; type: string }[];
  credits: { person: string; role: string }[];
  external_links: { url: string; type: string }[];
  screenshots: string[];
  description: string | null;
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
}

interface ImporterStats {
  processed: number;
  new: number;
  backfilled: number;
  unmatched: number;
  errors: number;
  sceneOrgDownloads: number;
  sceneOrgFails: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fetch(url: string, retries = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const doFetch = (attempt: number) => {
      https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'AmiExpress-DoorServer/1.0' } }, (res) => {
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
      }).on('error', (err) => {
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

function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Failed to parse JSON from response`);
  }
}

function parseFilenameFromHtml(html: string): string | null {
  const match = html.match(/Filename:\s*([^\s<]+)/i);
  return match ? match[1] : null;
}

function sceneOrgDownload(url: string, destPath: string, retries = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const doDownload = (attempt: number) => {
      https.get(url, { headers: { 'User-Agent': 'AmiExpress-DoorServer/1.0' } }, (res) => {
        if (res.statusCode === 429 && attempt < MAX_RETRIES) {
          console.error(`[demozoo] scene.org 429, retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAYS_MS[attempt]}ms`);
          setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]);
          return;
        }
        if (res.statusCode !== 302 && res.statusCode !== 301 && res.statusCode !== 200) {
          if (attempt < MAX_RETRIES) {
            console.error(`[demozoo] scene.org HTTP ${res.statusCode}, retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAYS_MS[attempt]}ms`);
            setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]);
          } else {
            reject(new Error(`scene.org HTTP ${res.statusCode}`));
          }
          return;
        }
        const location = res.headers.location;
        if (location && (res.statusCode === 302 || res.statusCode === 301)) {
          https.get(location, { headers: { 'User-Agent': 'AmiExpress-DoorServer/1.0' } }, (res2) => {
            if (res2.statusCode !== 200) {
              if (attempt < MAX_RETRIES) {
                setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]);
              } else {
                reject(new Error(`scene.org redirect to ${location} returned ${res2.statusCode}`));
              }
              return;
            }
            const file = fs.createWriteStream(destPath);
            res2.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', reject);
          }).on('error', (err) => {
            if (attempt < MAX_RETRIES) {
              setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]);
            } else {
              reject(err);
            }
          });
          return;
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', (err) => {
        if (attempt < MAX_RETRIES) {
          console.error(`[demozoo] scene.org download error (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
          setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]);
        } else {
          reject(err);
        }
      });
    };
    doDownload(0);
  });
}

function jsonOrNull<T>(val: string | null): T | null {
  if (!val) return null;
  try { return JSON.parse(val) as T; } catch { return null; }
}

function parseCredits(credits: { person: string; role: string }[]): string | null {
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

// ─── Core Logic ──────────────────────────────────────────────────────────────

async function enumerateProductionIds(tag: string): Promise<number[]> {
  const ids: number[] = [];
  let url = `${DEMOZOO_API}/productions/?tag=${encodeURIComponent(tag)}&format=json&fields=id`;

  while (url) {
    process.stderr.write(`[demozoo] enumerate tag="${tag}" url=${url}\n`);
    const body = await fetch(url);
    const data = parseJson<{ results: { id: number }[]; next: string | null }>(body);
    for (const prod of data.results) {
      ids.push(prod.id);
    }
    url = data.next ?? '';
    if (url) await sleep(PAUSE_BETWEEN_REQUESTS_MS);
  }

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

function backfillNeeded(row: ExistingDoor, detail: DemozooDetail): { patch: Record<string, unknown>; empty: boolean } {
  const patch: Record<string, unknown> = {};
  if (detail.release_date && !row.release_date) patch.release_date = detail.release_date;
  if (detail.platform && !row.platform) patch.platform = detail.platform;
  const dl = detail.download_links?.[0]?.url;
  if (dl && !row.download_url) patch.download_url = dl;
  const creds = parseCredits(detail.credits ?? []);
  if (creds && !row.credits) patch.credits = creds;
  const links = parseLinks(detail.external_links ?? []);
  if (links && !row.external_links) patch.external_links = links;
  const shots = parseScreenshots(detail.screenshots ?? []);
  if (shots && !row.screenshots) patch.screenshots = shots;

  return { patch, empty: Object.keys(patch).length === 0 };
}

async function main() {
  const cfg = loadConfig();
  const db = openSqlite(cfg.dbPath);
  applySchema(db);
  runMigrations(db);

  const archivesRoot = cfg.archivesRoot;
  const quarantineDir = path.join(archivesRoot, 'Submitted');

  if (!fs.existsSync(quarantineDir)) {
    fs.mkdirSync(quarantineDir, { recursive: true });
  }

  const stats: ImporterStats = { processed: 0, new: 0, backfilled: 0, unmatched: 0, errors: 0, sceneOrgDownloads: 0, sceneOrgFails: 0 };
  const errorLog: string[] = [];

  const existingDoors = db
    .prepare('SELECT id, archive_name, name, version, author, release_date, platform, download_url, credits, external_links, screenshots FROM door_catalog WHERE archive_name IS NOT NULL')
    .all() as ExistingDoor[];

  const archiveNameSet = new Set(existingDoors.map((d) => d.archive_name.toLowerCase()));
  const archiveNameToDoor = new Map(existingDoors.map((d) => [d.archive_name.toLowerCase(), d]));

  const imported = new Set<number>(
    (db.prepare('SELECT id FROM demozoo_imported').all() as { id: number }[]).map((r) => r.id)
  );

  let requestCount = 0;

  for (const tag of TAGS) {
    process.stderr.write(`[demozoo] Processing tag="${tag}"\n`);
    let ids: number[];
    try {
      ids = await enumerateProductionIds(tag);
    } catch (e: any) {
      process.stderr.write(`[demozoo] ERROR enumerating tag "${tag}": ${e.message}\n`);
      errorLog.push(`enumerate:${tag}: ${e.message}`);
      stats.errors++;
      continue;
    }
    process.stderr.write(`[demozoo] tag="${tag}" found ${ids.length} productions\n`);

    for (const id of ids) {
      if (imported.has(id)) {
        process.stderr.write(`[demozoo] id=${id} already imported, skipping\n`);
        continue;
      }

      requestCount++;
      if (requestCount % PAUSE_EVERY_N_REQUESTS === 0) {
        process.stderr.write(`[demozoo] request count ${requestCount}, pausing ${PAUSE_DURATION_MS}ms\n`);
        await sleep(PAUSE_DURATION_MS);
      } else {
        await sleep(PAUSE_BETWEEN_REQUESTS_MS);
      }

      let detail: DemozooDetail;
      let html: string;
      let filename: string | null = null;

      try {
        [detail, html] = await Promise.all([
          fetchDetailJson(id),
          fetchDetailHtml(id),
        ]);
        filename = parseFilenameFromHtml(html);
      } catch (e: any) {
        process.stderr.write(`[demozoo] ERROR fetching id=${id}: ${e.message}\n`);
        errorLog.push(`fetch:${id}: ${e.message}`);
        stats.errors++;
        continue;
      }

      stats.processed++;

      if (!filename) {
        process.stderr.write(`[demozoo] id=${id} "${detail.title}" — no filename in HTML, skipping\n`);
        errorLog.push(`nofilename:${id}: ${detail.title}`);
        stats.unmatched++;
        continue;
      }

      const lookup = filename.toLowerCase();
      const match = archiveNameToDoor.get(lookup);

      if (!match) {
        process.stderr.write(`[demozoo] id=${id} "${detail.title}" filename="${filename}" — no local match, skipping\n`);
        errorLog.push(`unmatched:${id}:${filename}:${detail.title}`);
        stats.unmatched++;
        continue;
      }

      const patch: Record<string, unknown> = {};
      if (detail.release_date && !match.release_date) patch.release_date = detail.release_date;
      if (detail.platform && !match.platform) patch.platform = detail.platform;
      const dl = detail.download_links?.[0]?.url;
      if (dl && !match.download_url) patch.download_url = dl;
      const creds = parseCredits(detail.credits ?? []);
      if (creds && !match.credits) patch.credits = creds;
      const links = parseLinks(detail.external_links ?? []);
      if (links && !match.external_links) patch.external_links = links;
      const shots = parseScreenshots(detail.screenshots ?? []);
      if (shots && !match.screenshots) patch.screenshots = shots;

      if (Object.keys(patch).length > 0) {
        const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
        const vals = Object.values(patch);
        db.prepare(`UPDATE door_catalog SET ${sets} WHERE id = ?`).run(...vals, match.id);
        recordAudit(db, null, 'import-demozoo', match.archive_name, { enriched: Object.keys(patch) });
        process.stderr.write(`[demozoo] backfilled id=${id} "${match.archive_name}" with ${Object.keys(patch).join(', ')}\n`);
        stats.backfilled++;
      } else {
        process.stderr.write(`[demozoo] id=${id} "${match.archive_name}" already enriched, no updates\n`);
      }

      try {
        db.prepare('INSERT OR IGNORE INTO demozoo_imported (id, imported_at) VALUES (?, ?)').run(id, Date.now());
      } catch {
        // already inserted by a concurrent run, ignore
      }
    }
  }

  process.stderr.write(`\n[demozoo] Done. stats=${JSON.stringify(stats)}\n`);
  if (errorLog.length > 0) {
    process.stderr.write(`[demozoo] Errors:\n`);
    for (const e of errorLog) {
      process.stderr.write(`  ${e}\n`);
    }
  }

  db.close();
}

function openSqlite(path: string): Database.Database {
  return new Database(path);
}

main().catch((e) => {
  console.error('[demozoo] fatal:', e);
  process.exit(1);
});
