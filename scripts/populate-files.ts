#!/usr/bin/env npx tsx
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { readLhaContents, readZipContents, readLzxContents } from '../src/archive-reader';

const cfg = loadConfig();
const db = new Database(cfg.dbPath);
applySchema(db);
runMigrations(db);

const archiveRoot = cfg.archivesRoot;

const rows = db.prepare(`
  SELECT dc.id, dc.archive_name, dc.archive_path
    FROM door_catalog dc
   WHERE dc.archive_name IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM door_catalog_files dcf WHERE dcf.catalog_id = dc.id)
`).all() as { id: string; archive_name: string; archive_path: string }[];

console.error(`[populate-files] ${rows.length} doors with no file list`);

const ins = db.prepare(
  'INSERT OR IGNORE INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason) VALUES (?, ?, ?, 0, NULL)'
);

let totalInserted = 0;
let totalErrors = 0;
for (const r of rows) {
  const abs = path.join(archiveRoot, r.archive_path);
  if (!fs.existsSync(abs)) {
    totalErrors++;
    continue;
  }
  let files: { path: string; size: number }[];
  try {
    const ext = path.extname(abs).toLowerCase();
    const buf = fs.readFileSync(abs);
    if (ext === '.lha' || ext === '.lzh') files = readLhaContents(buf, abs).files;
    else if (ext === '.lzx') files = readLzxContents(buf).files;
    else if (ext === '.zip') files = readZipContents(buf).files;
    else { totalErrors++; continue; }
  } catch {
    totalErrors++;
    continue;
  }
  if (files.length === 0) continue;
  const tx = db.transaction(() => {
    for (const f of files) ins.run(r.id, f.path, f.size);
  });
  tx();
  totalInserted += files.length;
}
console.error(`[populate-files] done. Inserted ${totalInserted} entries across ${rows.length} doors. ${totalErrors} errors.`);
db.close();
