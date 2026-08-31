#!/usr/bin/env npx tsx
/**
 * Fill door_catalog.release_group from demozoo.org's own author_nicks, for
 * rows that already carry a demozoo_url but were never run through
 * extractReleaseGroup (e.g. Submitted/Phantasm rows attached to demozoo via
 * a sync/backfill pass rather than a fresh import - see extractReleaseGroup
 * in src/demozoo-bbs.ts, which scripts/demozoo-import.ts already runs for
 * NEW imports). Mirrors scripts/backfill-requires-from-demozoo.ts exactly,
 * same rate-limit and CLI shape, different target field.
 *
 * Only ever fills a currently-empty release_group - never overwrites a
 * value that's already set (whether from a prior import or a curator
 * override sitting in door_catalog_overrides, which this never touches).
 *
 * Usage:
 *   npx tsx scripts/backfill-release-group-from-demozoo.ts [--dry-run] [--limit=N]
 */
import Database from 'better-sqlite3';
import * as https from 'https';
import { loadConfig } from '../src/config';
import { extractReleaseGroup, type DemozooAuthorNick } from '../src/demozoo-bbs';

interface DemozooDetail {
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
      WHERE (release_group IS NULL OR trim(release_group) = '')
        AND demozoo_url IS NOT NULL AND trim(demozoo_url) != ''
      ORDER BY id`
  )
  .all() as { id: string; archive_name: string; demozoo_url: string }[];

console.error(`[backfill-release-group] ${rows.length} candidates, processing up to ${Number.isFinite(limit) ? limit : 'all'}`);
if (dryRun) console.error('[backfill-release-group] DRY RUN - no writes');

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

const updateDoor = db.prepare('UPDATE door_catalog SET release_group = ? WHERE id = ?');
const upsertGroup = db.prepare(
  'INSERT INTO release_groups (abbreviation, full_name) VALUES (?, ?) ON CONFLICT(abbreviation) DO UPDATE SET full_name = excluded.full_name'
);

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
      const group = extractReleaseGroup(detail.author_nicks);
      if (group) {
        if (!dryRun) {
          upsertGroup.run(group.abbrev, group.fullName);
          updateDoor.run(group.abbrev, row.id);
        }
        filled++;
        byValue[group.abbrev] = (byValue[group.abbrev] || 0) + 1;
      } else {
        noSignal++;
      }
    } catch (e) {
      errors++;
      if (errors <= 10) console.error(`  [error] ${row.archive_name} (${row.demozoo_url}): ${(e as Error).message}`);
    }

    if ((i + 1) % 50 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      console.error(`[backfill-release-group] ${i + 1}/${toProcess.length} (${filled} filled, ${errors} errors, ${elapsed.toFixed(0)}s)`);
    }
    if (i < toProcess.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }

  console.error(`\n[backfill-release-group] done: ${checked} checked, ${filled} filled, ${noSignal} no signal, ${errors} errors`);
  console.error(byValue);
  db.close();
}

main();
