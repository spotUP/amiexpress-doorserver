#!/usr/bin/env npx tsx

/**
 * Demozoo BBS Door Importer — CSV edition.
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
 * Differs from scripts/demozoo-import.ts: that script scrapes the
 * demozoo.org API for every production. The CSV skips that step (the
 * admin has already done the enumeration) and goes straight to
 * match+backfill+download.
 *
 * Usage:
 *   npx tsx scripts/demozoo-csv-import.ts <path-to-csv> [--dry-run] [--no-download]
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
 * the Demozoo CSV doesn't have any.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function readCsv(path: string): CsvRow[] {
  const text = fs.readFileSync(path, 'utf-8');
  const raw = parseCsv(text);
  if (raw.length < 2) return [];
  const header = raw[0].map((h) => h.trim().toLowerCase());
  // Expect: demozoo url, title, by, release date, platform, download url
  const colIdx = (name: string): number => {
    const idx = header.findIndex((h) => h === name || h.replace(/\s+/g, '') === name.replace(/\s+/g, ''));
    if (idx === -1) throw new Error(`CSV missing column "${name}". Header was: ${header.join(', ')}`);
    return idx;
  };
  const urlCol = colIdx('demozoo url');
  const titleCol = colIdx('title');
  const byCol = colIdx('by');
  const dateCol = colIdx('release date');
  const platformCol = colIdx('platform');
  const dlCol = colIdx('download url');
  const rows: CsvRow[] = [];
  for (let i = 1; i < raw.length; i++) {
    const r = raw[i];
    rows.push({
      rowNum: i,
      demozooUrl: (r[urlCol] ?? '').trim(),
      title: (r[titleCol] ?? '').trim(),
      author: (r[byCol] ?? '').trim(),
      releaseDate: (r[dateCol] ?? '').trim(),
      platform: (r[platformCol] ?? '').trim(),
      downloadUrl: (r[dlCol] ?? '').trim(),
    });
  }
  return rows;
}

// ─── Filename extraction ─────────────────────────────────────────────────────

function filenameFromUrl(url: string): string | null {
  if (!url) return null;
  // Some CSV rows have multiple space-separated URLs. Take the LAST one
  // (typically scene.org, which is the most reliable mirror).
  const urls = url.split(/\s+/).filter(Boolean);
  const target = urls[urls.length - 1];
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

// ─── Download ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [2000, 8000, 30000];

function downloadToFile(rawUrl: string, destPath: string): Promise<{ size: number; md5: string; sha256: string }> {
  // scene.org serves the same content over HTTPS that the CSV lists as
  // FTP; rewrite ftp://scene.org to https:// to avoid needing an FTP
  // client. Other hosts (defacto2, aminet) are already HTTPS.
  const url = rawUrl.replace(/^ftp:\/\/ftp\.scene\.org\//i, 'https://ftp.scene.org/');
  return new Promise((resolve, reject) => {
    const doDownload = (attempt: number) => {
      const hashMd5 = crypto.createHash('md5');
      const hashSha256 = crypto.createHash('sha256');
      let size = 0;
      const get = url.startsWith('https:') ? https.get : http.get;
      const req = get(url, { headers: { 'User-Agent': 'AmiExpress-DoorServer/1.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          if (!loc) { reject(new Error('redirect without location')); return; }
          req.destroy();
          downloadToFile(new URL(loc, url).toString(), destPath).then(resolve, reject);
          return;
        }
        if (res.statusCode === 429 && attempt < MAX_RETRIES) {
          console.error(`[csv] 429, retry in ${RETRY_DELAYS_MS[attempt]}ms`);
          setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]);
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
        file.on('finish', () => { file.close(); resolve({ size, md5: hashMd5.digest('hex'), sha256: hashSha256.digest('hex') }); });
        file.on('error', reject);
      });
      req.on('error', (err) => {
        if (attempt < MAX_RETRIES) setTimeout(() => doDownload(attempt + 1), RETRY_DELAYS_MS[attempt]);
        else reject(err);
      });
    };
    doDownload(0);
  });
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
  dryRun: boolean,
): { changed: boolean; fields: string[] } {
  const patch: Record<string, string | null> = {};
  if (!existing.release_date && row.releaseDate) patch.release_date = row.releaseDate;
  if (!existing.platform && row.platform) patch.platform = row.platform;
  if (!existing.download_url && row.downloadUrl) patch.download_url = row.downloadUrl;
  if (!existing.author && row.author) patch.author = row.author;
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
  }
  return { changed: true, fields };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('usage: npx tsx scripts/demozoo-csv-import.ts <csv> [--dry-run] [--no-download]');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  const noDownload = process.argv.includes('--no-download');
  if (dryRun) console.error('[csv] DRY RUN — no DB writes, no downloads');
  if (noDownload) console.error('[csv] NO DOWNLOAD — Phase 2 skipped');

  const cfg = loadConfig();
  console.error(`[csv] db=${cfg.dbPath} archives=${cfg.archivesRoot}`);
  const db = new Database(cfg.dbPath);
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

  let backfilled = 0;
  let newDoors = 0;
  let skippedNoDownload = 0;
  let skippedNoFilename = 0;
  let errors = 0;
  let downloaded = 0;
  let downloadFails = 0;

  for (const row of rows) {
    if (importedRows.has(row.rowNum)) continue;

    const filename = filenameFromUrl(row.downloadUrl);
    if (!filename) {
      console.error(`[csv] row ${row.rowNum} "${row.title}" — no filename in URL, skipping`);
      skippedNoFilename++;
      continue;
    }

    const split = splitNameAndVersion(row.title, filename.replace(/\.(lha|lzx|lzh|zip|dms)$/i, ''));
    const lookup = filename.toLowerCase();
    const existing = archiveNameToDoor.get(lookup);

    if (existing) {
      const { changed, fields } = applyBackfill(db, existing, row, split, dryRun);
      if (changed) {
        console.error(`[csv] backfilled row ${row.rowNum} ${existing.archive_name} (${fields.join(', ')})`);
        backfilled++;
      }
      if (!dryRun) {
        try { db.prepare('INSERT OR IGNORE INTO demozoo_csv_imported (row_num, demozoo_url, archive_name) VALUES (?, ?, ?)').run(row.rowNum, row.demozooUrl, existing.archive_name); } catch {}
      }
      continue;
    }

    // No existing door — try to download and register.
    if (noDownload) {
      console.error(`[csv] row ${row.rowNum} "${row.title}" → ${row.downloadUrl} (would download)`);
      skippedNoDownload++;
      continue;
    }

    const destPath = path.join(submittedDir, filename);
    if (fs.existsSync(destPath)) {
      console.error(`[csv] row ${row.rowNum} "${filename}" already exists at ${destPath}, skipping download`);
      skippedNoDownload++;
      continue;
    }

    const tmpPath = path.join(submittedDir, `.tmp.${row.rowNum}.${filename}`);
    let dl: { size: number; md5: string; sha256: string };
    try {
      console.error(`[csv] downloading row ${row.rowNum} ${row.downloadUrl}`);
      dl = await downloadToFile(row.downloadUrl, tmpPath);
      downloaded++;
    } catch (e: any) {
      console.error(`[csv] download failed row ${row.rowNum} ${filename}: ${e.message}`);
      downloadFails++;
      errors++;
      continue;
    }

    fs.renameSync(tmpPath, destPath);

    if (dryRun) {
      console.error(`[csv] DRY: would INSERT ${filename} (${dl.size} bytes)`);
      newDoors++;
      try { db.prepare('INSERT OR IGNORE INTO demozoo_csv_imported (row_num, demozoo_url, archive_name) VALUES (?, ?, ?)').run(row.rowNum, row.demozooUrl, filename); } catch {}
      continue;
    }

    const catalogId = crypto.randomUUID();
    try {
      db.prepare(
        `INSERT INTO door_catalog
           (id, archive_name, archive_path, name, door_type, version, author,
            release_date, platform, download_url, demozoo_url, release_group,
            archive_size, md5, sha256, source, indexed_at)
         VALUES (?, ?, ?, ?, 'XIM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demozoo', strftime('%s','now'))`
      ).run(
        catalogId,
        filename,
        path.posix.join('Submitted', filename),
        split.name,
        split.version,
        row.author || null,
        row.releaseDate || null,
        row.platform || null,
        row.downloadUrl || null,
        row.demozooUrl || null,
        null,
        dl.size,
        dl.md5,
        dl.sha256,
      );
      db.prepare('INSERT OR IGNORE INTO demozoo_csv_imported (row_num, demozoo_url, archive_name) VALUES (?, ?, ?)').run(row.rowNum, row.demozooUrl, filename);
      console.error(`[csv] new door inserted row ${row.rowNum} ${filename} (${dl.size} bytes)`);
      newDoors++;
    } catch (e: any) {
      console.error(`[csv] INSERT failed row ${row.rowNum} ${filename}: ${e.message}`);
      errors++;
    }
  }

  console.error(`\n[csv] Done. backfilled=${backfilled} newDoors=${newDoors} downloaded=${downloaded} downloadFails=${downloadFails} skippedNoDownload=${skippedNoDownload} skippedNoFilename=${skippedNoFilename} errors=${errors}`);
  db.close();
}

main().catch((e) => {
  console.error('[csv] fatal:', e);
  process.exit(1);
});
