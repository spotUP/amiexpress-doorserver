/**
 * One classifier, for every endpoint.
 *
 * Ad/junk classification used to happen in two places that could not agree:
 *
 *   - the admin strip-preview opened the archive and classified it LIVE,
 *     applying learned_junk_patterns and the door_not_junk keep-list;
 *   - GET /files/<archive> - which is what the DoorRepo door reads - served
 *     the is_junk column stored in door_catalog_files at index time, with
 *     no learned patterns and no keep-list, and never recomputed.
 *
 * So the admin UI showed today's answer and the door showed a snapshot from
 * whenever the archive was indexed. Observed on -D-CALC.LHA: the door listed
 * sanctuary.txt as an ordinary file when it matches the seed pattern
 * `sanctuary.*` and the admin preview flagged it. The seed pattern set has
 * grown since that row was written, and nothing back-fills.
 *
 * This module is the single answer. Every reader goes through
 * `freshArchiveFiles()`, which:
 *
 *   1. decides whether the stored classification is still trustworthy, from
 *      a fingerprint of everything that can change it - the archive's own
 *      size and mtime, the seed pattern set, the learned patterns, and the
 *      keep-list;
 *   2. re-runs the real classifier when it is not, through the SAME
 *      `analyzeArchive` the strip preview uses;
 *   3. writes the result back, so the next reader is cheap and the
 *      denormalised `door_catalog.junk_count` stops lying;
 *   4. bumps `indexed_at` ONLY when a flag actually changed, because the
 *      catalog revision is `c<count>-t<max(indexed_at)>` and every cache in
 *      the fleet - including the door's own - refetches when it moves. A
 *      bump per request would make that revision meaningless.
 *
 * The expensive path is therefore taken once per archive per rule change,
 * not once per request.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type Database from 'better-sqlite3';

import { analyzeArchive, patternSetStamp } from './ami-stripper';

export interface ClassifiedFile {
  path: string;
  size: number;
  is_junk: number;
  junk_reason: string | null;
}

/**
 * Everything that can change an archive's classification, as one string.
 * Stored per catalog row; a mismatch is what triggers a re-classify.
 */
function classificationFingerprint(
  db: Database.Database,
  archiveName: string,
  absPath: string
): string {
  let archiveStamp = 'missing';
  try {
    const st = fs.statSync(absPath);
    archiveStamp = `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    /* a missing archive is itself a state worth fingerprinting */
  }

  // The learned patterns and the keep-list are small tables; their row count
  // plus newest id is enough to notice any add or delete without hashing
  // every row on every request.
  const learned = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM learned_junk_patterns')
    .get() as { n: number; m: number };
  const keep = db
    .prepare(
      'SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM door_not_junk WHERE archive_name = ? COLLATE NOCASE'
    )
    .get(archiveName) as { n: number; m: number };

  return crypto
    .createHash('md5')
    .update(`${archiveStamp}|${patternSetStamp()}|l${learned.n}.${learned.m}|k${keep.n}.${keep.m}`)
    .digest('hex');
}

/** The rows as stored, without asking whether they are still right. */
function storedFiles(db: Database.Database, catalogId: string): ClassifiedFile[] {
  return db
    .prepare(
      'SELECT path, size, is_junk, junk_reason FROM door_catalog_files WHERE catalog_id = ? ORDER BY path'
    )
    .all(catalogId) as ClassifiedFile[];
}

/**
 * The archive's files with a classification that reflects the CURRENT rules.
 *
 * Re-classifies and persists when anything that feeds the decision has
 * changed since the last time; otherwise returns the stored rows unchanged.
 * Never throws for a missing or unreadable archive - it falls back to the
 * stored rows, because a listing that is slightly stale beats an endpoint
 * that 500s.
 *
 * @param db an OPEN, WRITABLE database handle. The caller owns it: readers
 *           that opened read-only must pass a writable one or accept stored
 *           rows via `storedFiles` instead.
 */
export function freshArchiveFiles(
  db: Database.Database,
  catalogId: string,
  archiveName: string,
  absPath: string
): ClassifiedFile[] {
  let fingerprint: string;
  try {
    fingerprint = classificationFingerprint(db, archiveName, absPath);
  } catch {
    return storedFiles(db, catalogId);
  }

  let row: { classified_fp: string | null } | undefined;
  try {
    row = db
      .prepare('SELECT classified_fp FROM door_catalog WHERE id = ?')
      .get(catalogId) as { classified_fp: string | null } | undefined;
  } catch {
    // A database that predates the column (an old snapshot opened by a new
    // binary before migrations run) still has to serve a listing.
    return storedFiles(db, catalogId);
  }

  if (row && row.classified_fp === fingerprint) {
    return storedFiles(db, catalogId);
  }

  if (!fs.existsSync(absPath)) {
    return storedFiles(db, catalogId);
  }

  let result;
  try {
    const learned = db
      .prepare('SELECT pattern FROM learned_junk_patterns')
      .all() as { pattern: string }[];
    const keepRows = db
      .prepare(
        'SELECT file_path AS path FROM door_not_junk WHERE archive_name = ? COLLATE NOCASE'
      )
      .all(archiveName) as { path: string }[];
    const preserve = new Set(keepRows.map((r) => r.path));

    result = analyzeArchive(
      absPath,
      learned.length > 0 ? learned.map((r) => r.pattern) : undefined,
      preserve.size > 0 ? preserve : undefined
    );
  } catch {
    // An archive this server cannot read (LZX with no reader, corrupt
    // member table) keeps whatever it had. Recording the fingerprint would
    // hide the failure; leaving it unset means the next request tries again.
    return storedFiles(db, catalogId);
  }

  const before = storedFiles(db, catalogId);
  const beforeJunk = new Map(before.map((f) => [f.path, f.is_junk]));

  const fresh: ClassifiedFile[] = [];
  for (const entry of result.kept) {
    fresh.push({ path: entry.path, size: entry.size, is_junk: 0, junk_reason: null });
  }
  for (const entry of result.stripped) {
    fresh.push({
      path: entry.path,
      size: entry.size,
      is_junk: 1,
      junk_reason: result.reason[entry.path] ?? 'pattern',
    });
  }
  fresh.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const changed =
    fresh.length !== before.length ||
    fresh.some((f) => (beforeJunk.get(f.path) ?? -1) !== f.is_junk);

  const persist = db.transaction(() => {
    db.prepare('DELETE FROM door_catalog_files WHERE catalog_id = ?').run(catalogId);
    const ins = db.prepare(
      'INSERT OR REPLACE INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason) VALUES (?, ?, ?, ?, ?)'
    );
    for (const f of fresh) {
      ins.run(catalogId, f.path, f.size, f.is_junk, f.junk_reason);
    }
    const junkCount = fresh.filter((f) => f.is_junk === 1).length;

    if (changed) {
      // Moves the catalog revision, which is what makes every cache in the
      // fleet - the door's listtxt.cache included - come back for this.
      db.prepare(
        `UPDATE door_catalog
            SET junk_count = ?, classified_fp = ?, indexed_at = strftime('%s','now')
          WHERE id = ?`
      ).run(junkCount, fingerprint, catalogId);
    } else {
      db.prepare('UPDATE door_catalog SET junk_count = ?, classified_fp = ? WHERE id = ?')
        .run(junkCount, fingerprint, catalogId);
    }
  });
  persist();

  return fresh;
}

/** Absolute path of a catalog row's archive, for callers that have the row. */
export function archiveAbsPath(archiveRoot: string, archivePath: string): string {
  return path.isAbsolute(archivePath) ? archivePath : path.join(archiveRoot, archivePath);
}
