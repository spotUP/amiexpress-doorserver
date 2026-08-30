#!/usr/bin/env npx tsx

/**
 * Apply a round of DIZ-extraction results (name/description/version/
 * author/releaseGroup/requiresBbs) as door_catalog_overrides, exactly
 * the same INSERT...ON CONFLICT the admin PATCH /doors/:archiveName
 * route uses (admin-routes.ts) — so these show up identically to a
 * human's manual edit through the admin UI.
 *
 * releaseGroup is special-cased: only written when the door's base
 * release_group column is still empty AND no override already exists
 * for that field. Overrides take display precedence over the base
 * column, so writing one over an already-correct value (e.g. from the
 * filename-regex backfill) would actively regress it.
 *
 * Usage:
 *   npx tsx scripts/apply-diz-extraction.ts <results.json> [--dry-run]
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';

interface Extraction {
  id: string;
  archiveName: string;
  name: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
  releaseGroup: string | null;
  requiresBbs: string | null;
  confidence: number;
}

function main() {
  const file = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!file) {
    console.error('usage: apply-diz-extraction.ts <results.json> [--dry-run]');
    process.exit(1);
  }
  const results = JSON.parse(fs.readFileSync(file, 'utf8')) as Extraction[];
  if (dryRun) console.error('[apply-diz] DRY RUN — no DB writes');

  const cfg = loadConfig();
  const db = new Database(cfg.dbPath);
  applySchema(db);
  runMigrations(db);

  const upsertOverride = db.prepare(
    `INSERT INTO door_catalog_overrides (catalog_id, field, value, edited_by, edited_at)
     VALUES (?, ?, ?, NULL, strftime('%s','now'))
     ON CONFLICT(catalog_id, field) DO UPDATE SET
       value = excluded.value, edited_by = excluded.edited_by, edited_at = excluded.edited_at`
  );
  const getBase = db.prepare('SELECT release_group FROM door_catalog WHERE id = ?');
  const getOverride = db.prepare(
    `SELECT 1 FROM door_catalog_overrides WHERE catalog_id = ? AND field = 'release_group'`
  );
  const recordAudit = db.prepare(
    `INSERT INTO admin_audit (admin_id, action, target, detail) VALUES (NULL, 'edit', ?, ?)`
  );

  let fieldsWritten = 0, rgSkippedTrusted = 0, rowsTouched = 0;

  const tx = db.transaction(() => {
    for (const r of results) {
      let touched = false;
      const setField = (field: string, value: string | null) => {
        if (value == null || value === '') return;
        if (!dryRun) {
          upsertOverride.run(r.id, field, value);
          recordAudit.run(r.id, JSON.stringify({ field, to: value, source: 'diz-extraction-workflow' }));
        }
        fieldsWritten++;
        touched = true;
      };

      setField('name', r.name);
      setField('description', r.description);
      setField('version', r.version);
      setField('author', r.author);
      setField('requires_bbs', r.requiresBbs);

      if (r.releaseGroup) {
        const base = getBase.get(r.id) as { release_group: string | null } | undefined;
        const hasOverride = getOverride.get(r.id);
        if (base && (base.release_group == null || base.release_group === '') && !hasOverride) {
          setField('release_group', r.releaseGroup);
        } else {
          rgSkippedTrusted++;
        }
      }

      if (touched) rowsTouched++;
    }
  });
  tx();

  console.error(`[apply-diz] ${rowsTouched}/${results.length} rows touched, ${fieldsWritten} fields written`);
  console.error(`[apply-diz] ${rgSkippedTrusted} releaseGroup suggestions skipped (base already trusted or override exists)`);

  db.close();
}

main();
