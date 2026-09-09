#!/usr/bin/env npx tsx
/**
 * Import an AquaScan BBS file listing into releases.db.
 *
 * Each file entry's description block is the entry's mini file_id — the same
 * three shapes (single-line prose, wrapped prose, inline art DIZ) that
 * contract/describe.ts already reads — so every row gets description/version/
 * author via analyseDoor, plus the entry-line date neither doors nor DIZs have.
 *
 * Doors with a hand-edit are a doors.db concept; releases.db has no overrides
 * table at all. Re-running this file upserts on (dir_no, file_no, filename):
 * same file re-listed updates in place (dir 66 was captured twice with
 * different files reusing numbers, so (dir_no, file_no) alone would destroy
 * the older pass). If curation comes later it gets its own overrides table
 * and this script learns to skip it.
 *
 * Usage:
 *   npx tsx scripts/import-bbs-filelist.ts --db <releases.db> --file <list.txt> [--doors-db <doors.db>] [--dry-run]
 *
 * --doors-db points at the doors database whose release_groups table names
 * the filename prefixes (Fairlight for FLT-, Paradox for PDX-). Only known
 * abbreviations are written, never invented — same rule as the doors
 * filename backfill. Without it, group columns stay NULL.
 *
 * Dry-run parses and reports counts without writing.
 */
import Database from 'better-sqlite3';
import { analyseDoor, buildGroupTags } from '../contract/describe';
import { parseFilelist, type FileListEntry } from '../src/releases/parse';
import { applyReleasesSchema } from '../src/releases/db';
import { runMigrations } from '../src/migrations';
import { RELEASES_MIGRATIONS } from '../src/releases/migrations';

const BATCH = 2000;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

async function main(): Promise<void> {
  const dbPath = arg('--db');
  const filePath = arg('--file');
  const doorsDbPath = arg('--doors-db');
  const dryRun = process.argv.includes('--dry-run');
  if (!dbPath || !filePath) {
    console.error(
      'usage: import-bbs-filelist.ts --db <releases.db> --file <list.txt> [--doors-db <doors.db>] [--dry-run]'
    );
    process.exit(1);
  }

  // Scene-group lookup for filename prefixes. Map only, read once.
  const groups = new Map<string, string>();
  if (doorsDbPath) {
    const doorsDb = new Database(doorsDbPath, { readonly: true });
    try {
      for (const r of doorsDb.prepare('SELECT abbreviation, full_name FROM release_groups').all() as {
        abbreviation: string;
        full_name: string;
      }[]) {
        groups.set(r.abbreviation.toUpperCase(), r.full_name);
      }
    } finally {
      doorsDb.close();
    }
    console.error(`[import] ${groups.size} known groups for prefix matching`);
  }

  const groupPrefix = /^([A-Za-z0-9!$^&]{1,5})[-_^!]/;
  const matchGroup = (filename: string): { abbrev: string; full: string } | null => {
    const m = groupPrefix.exec(filename);
    if (!m) return null;
    const full = groups.get(m[1].toUpperCase());
    return full ? { abbrev: m[1].toUpperCase(), full } : null;
  };

  // Pass 1: filenames for corpus group tags (same rule as doors: a prefix
  // counts as a release tag only on 3+ archives, derived from THIS corpus).
  const names: string[] = [];
  await parseFilelist(filePath, (e) => {
    names.push(e.filename);
  });
  const groupTags = buildGroupTags(names);
  console.error(`[import] ${names.length} entries, ${groupTags.size} group tags`);

  const db = new Database(dryRun ? ':memory:' : dbPath);
  try {
    applyReleasesSchema(db);
    runMigrations(db, RELEASES_MIGRATIONS);

    const upsert = db.prepare(`
      INSERT INTO release_files
        (dir_no, file_no, filename, flag, size_bytes, size_note, date_iso,
         dl_count, uploader, description, version, author,
         release_group, release_group_full, raw_desc)
      VALUES (@dirNo, @fileNo, @filename, @flag, @sizeBytes, @sizeNote, @dateIso,
         @dlCount, @uploader, @description, @version, @author,
         @releaseGroup, @releaseGroupFull, @rawDesc)
      ON CONFLICT(dir_no, file_no, filename) DO UPDATE SET
        filename = excluded.filename, flag = excluded.flag,
        size_bytes = excluded.size_bytes, size_note = excluded.size_note,
        date_iso = excluded.date_iso, dl_count = excluded.dl_count,
        uploader = excluded.uploader, description = excluded.description,
        version = excluded.version, author = excluded.author,
        release_group = excluded.release_group,
        release_group_full = excluded.release_group_full,
        raw_desc = excluded.raw_desc
    `);

    let done = 0;
    let batch: Parameters<typeof upsert.run>[0][] = [];
    const flushBatch = db.transaction(() => {
      for (const row of batch) upsert.run(row);
      batch = [];
    });

    const toRow = (e: FileListEntry) => {
      const facts = analyseDoor(
        { dizText: e.descLines.join('\n'), name: null, archiveName: e.filename, binaryName: null },
        groupTags
      );
      const group = matchGroup(e.filename);
      return {
        dirNo: e.dirNo,
        fileNo: e.fileNo,
        filename: e.filename,
        flag: e.flag,
        sizeBytes: e.sizeBytes,
        sizeNote: e.sizeNote,
        dateIso: e.dateIso,
        dlCount: e.dlCount,
        uploader: e.uploader,
        description: facts.description,
        version: facts.version || null,
        author: facts.author || null,
        releaseGroup: group?.abbrev ?? null,
        releaseGroupFull: group?.full ?? null,
        rawDesc: e.descLines.join('\n'),
      };
    };

    await parseFilelist(filePath, (e) => {
      batch.push(toRow(e) as never);
      done++;
      if (batch.length >= BATCH) flushBatch();
      if (done % 25000 === 0) console.error(`[import] ${done}/${names.length}`);
    });
    flushBatch();

    const counts = db.prepare('SELECT COUNT(*) AS n FROM release_files').get() as { n: number };
    console.error(`[import] ${dryRun ? 'dry-run, ' : ''}done: ${done} parsed, ${counts.n} rows in db`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`[ERROR] ${(err as Error).message}`);
  process.exit(1);
});
