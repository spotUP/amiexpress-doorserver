#!/usr/bin/env npx tsx
/**
 * Repack existing LZX archives in the repository to LHA format.
 *
 * Usage:
 *   npx tsx scripts/repack-lzx-archives.ts [--apply]
 *
 * Without --apply, shows what would be changed.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config';
import { repackLzxToLha } from '../src/repack-lzx';

const cfg = loadConfig(process.env);
const db = new Database(cfg.dbPath, { readonly: true });

const apply = process.argv.includes('--apply');

// Find all LZX archives in the catalog
const rows = db.prepare(
  "SELECT id, archive_name, archive_path FROM door_catalog WHERE LOWER(archive_name) LIKE '%.lzx'"
).all() as { id: string; archive_name: string; archive_path: string }[];

console.log(`Found ${rows.length} LZX archives in catalog`);
db.close();

if (rows.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

for (const row of rows) {
  const absPath = path.join(cfg.archivesRoot, row.archive_path);
  const exists = fs.existsSync(absPath);
  console.log(`\n${row.archive_name}`);
  console.log(`  path: ${row.archive_path}`);
  console.log(`  exists: ${exists}`);

  if (!exists) {
    console.log('  SKIP — file not found');
    continue;
  }

  if (!apply) {
    console.log('  would repack → LHA');
    continue;
  }

  console.log('  repacking...');
  const result = repackLzxToLha(absPath);
  if (!result.ok) {
    console.log(`  FAILED: ${result.error}`);
    continue;
  }
  console.log(`  → ${path.basename(result.outputPath!)}`);

  // Replace original with LHA, remove original
  fs.unlinkSync(absPath);
  console.log(`  removed original ${row.archive_name}`);

  // Update database
  const updateDb = new Database(cfg.dbPath);
  const newArchiveName = row.archive_name.replace(/\.lzx$/i, '.lha');
  const newRelativePath = row.archive_path.replace(/\.lzx$/i, '.lha');
  const newPath = path.join(cfg.archivesRoot, newRelativePath);

  // Move the repacked file if it ended up in a different location
  if (result.outputPath! !== newPath) {
    fs.copyFileSync(result.outputPath!, newPath);
    fs.unlinkSync(result.outputPath!);
  }

  updateDb.prepare('UPDATE door_catalog SET archive_name = ?, archive_path = ? WHERE id = ?')
    .run(newArchiveName, newRelativePath, row.id);
  updateDb.close();
  console.log(`  database updated → ${newArchiveName}`);
}

console.log('\nDone. Run a re-index to refresh metadata for repacked archives.');
