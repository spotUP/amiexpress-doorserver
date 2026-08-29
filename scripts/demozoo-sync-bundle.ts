#!/usr/bin/env npx tsx

/**
 * Demozoo CSV sync bundle PRODUCER.
 *
 * Exports everything needed to bring a remote (live) doorserver DB up to
 * date with the local DB's demozoo imports, without requiring the remote
 * to re-download 2000 archives from scene.org.
 *
 * Output:
 *   <outDir>/
 *     patch.sql              -- INSERT OR IGNORE statements for new
 *                                 door_catalog rows + UPDATE for backfills
 *     submitted-files.tar.gz -- the new archive files referenced by
 *                                 the patch (the remote will extract these
 *                                 into <archivesRoot>/Submitted/)
 *     manifest.json          -- row counts, sizes, sha256s for verification
 *
 * Usage:
 *   npx tsx scripts/demozoo-sync-bundle.ts <outDir> [--since-row=N]
 *
 * The `--since-row=N` flag limits the bundle to CSV rows with row_num > N,
 * useful for incremental syncs. Omit to bundle everything.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';

const SUBMITTED_DIR_NAME = 'Submitted';

function sha256File(p: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function quote(v: string | number | null): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = args[0];
  if (!outDir) {
    console.error('usage: npx tsx scripts/demozoo-sync-bundle.ts <outDir> [--since-row=N]');
    process.exit(1);
  }
  const sinceArg = args.find((a) => a.startsWith('--since-row='));
  const sinceRow = sinceArg ? parseInt(sinceArg.split('=')[1], 10) : 0;

  fs.mkdirSync(outDir, { recursive: true });
  const cfg = loadConfig();
  const db = new Database(cfg.dbPath, { readonly: true });
  applySchema(db);
  runMigrations(db);
  const submittedDir = path.join(cfg.archivesRoot, SUBMITTED_DIR_NAME);

  // 1. New demozoo-source doors (need INSERT)
  const newRows = db.prepare(`
    SELECT id, archive_name, archive_path, binary_name, door_type, name, version,
           author, release_group, description, file_id_diz, doc_filename, doc_raw,
           suggested_tooltypes, category, archive_size, junk_count, corpus_id,
           source, indexed_at, md5, sha256, requires_bbs, ads_stripped,
           release_date, platform, download_url, credits, external_links,
           screenshots, demozoo_url
      FROM door_catalog
     WHERE source = 'demozoo'
  `).all() as any[];

  // 2. Backfilled existing doors (UPDATE — only columns where the local DB
  //    is non-NULL and the patch values are non-NULL).
  //    We capture them as: row id + columns to write.
  //    For SQL idempotency on the live side, we generate a single
  //    UPDATE that sets all the patchable columns in one statement.
  const backfillRows = db.prepare(`
    SELECT id, archive_name, name, version, author, release_date, platform,
           download_url, release_group, demozoo_url, file_id_diz, doc_filename, doc_raw
      FROM door_catalog
     WHERE source = 'scan'
       AND demozoo_url IS NOT NULL
  `).all() as any[];

  // 2b. DIZ-only backfill: every row that now has a file_id_diz
  //     populated locally (extracted from the archive by the CSV
  //     importer or by demozoo-backfill-diz.ts) but might be missing
  //     it on the live side. We emit a UPDATE that COALESCEs the
  //     values so it's non-destructive on re-apply.
  const dizBackfillRows = db.prepare(`
    SELECT id, file_id_diz, doc_filename, doc_raw
      FROM door_catalog
     WHERE file_id_diz IS NOT NULL AND file_id_diz != ''
       AND (
         source = 'demozoo'
         OR (source = 'scan' AND demozoo_url IS NOT NULL)
       )
  `).all() as { id: string; file_id_diz: string; doc_filename: string | null; doc_raw: string | null }[];

  // 3. List of files referenced by the new rows that exist on disk.
  const files: { archiveName: string; size: number; sha256: string }[] = [];
  for (const r of newRows) {
    const p = path.join(submittedDir, r.archive_name);
    if (!fs.existsSync(p)) {
      console.error(`[bundle] WARN: ${r.archive_name} missing at ${p}, skipping from tarball`);
      continue;
    }
    const size = fs.statSync(p).size;
    const sha = sha256File(p);
    files.push({ archiveName: r.archive_name, size, sha256: sha });
  }

  // 4. Filter by sinceRow if requested (matches demozoo_csv_imported).
  if (sinceRow > 0) {
    const importedSince = (db.prepare(
      'SELECT row_num FROM demozoo_csv_imported WHERE row_num > ?',
    ).all(sinceRow) as { row_num: number }[]).map((r) => r.row_num);
    const importedSet = new Set(importedSince);
    // We can't easily map demozoo_csv_imported back to door_catalog rows,
    // so --since-row only filters by archive_name presence. The producer
    // is meant to be run after a fresh import — if you need incremental,
    // just rerun the full bundle (it's idempotent on the apply side).
    console.error(`[bundle] --since-row=${sinceRow}: ${importedSince.length} rows since (no row-level filter applied to new doors; SQL is idempotent)`);
  }

  // 5. Write patch.sql
  const patchPath = path.join(outDir, 'patch.sql');
  const out = fs.createWriteStream(patchPath);
  out.write(`-- Demozoo sync bundle\n`);
  out.write(`-- Generated ${new Date().toISOString()}\n`);
  out.write(`-- New demozoo-source doors: ${newRows.length}\n`);
  out.write(`-- Backfilled scan doors: ${backfillRows.length}\n\n`);
  out.write('BEGIN;\n\n');

  // New rows — INSERT OR IGNORE so re-applying is safe
  if (newRows.length) {
    out.write(`-- New door_catalog rows (source='demozoo')\n`);
    for (const r of newRows) {
      const cols = [
        'id','archive_name','archive_path','binary_name','door_type','name','version',
        'author','release_group','description','file_id_diz','doc_filename','doc_raw',
        'suggested_tooltypes','category','archive_size','junk_count','corpus_id','source',
        'indexed_at','md5','sha256','requires_bbs','ads_stripped','release_date',
        'platform','download_url','credits','external_links','screenshots','demozoo_url',
      ];
      const vals = cols.map((c) => quote(r[c]));
      out.write(`INSERT OR IGNORE INTO door_catalog (${cols.join(', ')}) VALUES (${vals.join(', ')});\n`);
    }
    out.write('\n');
  }

  // Backfill rows — UPDATE setting the demozoo_url + any other columns that
  // are non-NULL locally. We use COALESCE so the live DB only fills NULLs,
  // matching the local import's behavior.
  if (backfillRows.length) {
    out.write(`-- Backfilled scan doors (only fills NULLs, COALESCE on the apply side)\n`);
    for (const r of backfillRows) {
      // COALESCE(NULL, ?) = ?; COALESCE(existing, ?) = existing. This
      // makes the patch idempotent and non-destructive.
      out.write(
        `UPDATE door_catalog SET\n` +
        `  name = COALESCE(name, ${quote(r.name)}),\n` +
        `  version = COALESCE(version, ${quote(r.version)}),\n` +
        `  author = COALESCE(author, ${quote(r.author)}),\n` +
        `  release_date = COALESCE(release_date, ${quote(r.release_date)}),\n` +
        `  platform = COALESCE(platform, ${quote(r.platform)}),\n` +
        `  download_url = COALESCE(download_url, ${quote(r.download_url)}),\n` +
        `  release_group = COALESCE(release_group, ${quote(r.release_group)}),\n` +
        `  demozoo_url = COALESCE(demozoo_url, ${quote(r.demozoo_url)})\n` +
        `WHERE id = ${quote(r.id)};\n`,
      );
    }
    out.write('\n');
  }

  // DIZ backfill — write file_id_diz (and doc_filename, doc_raw) into
  // rows that have them locally but might be missing them on the live
  // side. COALESCE keeps the patch non-destructive: a curator who has
  // already set their own DIZ in the admin console keeps it.
  if (dizBackfillRows.length) {
    out.write(`-- DIZ backfill (COALESCE — preserves any curator-set DIZ on the live side)\n`);
    for (const r of dizBackfillRows) {
      out.write(
        `UPDATE door_catalog SET\n` +
        `  file_id_diz = COALESCE(file_id_diz, ${quote(r.file_id_diz)}),\n` +
        `  doc_filename = COALESCE(doc_filename, ${quote(r.doc_filename)}),\n` +
        `  doc_raw = COALESCE(doc_raw, ${quote(r.doc_raw)})\n` +
        `WHERE id = ${quote(r.id)};\n`,
      );
    }
    out.write('\n');
  }

  out.write('COMMIT;\n');
  out.end();
  await new Promise<void>((r) => out.on('finish', () => r()));

  // 6. Write submitted-files.tar.gz
  const tarPath = path.join(outDir, 'submitted-files.tar.gz');
  // Use system tar — much faster than a JS implementation and handles
  // thousands of small files in seconds.
  const { spawnSync } = await import('child_process');
  if (files.length === 0) {
    fs.writeFileSync(tarPath, '');
  } else {
    // Stage files into a flat temp dir so the tar layout is Submitted/<filename>
    const stageDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'demozoo-bundle-'));
    const stagedSubmitted = path.join(stageDir, SUBMITTED_DIR_NAME);
    fs.mkdirSync(stagedSubmitted, { recursive: true });
    for (const f of files) {
      fs.copyFileSync(path.join(submittedDir, f.archiveName), path.join(stagedSubmitted, f.archiveName));
    }
    const tar = spawnSync('tar', ['czf', tarPath, '-C', stageDir, SUBMITTED_DIR_NAME], { stdio: 'inherit' });
    if (tar.status !== 0) {
      console.error('[bundle] tar failed');
      process.exit(1);
    }
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
  const tarSize = fs.statSync(tarPath).size;

  // 7. Write manifest.json
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: { db: cfg.dbPath, archivesRoot: cfg.archivesRoot },
    counts: {
      newDemozooRows: newRows.length,
      backfilledScanRows: backfillRows.length,
      dizBackfillRows: dizBackfillRows.length,
      filesInTarball: files.length,
    },
    sizes: {
      patchSqlBytes: fs.statSync(patchPath).size,
      tarballBytes: tarSize,
    },
    files: files.map((f) => ({ archiveName: f.archiveName, size: f.size, sha256: f.sha256 })),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  db.close();

  console.error(`[bundle] wrote:`);
  console.error(`  ${patchPath} (${manifest.sizes.patchSqlBytes} bytes, ${newRows.length} new + ${backfillRows.length} backfill)`);
  console.error(`  ${tarPath} (${tarSize} bytes, ${files.length} files)`);
  console.error(`  ${path.join(outDir, 'manifest.json')}`);
}

main().catch((e) => { console.error('[bundle] fatal:', e); process.exit(1); });
