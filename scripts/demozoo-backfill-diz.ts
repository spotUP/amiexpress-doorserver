#!/usr/bin/env npx tsx

/**
 * Demozoo FILE_ID.DIZ backfill.
 *
 * The original CSV import did not extract FILE_ID.DIZ from the archive
 * itself — only what was in the CSV columns. This script walks every
 * demozoo_source row (and every backfilled scan row that came from the
 * CSV) whose archive is on disk and is missing file_id_diz, opens the
 * archive, extracts the DIZ, and writes it back to the DB.
 *
 * Idempotent: skips rows that already have a file_id_diz.
 *
 * Usage:
 *   npx tsx scripts/demozoo-backfill-diz.ts [--dry-run] [--verbose]
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { readLhaContents, readZipContents, readLzxContents, type ArchiveContents } from '../src/archive-reader';

function readContents(archivePath: string): ArchiveContents {
  const buf = fs.readFileSync(archivePath);
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === '.lha' || ext === '.lzh') return readLhaContents(buf, archivePath);
  if (ext === '.lzx') return readLzxContents(buf);
  if (ext === '.zip') return readZipContents(buf);
  return { files: [], fileIdDiz: null, docFilename: null, doc: null };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const verbose = process.argv.includes('--verbose');
  if (dryRun) console.error('[diz-backfill] DRY RUN — no DB writes');

  const cfg = loadConfig();
  const submittedDir = path.join(cfg.archivesRoot, 'Submitted');
  const db = new Database(cfg.dbPath);
  applySchema(db);
  runMigrations(db);

  // Rows to backfill: every demozoo row missing file_id_diz, plus
  // every scan row that was enriched by the demozoo CSV import but
  // never had its DIZ extracted (because the original import didn't
  // do that for backfilled rows).
  const rows = db.prepare(`
    SELECT id, archive_name
      FROM door_catalog
     WHERE (file_id_diz IS NULL OR file_id_diz = '')
       AND (
         source = 'demozoo'
         OR (source = 'scan' AND demozoo_url IS NOT NULL)
       )
  `).all() as { id: string; archive_name: string }[];

  console.error(`[diz-backfill] ${rows.length} candidate rows`);

  let updated = 0;
  let missing = 0;
  let noDiz = 0;
  let errors = 0;

  const updateStmt = db.prepare(
    `UPDATE door_catalog
        SET file_id_diz = ?,
            doc_filename = COALESCE(NULLIF(?, ''), doc_filename),
            doc_raw      = COALESCE(NULLIF(?, ''), doc_raw)
      WHERE id = ?`
  );
  const insertFileStmt = db.prepare(
    'INSERT OR IGNORE INTO door_catalog_files (catalog_id, path, size) VALUES (?, ?, ?)'
  );

  const start = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const p = path.join(submittedDir, r.archive_name);
    if (!fs.existsSync(p)) {
      missing++;
      if (verbose) console.error(`[diz-backfill] ${r.archive_name}: file missing at ${p}`);
      continue;
    }
    let contents: ArchiveContents;
    try {
      contents = readContents(p);
    } catch (e: any) {
      errors++;
      if (verbose) console.error(`[diz-backfill] ${r.archive_name}: read failed: ${e.message}`);
      continue;
    }
    if (!contents.fileIdDiz) {
      noDiz++;
      if (verbose) console.error(`[diz-backfill] ${r.archive_name}: no DIZ in archive`);
      continue;
    }
    if (dryRun) {
      updated++;
    } else {
      try {
        const tx = db.transaction(() => {
          updateStmt.run(
            contents.fileIdDiz,
            contents.docFilename,
            contents.doc,
            r.id,
          );
          for (const f of contents.files) {
            try { insertFileStmt.run(r.id, f.path, f.size); } catch {}
          }
        });
        tx();
        updated++;
      } catch (e: any) {
        errors++;
        if (verbose) console.error(`[diz-backfill] ${r.archive_name}: UPDATE failed: ${e.message}`);
      }
    }
    if (verbose) console.error(`[diz-backfill] ${r.archive_name}: ${contents.fileIdDiz.length} chars DIZ, ${contents.files.length} files`);
    if ((i + 1) % 100 === 0 || i === rows.length - 1) {
      const elapsed = (Date.now() - start) / 1000;
      const rate = (i + 1) / elapsed;
      const remaining = (rows.length - i - 1) / Math.max(rate, 0.001);
      process.stderr.write(
        `\r[diz-backfill] ${i + 1}/${rows.length} (${(rate * 60).toFixed(0)}/min, ~${Math.ceil(remaining / 60)} min left)   `,
      );
    }
  }
  process.stderr.write('\n');
  console.error(`[diz-backfill] done. updated=${updated} noDiz=${noDiz} missing=${missing} errors=${errors}`);
  db.close();
}

main().catch((e) => { console.error('[diz-backfill] fatal:', e); process.exit(1); });
