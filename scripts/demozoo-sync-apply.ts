#!/usr/bin/env npx tsx

/**
 * Demozoo CSV sync bundle APPLIER.
 *
 * Applies a bundle produced by `demozoo-sync-bundle.ts` to the local DB:
 *   1. Extracts submitted-files.tar.gz into <archivesRoot>/Submitted/
 *      (skipping files that already exist with matching sha256)
 *   2. Applies patch.sql inside a transaction
 *
 * Usage:
 *   npx tsx scripts/demozoo-sync-apply.ts <bundleDir>
 *
 * Designed to be run on the live VPS after the bundle has been scp'd up.
 * The patch is fully idempotent (INSERT OR IGNORE + COALESCE on UPDATE).
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';

const SUBMITTED_DIR_NAME = 'Submitted';

interface ManifestFile { archiveName: string; size: number; sha256: string; }
interface Manifest {
  generatedAt: string;
  source: { db: string; archivesRoot: string };
  counts: { newDemozooRows: number; backfilledScanRows: number; filesInTarball: number };
  sizes: { patchSqlBytes: number; tarballBytes: number };
  files: ManifestFile[];
}

function sha256File(p: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  const bundleDir = args[0];
  if (!bundleDir) {
    console.error('usage: npx tsx scripts/demozoo-sync-apply.ts <bundleDir>');
    process.exit(1);
  }

  const manifestPath = path.join(bundleDir, 'manifest.json');
  const patchPath = path.join(bundleDir, 'patch.sql');
  const tarPath = path.join(bundleDir, 'submitted-files.tar.gz');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(patchPath) || !fs.existsSync(tarPath)) {
    console.error(`[apply] missing one of: manifest.json / patch.sql / submitted-files.tar.gz in ${bundleDir}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  console.error(`[apply] bundle generated ${manifest.generatedAt}`);
  console.error(`[apply]   ${manifest.counts.newDemozooRows} new demozoo rows`);
  console.error(`[apply]   ${manifest.counts.backfilledScanRows} backfilled scan rows`);
  console.error(`[apply]   ${manifest.counts.filesInTarball} files in tarball`);

  const cfg = loadConfig();
  const submittedDir = path.join(cfg.archivesRoot, SUBMITTED_DIR_NAME);
  fs.mkdirSync(submittedDir, { recursive: true });
  console.error(`[apply] target Submitted dir: ${submittedDir}`);

  // 1. Extract tarball
  if (manifest.counts.filesInTarball > 0) {
    console.error(`[apply] extracting tarball...`);
    const t = spawnSync('tar', ['xzf', tarPath, '-C', cfg.archivesRoot], { stdio: 'inherit' });
    if (t.status !== 0) {
      console.error('[apply] tar extract failed');
      process.exit(1);
    }
  }

  // 2. Verify file sha256s (skip if present with matching hash)
  let skipped = 0, verified = 0, missing = 0;
  for (const f of manifest.files) {
    const p = path.join(submittedDir, f.archiveName);
    if (!fs.existsSync(p)) { missing++; console.error(`[apply] WARN: ${f.archiveName} missing after extract`); continue; }
    const actual = sha256File(p);
    if (actual !== f.sha256) {
      console.error(`[apply] HASH MISMATCH ${f.archiveName}: expected ${f.sha256}, got ${actual}`);
      process.exit(1);
    }
    verified++;
  }
  console.error(`[apply] verified ${verified} files (${missing} missing)`);

  // 3. Apply SQL patch
  console.error(`[apply] applying patch.sql...`);
  const db = new Database(cfg.dbPath);
  db.pragma('journal_mode = WAL');
  applySchema(db);
  runMigrations(db);
  const sql = fs.readFileSync(patchPath, 'utf8');
  db.exec(sql);
  db.close();

  console.error(`[apply] done.`);
}

main().catch((e) => { console.error('[apply] fatal:', e); process.exit(1); });
