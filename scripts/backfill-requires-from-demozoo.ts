#!/usr/bin/env npx tsx
/**
 * Fill door_catalog.requires_bbs from demozoo.org's own tags and
 * release-group name, for rows that already carry a demozoo_url but were
 * never run through this inference (e.g. Submitted/Phantasm rows attached
 * to demozoo via a sync/backfill pass rather than a fresh import - see
 * inferRequiresBbs in src/demozoo-bbs.ts, which scripts/demozoo-import.ts
 * already runs for NEW imports).
 *
 * Demozoo's rate limit is 1 request/sec; this fetches serially with a
 * 1.1s pause between requests, same as scripts/fetch-api-groups.ts.
 *
 * Usage:
 *   npx tsx scripts/backfill-requires-from-demozoo.ts [--dry-run] [--limit=N]
 */
import Database from 'better-sqlite3';
import * as https from 'https';
import { loadConfig } from '../src/config';
import { inferRequiresBbs } from '../src/demozoo-bbs';

interface DemozooAuthorNick {
  releaser: { name: string; is_group: boolean };
}
interface DemozooDetail {
  tags?: string[];
  author_nicks?: DemozooAuthorNick[];
}

const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity;

const cfg = loadConfig();
const db = new Database(cfg.dbPath);

const rows = db
  .prepare(
    `SELECT id, archive_name, demozoo_url FROM door_catalog
      WHERE (requires_bbs IS NULL OR trim(requires_bbs) = '')
        AND demozoo_url IS NOT NULL AND trim(demozoo_url) != ''
      ORDER BY id`
  )
  .all() as { id: string; archive_name: string; demozoo_url: string }[];

console.error(`[backfill-demozoo-bbs] ${rows.length} candidates, processing up to ${Number.isFinite(limit) ? limit : 'all'}`);
if (dryRun) console.error('[backfill-demozoo-bbs] DRY RUN - no writes');

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'AmiExpress-DoorServer/1.0' } }, (res) => {
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

const update = db.prepare('UPDATE door_catalog SET requires_bbs = ? WHERE id = ?');

async function main(): Promise<void> {
  let checked = 0, filled = 0, noSignal = 0, errors = 0;
  const byValue: Record<string, number> = {};
  const start = Date.now();

  const toProcess = rows.slice(0, Number.isFinite(limit) ? limit : rows.length);
  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i];
    const m = /\/productions\/(\d+)\/?/.exec(row.demozoo_url);
    if (!m) continue;
    const prodId = Number(m[1]);
    checked++;

    try {
      const detail = await fetchJson<DemozooDetail>(`https://demozoo.org/api/v1/productions/${prodId}/?format=json`);
      const groupName = detail.author_nicks?.find((n) => n.releaser?.is_group)?.releaser.name ?? '';
      const value = inferRequiresBbs(detail.tags ?? [], groupName);
      if (value) {
        if (!dryRun) update.run(value, row.id);
        filled++;
        byValue[value] = (byValue[value] || 0) + 1;
      } else {
        noSignal++;
      }
    } catch (e) {
      errors++;
      if (errors <= 10) console.error(`  [error] ${row.archive_name} (${row.demozoo_url}): ${(e as Error).message}`);
    }

    if ((i + 1) % 50 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      console.error(`[backfill-demozoo-bbs] ${i + 1}/${toProcess.length} (${filled} filled, ${errors} errors, ${elapsed.toFixed(0)}s)`);
    }
    if (i < toProcess.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }

  console.error(`\n[backfill-demozoo-bbs] done: ${checked} checked, ${filled} filled, ${noSignal} no signal, ${errors} errors`);
  console.error(byValue);
  db.close();
}

main();
