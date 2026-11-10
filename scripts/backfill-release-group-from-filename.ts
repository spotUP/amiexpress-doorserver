#!/usr/bin/env npx tsx

/**
 * Fill door_catalog.release_group from the archive filename for rows
 * where it's still unset.
 *
 * Reuses the exact GROUP_TAG_RE already trusted by demozoo-backfill.ts
 * and demozoo-csv-import.ts for the 4417 rows that already have a
 * release_group: a 1-5 char prefix followed by a separator
 * (TBF-IMMU.lha -> TBF). Only applies the tag when it's a known
 * abbreviation in release_groups — never invents a new group. This is
 * intentionally conservative: filenames that pack the group tag
 * directly against the content word with no separator (e.g.
 * FOODCHAT.zip, TOPBOZ.LHA) are NOT matched here, because a blind
 * whitelist-prefix scan collides badly with generic English-word
 * filenames (FILE, TOP, TEL, CAL, PRO, SUP, JOIN are all real table
 * entries that are ALSO common word prefixes for non-group utilities).
 * That case needs a human, not a regex — left for manual review.
 *
 * Idempotent: only touches rows where release_group IS NULL/''.
 *
 * Usage:
 *   npx tsx scripts/backfill-release-group-from-filename.ts [--dry-run]
 */

import Database from 'better-sqlite3';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';

const GROUP_TAG_RE = /^([A-Za-z0-9!$^&]{1,5})[-_^!.]/;

function releaseGroupFromFilename(archiveName: string): string | null {
  const m = GROUP_TAG_RE.exec(archiveName);
  if (!m) return null;
  return m[1].toUpperCase();
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.error('[backfill-group] DRY RUN — no DB writes');

  const cfg = loadConfig();
  const db = new Database(cfg.dbPath);
  applySchema(db);
  runMigrations(db);

  const known = new Set(
    (db.prepare('SELECT abbreviation FROM release_groups').all() as { abbreviation: string }[])
      .map((r) => r.abbreviation)
  );
  console.error(`[backfill-group] ${known.size} known group abbreviations`);

  const rows = db
    .prepare(`SELECT id, archive_name FROM door_catalog WHERE release_group IS NULL OR release_group = ''`)
    .all() as { id: string; archive_name: string }[];
  console.error(`[backfill-group] ${rows.length} candidate rows`);

  const updateStmt = db.prepare('UPDATE door_catalog SET release_group = ? WHERE id = ?');
  const byTag = new Map<string, number>();
  let updated = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      const tag = releaseGroupFromFilename(r.archive_name);
      if (!tag || !known.has(tag)) continue;
      if (!dryRun) updateStmt.run(tag, r.id);
      byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
      updated++;
    }
  });
  tx();

  console.error(`[backfill-group] ${updated} rows ${dryRun ? 'would be' : ''} updated across ${byTag.size} groups`);
  for (const [tag, count] of [...byTag.entries()].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${tag}: ${count}`);
  }

  db.close();
}

main();
