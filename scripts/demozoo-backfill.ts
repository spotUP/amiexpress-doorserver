#!/usr/bin/env npx tsx

/**
 * Demozoo backfill — author/release_group + FILE_ID.DIZ.
 *
 * Two passes for the rows the CSV importer touched:
 *
 *   1. FILE_ID.DIZ: every row missing file_id_diz whose archive is
 *      on disk — extract the DIZ and write it back. (DIZ extraction
 *      comes from src/archive-reader.)
 *
 *   2. author + release_group: the demozoo CSV's "By" field was
 *      originally written verbatim into `author`. This pass re-parses
 *      it: extract the release_group short tag from the filename,
 *      parse "By" into a personal author vs group full name, and
 *      UPSERT the full name into the release_groups lookup table.
 *      Author is cleared when the field is a group name, so a
 *      curator can manually set a personal author later if one is
 *      known.
 *
 * Idempotent: skips rows that already match the desired state.
 *
 * Usage:
 *   npx tsx scripts/demozoo-backfill-diz.ts [--dry-run] [--verbose]
 *   npx tsx scripts/demozoo-backfill-diz.ts --only=diz|author
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

const GROUP_TAG_RE = /^([A-Za-z0-9!$^&]{1,5})[-_^!.]/;
function releaseGroupFromFilename(archiveName: string): string | null {
  const m = GROUP_TAG_RE.exec(archiveName);
  if (!m) return null;
  return m[1].toUpperCase();
}

function splitByAndGroup(by: string, knownGroups: ReadonlySet<string>): { author: string | null; releaseGroup: string | null } {
  const v = by.trim();
  if (!v) return { author: null, releaseGroup: null };
  const spaced = v.indexOf(' / ');
  if (spaced > 0) {
    const left = v.slice(0, spaced).trim();
    const right = v.slice(spaced + 3).trim();
    if (left && right) {
      const l = knownGroups.has(left);
      const r = knownGroups.has(right);
      if (l && r) return { author: null, releaseGroup: v };
      if (r) return { author: left, releaseGroup: right };
      if (l) return { author: right, releaseGroup: left };
      return { author: null, releaseGroup: v };
    }
  }
  if (knownGroups.has(v)) return { author: null, releaseGroup: v };
  return { author: v, releaseGroup: null };
}

function buildKnownGroups(db: Database.Database): Set<string> {
  const rows = db.prepare(`
    SELECT author, COUNT(*) as n
      FROM door_catalog
     WHERE author IS NOT NULL AND author != ''
     GROUP BY author
    HAVING n >= 3
  `).all() as { author: string; n: number }[];
  const s = new Set<string>();
  for (const r of rows) s.add(r.author);
  return s;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1] : null;
  if (dryRun) console.error('[backfill] DRY RUN — no DB writes');

  const cfg = loadConfig();
  const submittedDir = path.join(cfg.archivesRoot, 'Submitted');
  const db = new Database(cfg.dbPath);
  applySchema(db);
  runMigrations(db);
  const knownGroups = buildKnownGroups(db);

  const runDiz = !only || only === 'diz';
  const runAuthor = !only || only === 'author';

  // ─── Pass 1: FILE_ID.DIZ ────────────────────────────────────────────
  if (runDiz) {
    const rows = db.prepare(`
      SELECT id, archive_name
        FROM door_catalog
       WHERE (file_id_diz IS NULL OR file_id_diz = '')
         AND (
           source = 'demozoo'
           OR (source = 'scan' AND demozoo_url IS NOT NULL)
         )
    `).all() as { id: string; archive_name: string }[];

    console.error(`[backfill/diz] ${rows.length} candidate rows`);
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

    let updated = 0, missing = 0, noDiz = 0, errors = 0;
    const start = Date.now();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const p = path.join(submittedDir, r.archive_name);
      if (!fs.existsSync(p)) { missing++; continue; }
      let contents: ArchiveContents;
      try { contents = readContents(p); } catch { errors++; continue; }
      if (!contents.fileIdDiz) { noDiz++; continue; }
      if (!dryRun) {
        try {
          const tx = db.transaction(() => {
            updateStmt.run(contents.fileIdDiz, contents.docFilename, contents.doc, r.id);
            for (const f of contents.files) {
              try { insertFileStmt.run(r.id, f.path, f.size); } catch {}
            }
          });
          tx();
          updated++;
        } catch { errors++; }
      } else {
        updated++;
      }
      if ((i + 1) % 100 === 0 || i === rows.length - 1) {
        const elapsed = (Date.now() - start) / 1000;
        const rate = (i + 1) / elapsed;
        const remaining = (rows.length - i - 1) / Math.max(rate, 0.001);
        process.stderr.write(
          `\r[backfill/diz] ${i + 1}/${rows.length} (${(rate * 60).toFixed(0)}/min, ~${Math.ceil(remaining / 60)} min left)   `,
        );
      }
    }
    process.stderr.write('\n');
    console.error(`[backfill/diz] done. updated=${updated} noDiz=${noDiz} missing=${missing} errors=${errors}`);
  }

  // ─── Pass 2: author / release_group ─────────────────────────────────
  if (runAuthor) {
    // The CSV "By" field was originally stored verbatim in
    // `door_catalog.author`. Re-derive: filename → release_group
    // (short tag), parsed By → author (personal only) + release_group
    // full name (via release_groups table). We need the original CSV
    // value to do this; that's in demozoo_csv_imported.demozoo_url +
    // we don't have the By value stored anywhere. So we read it from
    // the local `author` column when it has the unsplit "X / Y" form
    // and the right side is a known group. For rows where author was
    // already a single token, we just decide based on whether it's a
    // known group.
    const rows = db.prepare(`
      SELECT id, archive_name, author
        FROM door_catalog
       WHERE (
         source = 'demozoo'
         OR (source = 'scan' AND demozoo_url IS NOT NULL)
       )
         AND author IS NOT NULL AND author != ''
    `).all() as { id: string; archive_name: string; author: string }[];

    console.error(`[backfill/author] ${rows.length} candidate rows`);

    const updateDoorStmt = db.prepare(
      `UPDATE door_catalog
          SET release_group = ?,
              author = ?
        WHERE id = ?`
    );
    const upsertGroupStmt = db.prepare(
      `INSERT INTO release_groups (abbreviation, full_name, updated_at)
       VALUES (?, ?, strftime('%s','now'))
       ON CONFLICT(abbreviation) DO UPDATE
         SET full_name = CASE
           WHEN release_groups.full_name IS NULL OR release_groups.full_name = '' OR release_groups.full_name = release_groups.abbreviation
           THEN excluded.full_name
           ELSE release_groups.full_name
         END,
         updated_at = strftime('%s','now')`
    );

    let doorsChanged = 0, groupsUpserted = 0;
    const start = Date.now();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const tag = releaseGroupFromFilename(r.archive_name);
      const parsed = splitByAndGroup(r.author, knownGroups);
      const newTag = tag ?? null;
      const newAuthor = parsed.author;
      const groupFullName = parsed.releaseGroup;

      // Check current values to avoid no-op writes.
      const current = db.prepare(
        'SELECT release_group, author FROM door_catalog WHERE id = ?'
      ).get(r.id) as { release_group: string | null; author: string | null } | undefined;
      if (!current) continue;
      const tagChanged = (newTag ?? null) !== (current.release_group ?? null);
      const authorChanged = (newAuthor ?? null) !== (current.author ?? null);

      if (tagChanged || authorChanged) {
        if (!dryRun) {
          updateDoorStmt.run(newTag, newAuthor, r.id);
        }
        doorsChanged++;
      }
      if (tag && groupFullName) {
        if (!dryRun) {
          upsertGroupStmt.run(tag, groupFullName);
        }
        groupsUpserted++;
      }
      if ((i + 1) % 200 === 0 || i === rows.length - 1) {
        const elapsed = (Date.now() - start) / 1000;
        const rate = (i + 1) / elapsed;
        process.stderr.write(
          `\r[backfill/author] ${i + 1}/${rows.length} (${(rate * 60).toFixed(0)}/min)   `,
        );
      }
    }
    process.stderr.write('\n');
    console.error(`[backfill/author] done. doorsChanged=${doorsChanged} groupsUpserted=${groupsUpserted}`);
  }

  db.close();
}

main().catch((e) => { console.error('[backfill] fatal:', e); process.exit(1); });
