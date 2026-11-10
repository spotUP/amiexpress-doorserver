#!/usr/bin/env npx tsx

/**
 * Fetch `author_nicks` from the demozoo.org API for every demozoo
 * door and write the canonical release group (short tag + full name)
 * into `door_catalog.api_release_group` / `api_release_group_full`.
 * Also reconcile `release_group` when the API's group disagrees with
 * the current tag (which usually came from the filename).
 *
 * The demozoo.org rate limit is 1 req/sec. With ~1456 demozoo
 * doors, this takes ~25 minutes.
 *
 * Usage:
 *   npx tsx scripts/fetch-api-groups.ts            # write
 *   npx tsx scripts/fetch-api-groups.ts --dry-run # report only
 *   npx tsx scripts/fetch-api-groups.ts --ids=...   # subset
 */

import Database from 'better-sqlite3';
import * as https from 'https';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';

interface DemozooAuthorNick {
  name: string;
  abbreviation: string;
  releaser: { id: number; name: string; is_group: boolean };
}

interface DemozooDetail {
  author_nicks?: DemozooAuthorNick[];
}

const dryRun = process.argv.includes('--dry-run');
const idsArg = process.argv.find((a) => a.startsWith('--ids='));
const limitIds = idsArg ? new Set(
  idsArg.slice('--ids='.length).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n))
) : null;

if (dryRun) console.error('[fetch-api-groups] DRY RUN — no writes');

const cfg = loadConfig();
const db = new Database(cfg.dbPath);
applySchema(db);
runMigrations(db);

let idsToFetch: { id: string; demozoo_url: string }[];
if (limitIds) {
  // Filter the full list in JS to keep the SQL simple.
  const all = db.prepare(`
    SELECT id, demozoo_url
      FROM door_catalog
     WHERE source='demozoo' AND demozoo_url IS NOT NULL
  `).all() as { id: string; demozoo_url: string }[];
  const allowed = new Set(limitIds);
  idsToFetch = all.filter((r) => {
    const m = /\/productions\/(\d+)\/?/.exec(r.demozoo_url);
    return m ? allowed.has(Number(m[1])) : false;
  });
} else {
  idsToFetch = db.prepare(`
    SELECT id, demozoo_url
      FROM door_catalog
     WHERE source='demozoo' AND demozoo_url IS NOT NULL
  `).all() as { id: string; demozoo_url: string }[];
}

console.error(`[fetch-api-groups] ${idsToFetch.length} doors to fetch`);

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'AmiExpress-DoorServer/1.0' },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
        } catch (e) {
          reject(e as Error);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

const updateStmt = db.prepare(`
  UPDATE door_catalog
     SET api_release_group = ?,
         api_release_group_full = ?
   WHERE id = ?
`);

const releaseGroupFix = db.prepare(`
  UPDATE door_catalog
     SET release_group = ?
   WHERE id = ?
     AND api_release_group IS NOT NULL
     AND release_group != api_release_group
`);

let fetched = 0;
let changed = 0;
let groupFixes = 0;
let errors = 0;
const start = Date.now();

async function main() {
for (let i = 0; i < idsToFetch.length; i++) {
  const row = idsToFetch[i];
  const m = /\/productions\/(\d+)\/?/.exec(row.demozoo_url);
  if (!m) continue;
  const prodId = Number(m[1]);
  try {
    const detail = await fetchJson<DemozooDetail>(`https://demozoo.org/api/v1/productions/${prodId}/?format=json`);
    const groupNick = (detail.author_nicks ?? []).find((n) => n.releaser?.is_group);
    if (groupNick) {
      if (!dryRun) {
        updateStmt.run(groupNick.abbreviation || null, groupNick.releaser.name, row.id);
        const fixResult = releaseGroupFix.run(groupNick.abbreviation, row.id);
        if (fixResult.changes > 0) groupFixes++;
      }
      changed++;
    }
  } catch (e) {
    errors++;
    if (errors < 5) console.error(`  [error] ${row.demozoo_url}: ${(e as Error).message}`);
  }
  fetched++;
  // Honor demozoo's 1 req/sec limit
  if (i < idsToFetch.length - 1) await new Promise((r) => setTimeout(r, 1100));
  if (fetched % 50 === 0 || fetched === idsToFetch.length) {
    const elapsed = (Date.now() - start) / 1000;
    const rate = fetched / elapsed;
    const remaining = (idsToFetch.length - fetched) / Math.max(rate, 0.001);
    process.stderr.write(
      `\r[fetch-api-groups] ${fetched}/${idsToFetch.length} (${(rate * 60).toFixed(0)}/min, ~${Math.ceil(remaining / 60)} min left, errors=${errors}, groupFixes=${groupFixes})   `,
    );
  }
}
process.stderr.write('\n');
console.error(`[fetch-api-groups] done. fetched=${fetched} updated=${changed} releaseGroupFixes=${groupFixes} errors=${errors}`);
db.close();
}

main().catch((e) => { console.error('[fetch-api-groups] fatal:', e); process.exit(1); });
