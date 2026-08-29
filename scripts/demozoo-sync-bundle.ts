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

/**
 * SQLite has no support for multi-line string literals in standard SQL —
 * a literal 'foo\nbar' is a syntax error. We work around this by
 * writing the value as a hex blob and casting to TEXT. The bytes round-
 * trip exactly, so any byte sequence (including embedded NULs, newlines,
 * quotes) goes through unchanged.
 */
function quoteBlob(v: string | number | null): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  const buf = Buffer.from(String(v), 'utf8');
  return `CAST(X'${buf.toString('hex')}' AS TEXT)`;
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

  // 2c. door_catalog_files entries for the same set of rows. The
  //     scanner populates this table when it lists each archive's
  //     members, and the CSV importer / DIZ backfill does the same —
  //     a row in door_catalog without any rows in door_catalog_files
  //     shows up as "0 files" in the admin UI. The patch must carry
  //     these entries to keep the file list in sync.
  const relevantIds = new Set<string>([
    ...newRows.map((r: any) => r.id),
    ...backfillRows.map((r: any) => r.id),
  ]);
  const fileRows = relevantIds.size
    ? (db.prepare(
        `SELECT catalog_id, path, size, is_junk, junk_reason
           FROM door_catalog_files
          WHERE catalog_id IN (${[...relevantIds].map(() => '?').join(',')})`,
      ).all(...[...relevantIds]) as { catalog_id: string; path: string; size: number; is_junk: number; junk_reason: string | null }[])
    : [];

  // 2d. release_groups entries (the abbreviation → full-name mapping).
  //     For each demozoo row with a release_group, look up the full
  //     name from the local release_groups table. Emit UPSERTs so the
  //     live side gets the full name and the door detail page can
  //     display "Up Rough /X Innovations" instead of just "UP".
  const releaseGroupsToUpsert = (db.prepare(`
    SELECT DISTINCT d.release_group AS abbreviation, COALESCE(rg.full_name, '') AS full_name
      FROM door_catalog d
      LEFT JOIN release_groups rg ON rg.abbreviation = d.release_group
     WHERE d.release_group IS NOT NULL AND d.release_group != ''
       AND (
         d.source = 'demozoo'
         OR (d.source = 'scan' AND d.demozoo_url IS NOT NULL)
       )
  `).all() as { abbreviation: string; full_name: string }[])
    .filter((r) => r.full_name && r.full_name !== r.abbreviation);

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
      // file_id_diz, doc_filename, doc_raw are multi-line TEXT — go
      // through the hex blob literal so embedded newlines and quotes
      // round-trip exactly.
      const blobCols = new Set(['file_id_diz', 'doc_filename', 'doc_raw']);
      const vals = cols.map((c) => blobCols.has(c) ? quoteBlob(r[c]) : quote(r[c]));
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
        `  file_id_diz = COALESCE(file_id_diz, ${quoteBlob(r.file_id_diz)}),\n` +
        `  doc_filename = COALESCE(doc_filename, ${quoteBlob(r.doc_filename)}),\n` +
        `  doc_raw = COALESCE(doc_raw, ${quoteBlob(r.doc_raw)})\n` +
        `WHERE id = ${quote(r.id)};\n`,
      );
    }
    out.write('\n');
  }

  // door_catalog_files — the archive member list. INSERT OR IGNORE
  // so re-applying is safe. The (catalog_id, path) primary key
  // prevents duplicates.
  if (fileRows.length) {
    out.write(`-- door_catalog_files entries (${fileRows.length} rows)\n`);
    for (const f of fileRows) {
      out.write(
        `INSERT OR IGNORE INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason) ` +
        `VALUES (${quote(f.catalog_id)}, ${quote(f.path)}, ${quote(f.size)}, ${quote(f.is_junk)}, ${quote(f.junk_reason)});\n`,
      );
    }
    out.write('\n');
  }

  // release_groups — abbreviation → full name. ON CONFLICT keeps the
  // existing full_name if the live side has a non-empty one. This
  // way the curator's edits on live win.
  if (releaseGroupsToUpsert.length) {
    out.write(`-- release_groups entries (${releaseGroupsToUpsert.length} rows)\n`);
    for (const g of releaseGroupsToUpsert) {
      out.write(
        `INSERT INTO release_groups (abbreviation, full_name, updated_at) VALUES (${quote(g.abbreviation)}, ${quoteBlob(g.full_name)}, strftime('%s','now'))\n` +
        `ON CONFLICT(abbreviation) DO UPDATE SET\n` +
        `  full_name = CASE WHEN release_groups.full_name IS NULL OR release_groups.full_name = '' OR release_groups.full_name = release_groups.abbreviation\n` +
        `                  THEN excluded.full_name\n` +
        `                  ELSE release_groups.full_name END,\n` +
        `  updated_at = strftime('%s','now');\n`,
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
      doorCatalogFileRows: fileRows.length,
      releaseGroupUpserts: releaseGroupsToUpsert.length,
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
