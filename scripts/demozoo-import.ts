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

const TAGS = ['amiex', 'daydream-amiga', 'fame'];
const DEMOZOO_API = 'https://demozoo.org/api/v1';
const PAUSE_BETWEEN_REQUESTS_MS = 500;
const PAUSE_EVERY_N_REQUESTS = 100;
const PAUSE_DURATION_MS = 5000;
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 4000, 16000];

// ─── Types ───────────────────────────────────────────────────────────────────

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

interface NewDoorCandidate {
  id: number;
  detail: DemozooDetail;
  filename: string;
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

interface DownloadResult {
  path: string;
  size: number;
  md5: string;
  sha256: string;
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

async function enumerateProductionIds(tag: string): Promise<number[]> {
  const cacheFile = path.join('/tmp', `demozoo-ids-${tag}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as number[];
      // Reject poisoned caches: an enumeration that returned the unfiltered
      // total (388K) would have been written here before the sanity check
      // existed. Treat any cache over the sanity threshold as corrupt and
      // force a re-fetch.
      if (cached.length > 10000) {
        process.stderr.write(`[demozoo] WARNING: cache ${cacheFile} has ${cached.length} IDs (>10000) — treating as poisoned, re-enumerating\n`);
        fs.unlinkSync(cacheFile);
      } else {
        process.stderr.write(`[demozoo] enumerate tag="${tag}" loaded ${cached.length} IDs from cache ${cacheFile}\n`);
        return cached;
      }
    } catch {
      // fall through to fresh enumeration
    }
  }

  const ids: number[] = [];
  // production_type=53 is the demozoo ID for "BBS Door" — Demozoo's JSON
  // production API ignores tag filters (returns the unfiltered 388K
  // total), so we scrape the HTML listing pages instead. The HTML
  // search form accepts the production_type param and filters correctly.
  // HTML doesn't break, while /api/v1/productions/?tag=foo does.
  const TYPE_BBS_DOOR = 53;
  let page = 1;
  const seen = new Set<number>();
  const PROD_LINK_RE = /href="\/productions\/(\d+)\/"/g;

  while (true) {
    const url = `https://demozoo.org/productions/?tag=${encodeURIComponent(tag)}&production_type=${TYPE_BBS_DOOR}&page=${page}`;
    process.stderr.write(`[demozoo] enumerate tag="${tag}" page=${page} url=${url}\n`);
    const html = await fetch(url);
    const matches = [...html.matchAll(PROD_LINK_RE)];
    let addedThisPage = 0;
    for (const m of matches) {
      const id = Number(m[1]);
      if (!seen.has(id)) { seen.add(id); ids.push(id); addedThisPage++; }
    }
    process.stderr.write(`[demozoo] tag="${tag}" page=${page} found ${addedThisPage} new IDs (${ids.length} total)\n`);
    if (addedThisPage === 0) break; // last page reached
    page++;
    if (page > 200) {
      // Safety cap: no real tag has more than a few hundred BBS-Door
      // productions. If we're past 200 pages, something is wrong.
      process.stderr.write(`[demozoo] WARNING: hit 200-page safety cap for tag="${tag}", aborting\n`);
      break;
    }
    await sleep(PAUSE_BETWEEN_REQUESTS_MS);
  }

  try {
    fs.writeFileSync(cacheFile, JSON.stringify(ids));
    process.stderr.write(`[demozoo] cached ${ids.length} IDs to ${cacheFile}\n`);
  } catch (e: any) {
    process.stderr.write(`[demozoo] WARNING: failed to write ID cache: ${e.message}\n`);
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

async function main() {
  const cfg = loadConfig();
  const db = openSqlite(cfg.dbPath);
  applySchema(db);
  runMigrations(db);

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
    .prepare('SELECT id, archive_name, name, version, author, release_date, platform, download_url, credits, external_links, screenshots FROM door_catalog WHERE archive_name IS NOT NULL')
    .all() as ExistingDoor[];

  const archiveNameToDoor = new Map(existingDoors.map((d) => [d.archive_name.toLowerCase(), d]));

  const imported = new Set<number>(
    (db.prepare('SELECT id FROM demozoo_imported').all() as { id: number }[]).map((r) => r.id)
  );

  const newDoorCandidates: NewDoorCandidate[] = [];
  let requestCount = 0;

  // ── Phase 1: enumerate and backfill existing doors ──────────────────────────
  for (const tag of TAGS) {
    process.stderr.write(`[demozoo] Phase 1 tag="${tag}"\n`);
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

    const toProcess = ids.filter((id) => !imported.has(id));
    process.stderr.write(`[demozoo] tag="${tag}" ${toProcess.length} to process (${ids.length - toProcess.length} already imported)\n`);

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

        if (!match) {
          const sceneOrgUrl = detail!.download_links?.[0]?.url ?? null;
          if (sceneOrgUrl) {
            newDoorCandidates.push({ id, detail: detail!, filename });
          } else {
            process.stderr.write(`[demozoo] id=${id} "${detail!.title}" filename="${filename}" — no local match and no scene.org URL, skipping\n`);
            errorLog.push(`nomatch+nodl:${id}:${filename}:${detail!.title}`);
            stats.skippedNoDownload++;
          }
          stats.unmatched++;
          continue;
        }

        const patch: Record<string, unknown> = {};
        if (detail!.release_date && !match.release_date) patch.release_date = detail!.release_date;
        if (detail!.platform && !match.platform) patch.platform = detail!.platform;
        const dl = detail!.download_links?.[0]?.url;
        if (dl && !match.download_url) patch.download_url = dl;
        const creds = parseCredits(detail!.credits ?? []);
        if (creds && !match.credits) patch.credits = creds;
        const links = parseLinks(detail!.external_links ?? []);
        if (links && !match.external_links) patch.external_links = links;
        const shots = parseScreenshots(detail!.screenshots ?? []);
        if (shots && !match.screenshots) patch.screenshots = shots;

        if (Object.keys(patch).length > 0) {
          const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
          const vals = Object.values(patch);
          db.prepare(`UPDATE door_catalog SET ${sets} WHERE id = ?`).run(...vals, match.id);
          recordAudit(db, null, 'import-demozoo', match.archive_name, { enriched: Object.keys(patch) });
          process.stderr.write(`[demozoo] backfilled id=${id} "${match.archive_name}" with ${Object.keys(patch).join(', ')}\n`);
          stats.backfilled++;
        } else {
          process.stderr.write(`[demozoo] id=${id} "${match.archive_name}" already enriched\n`);
        }

        try {
          db.prepare('INSERT OR IGNORE INTO demozoo_imported (id, imported_at) VALUES (?, ?)').run(id, Date.now());
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
  }

  // ── Phase 2: download new doors from scene.org ──────────────────────────────
  if (newDoorCandidates.length > 0) {
    process.stderr.write(`[demozoo] Phase 2: ${newDoorCandidates.length} new door candidates\n`);

    for (const candidate of newDoorCandidates) {
      const { id, detail, filename } = candidate;
      const sceneOrgUrl = detail.download_links?.[0]?.url;
      if (!sceneOrgUrl) {
        stats.skippedNoDownload++;
        continue;
      }

      const destBasename = filename;
      const destPath = path.join(submittedDir, destBasename);

      if (fs.existsSync(destPath)) {
        process.stderr.write(`[demozoo] id=${id} "${filename}" already exists in Submitted/, skipping\n`);
        try {
          db.prepare('INSERT OR IGNORE INTO demozoo_imported (id, imported_at) VALUES (?, ?)').run(id, Date.now());
        } catch { /* ok */ }
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
      const name = detail.title || path.basename(destBasename, path.extname(destBasename));
      const version = (name.match(/v?[\d\.]+/i) ?? [])[0] ?? null;

      try {
        db.prepare(
          `INSERT INTO door_catalog
             (id, archive_name, archive_path, name, door_type, version, author,
              description, release_date, platform, download_url, credits,
              external_links, screenshots, archive_size, md5, sha256, source, indexed_at)
           VALUES (?, ?, ?, ?, 'XIM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demozoo', strftime('%s','now'))`
        ).run(
          catalogId,
          destBasename,
          path.posix.join('Submitted', destBasename),
          name,
          version,
          detail.credits?.[0]?.person ?? null,
          detail.description ?? null,
          detail.release_date ?? null,
          detail.platform ?? null,
          sceneOrgUrl,
          parseCredits(detail.credits ?? []),
          parseLinks(detail.external_links ?? []),
          parseScreenshots(detail.screenshots ?? []),
          dlResult.size,
          dlResult.md5,
          dlResult.sha256
        );
        db.prepare('INSERT OR IGNORE INTO demozoo_imported (id, imported_at) VALUES (?, ?)').run(id, Date.now());
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
