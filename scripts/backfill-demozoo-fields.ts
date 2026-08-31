#!/usr/bin/env npx tsx
/**
 * Fill door_catalog.release_group and door_catalog.category from
 * demozoo.org's own data, for rows that already carry a demozoo_url but
 * were never run through extractReleaseGroup/inferCategory (e.g.
 * Submitted/Phantasm rows attached to demozoo via a sync/backfill pass
 * rather than a fresh import - see src/demozoo-bbs.ts, which
 * scripts/demozoo-import.ts already runs for NEW imports). Mirrors
 * scripts/backfill-requires-from-demozoo.ts's rate-limit and CLI shape;
 * does both fields in one demozoo fetch per row rather than two separate
 * sweeps, since a fresh 1586-row sweep at demozoo's 1 req/sec limit is
 * ~30 minutes on its own.
 *
 * release_group: only fills a currently-empty value.
 * category: fills an empty value OR the literal placeholder "auto-added"
 * left by an earlier bulk-import pass, which was never a real category -
 * anything else already set (including a genuinely-curated category) is
 * left alone. Neither field is ever overwritten once set to something
 * real, and neither touches door_catalog_overrides - a curator's edit
 * there always wins at read time regardless of what this writes to the
 * raw column.
 *
 * Usage:
 *   npx tsx scripts/backfill-demozoo-fields.ts [--dry-run] [--limit=N]
 */
import Database from 'better-sqlite3';
import * as https from 'https';
import { loadConfig } from '../src/config';
import { extractReleaseGroup, inferCategory, type DemozooAuthorNick, type DemozooProductionType } from '../src/demozoo-bbs';

interface DemozooDetail {
  author_nicks?: DemozooAuthorNick[];
  types?: DemozooProductionType[];
}

const CATEGORY_PLACEHOLDER = 'auto-added';

const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : Infinity;

const cfg = loadConfig();
const db = new Database(cfg.dbPath);

const rows = db
  .prepare(
    `SELECT id, archive_name, demozoo_url, release_group, category FROM door_catalog
      WHERE demozoo_url IS NOT NULL AND trim(demozoo_url) != ''
        AND (
          (release_group IS NULL OR trim(release_group) = '')
          OR (category IS NULL OR trim(category) = '' OR category = '${CATEGORY_PLACEHOLDER}')
        )
      ORDER BY id`
  )
  .all() as { id: string; archive_name: string; demozoo_url: string; release_group: string | null; category: string | null }[];

console.error(`[backfill-demozoo-fields] ${rows.length} candidates, processing up to ${Number.isFinite(limit) ? limit : 'all'}`);
if (dryRun) console.error('[backfill-demozoo-fields] DRY RUN - no writes');

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

const updateReleaseGroup = db.prepare('UPDATE door_catalog SET release_group = ? WHERE id = ?');
const updateCategory = db.prepare('UPDATE door_catalog SET category = ? WHERE id = ?');
const upsertGroup = db.prepare(
  'INSERT INTO release_groups (abbreviation, full_name) VALUES (?, ?) ON CONFLICT(abbreviation) DO UPDATE SET full_name = excluded.full_name'
);

function needsReleaseGroup(row: { release_group: string | null }): boolean {
  return !row.release_group || row.release_group.trim() === '';
}
function needsCategory(row: { category: string | null }): boolean {
  return !row.category || row.category.trim() === '' || row.category === CATEGORY_PLACEHOLDER;
}

async function main(): Promise<void> {
  let checked = 0, groupsFilled = 0, categoriesFilled = 0, noSignal = 0, errors = 0;
  const byGroup: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
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
      let filledSomething = false;

      if (needsReleaseGroup(row)) {
        const group = extractReleaseGroup(detail.author_nicks);
        if (group) {
          if (!dryRun) {
            upsertGroup.run(group.abbrev, group.fullName);
            updateReleaseGroup.run(group.abbrev, row.id);
          }
          groupsFilled++;
          byGroup[group.abbrev] = (byGroup[group.abbrev] || 0) + 1;
          filledSomething = true;
        }
      }

      if (needsCategory(row)) {
        const category = inferCategory(detail.types);
        if (category) {
          if (!dryRun) updateCategory.run(category, row.id);
          categoriesFilled++;
          byCategory[category] = (byCategory[category] || 0) + 1;
          filledSomething = true;
        }
      }

      if (!filledSomething) noSignal++;
    } catch (e) {
      errors++;
      if (errors <= 10) console.error(`  [error] ${row.archive_name} (${row.demozoo_url}): ${(e as Error).message}`);
    }

    if ((i + 1) % 50 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      console.error(`[backfill-demozoo-fields] ${i + 1}/${toProcess.length} (${groupsFilled} groups, ${categoriesFilled} categories, ${errors} errors, ${elapsed.toFixed(0)}s)`);
    }
    if (i < toProcess.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }

  console.error(`\n[backfill-demozoo-fields] done: ${checked} checked, ${groupsFilled} groups filled, ${categoriesFilled} categories filled, ${noSignal} no signal at all, ${errors} errors`);
  console.error('by group:', byGroup);
  console.error('by category:', byCategory);
  db.close();
}

main();
