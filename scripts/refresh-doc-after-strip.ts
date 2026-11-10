#!/usr/bin/env npx tsx

/**
 * Retroactive fix for doors stripped before stripArchiveOnServer
 * (catalog.ts) re-derived file_id_diz/doc_filename/doc_raw after
 * deleting members. A stripped ad file that had been read as the
 * "documentation" left the catalog pointing at content that no longer
 * exists in the archive. Re-reads each already-stripped archive fresh
 * and refreshes those three columns from its current contents.
 *
 * Usage:
 *   npx tsx scripts/refresh-doc-after-strip.ts [--dry-run]
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { buildGroupTags } from '../src/describe';
import { deriveMetadata } from '../src/submissions';

function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.error('[refresh-doc] DRY RUN — no DB writes');

  const cfg = loadConfig();
  const db = new Database(cfg.dbPath);
  applySchema(db);
  runMigrations(db);

  const groupTags = buildGroupTags(
    (db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[]).map(
      (r) => r.archive_name
    )
  );

  const rows = db
    .prepare('SELECT id, archive_name, archive_path, doc_filename FROM door_catalog WHERE ads_stripped = 1')
    .all() as { id: string; archive_name: string; archive_path: string; doc_filename: string | null }[];
  console.error(`[refresh-doc] ${rows.length} already-stripped doors`);

  const update = db.prepare(
    `UPDATE door_catalog SET file_id_diz = ?, doc_filename = ?, doc_raw = ? WHERE id = ?`
  );

  let changed = 0, missing = 0, errors = 0;

  const tx = db.transaction(() => {
    for (const r of rows) {
      const absPath = path.join(cfg.archivesRoot, r.archive_path);
      if (!fs.existsSync(absPath)) { missing++; continue; }
      let derived;
      try {
        const bytes = fs.readFileSync(absPath);
        derived = deriveMetadata(bytes, r.archive_name, groupTags);
      } catch {
        errors++;
        continue;
      }
      const docChanged = derived.docFilename !== r.doc_filename;
      if (!docChanged) continue;
      if (!dryRun) update.run(derived.fileIdDiz, derived.docFilename, derived.doc, r.id);
      changed++;
    }
  });
  tx();

  console.error(`[refresh-doc] ${changed} rows ${dryRun ? 'would be' : ''} refreshed, ${missing} archive files missing, ${errors} read errors`);

  db.close();
}

main();
