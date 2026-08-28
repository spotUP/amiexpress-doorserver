/**
 * Read access to the door catalog.
 *
 * Ported from amiexpress-web/web/backend/src/doors/door-catalog.service.ts.
 * The SQL is deliberately identical - this service answers the same
 * questions the BBS-hosted API answered, and the parity harness asserts the
 * bytes match.
 *
 * archive_path is stored RELATIVE to the archives root (e.g.
 * "FAME/5D!STC01.LHA") so the same database works on a dev machine and on
 * the server. Older rows may carry an absolute path; both forms resolve.
 */
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { buildGroupTags } from './describe';
import { applyOverrides, hiddenExclusion, isHidden, loadOverrides, overridesStamp, hiddenStamp } from './effective';
import type { ServerConfig } from './config';
import { deleteMembers, findArchiverBinary } from './lha-member-delete';
import { getArchiveChecksums } from './checksums';

export interface CatalogEntry {
  id: string;
  archive_name: string;
  archive_path: string;
  binary_name: string | null;
  door_type: string;
  name: string;
  version: string | null;
  author: string | null;
  release_group: string | null;
  description: string | null;
  file_id_diz: string | null;
  doc_filename: string | null;
  doc_raw: string | null;
  suggested_tooltypes: string | null;
  category: string | null;
  archive_size: number;
  junk_count: number;
  ads_stripped: number;
  corpus_id: string | null;
  source: string | null;
  md5: string | null;
  sha256: string | null;
  release_date: string | null;
  platform: string | null;
  download_url: string | null;
  credits: string | null;
  external_links: string | null;
  screenshots: string | null;
}

export interface ArchiveFile {
  path: string;
  size: number;
  is_junk: number;
  junk_reason: string | null;
}

export function resolveArchivePath(cfg: ServerConfig, archivePath: string): string {
  if (path.isAbsolute(archivePath)) return archivePath;
  return path.join(cfg.archivesRoot, archivePath);
}

/**
 * One door by archive name. A hidden door is INVISIBLE here, which is what
 * makes /archive, /files and /diz stop answering for it - opts.includeHidden
 * is for the admin console, the one caller that must still see it.
 */
export function getCatalogEntryByArchive(
  cfg: ServerConfig,
  archiveName: string,
  opts?: { includeHidden?: boolean }
): CatalogEntry | null {
  const db = openDb(cfg, { readonly: true });
  try {
    // COLLATE NOCASE matches the BBS original (door-catalog.service.ts:150):
    // archive-name lookup is case-insensitive, and clients rely on it.
    const row = db
      .prepare('SELECT * FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
      .get(archiveName) as CatalogEntry | undefined;
    if (!row) return null;
    if (!opts?.includeHidden && isHidden(db, row.id)) return null;
    // Human corrections win over the scan, here as everywhere else.
    return applyOverrides(row, row.id, loadOverrides(db));
  } finally {
    db.close();
  }
}

export function getArchiveFiles(cfg: ServerConfig, catalogId: string): ArchiveFile[] {
  const db = openDb(cfg, { readonly: true });
  try {
    return db
      .prepare('SELECT path, size, is_junk, junk_reason FROM door_catalog_files WHERE catalog_id = ? ORDER BY path')
      .all(catalogId) as ArchiveFile[];
  } finally {
    db.close();
  }
}

/**
 * Revision string: a fingerprint of the CATALOG, not of the deployment.
 * COUNT + newest indexed_at changes whenever any row is added, removed or
 * re-indexed, and needs no file that only exists inside a container. A
 * catalog we cannot read has no revision we can honestly assert.
 */
/**
 * The release-group tags of the WHOLE corpus.
 *
 * A prefix counts as a release tag only when three or more archives carry
 * it, so this statistic is a property of the corpus and not of whatever
 * subset a caller happens to be rendering. Deriving it from a filtered or
 * paged result instead makes the same door describe itself differently
 * depending on how it was reached: a 30-row recent index recognises almost
 * no tags, so "MB-MAKER" renders as "Maker" there and "Mb Maker" in the
 * full index.
 */
export function corpusGroupTags(db: Database.Database): ReadonlySet<string> {
  const names = (db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[]).map(
    (r) => r.archive_name
  );
  return buildGroupTags(names);
}

/** corpusGroupTags for a caller that has no database open of its own. */
export function loadCorpusGroupTags(cfg: ServerConfig): ReadonlySet<string> {
  const db = openDb(cfg, { readonly: true });
  try {
    return corpusGroupTags(db);
  } finally {
    db.close();
  }
}

export function getCatalogRevision(cfg: ServerConfig): string {
  try {
    const db = openDb(cfg, { readonly: true });
    try {
      const exclude = hiddenExclusion(db);
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(MAX(indexed_at), 0) AS t FROM door_catalog${
            exclude ? ` WHERE ${exclude}` : ''
          }`
        )
        .get() as { n: number; t: number };
      // A human edit changes what every endpoint says without touching
      // door_catalog, so the revision has to carry it - otherwise every
      // cache in the fleet keeps serving pre-edit bytes under an unchanged
      // ETag. The segment is appended ONLY when an edit exists, so a catalog
      // nobody has corrected still produces the byte-identical revision the
      // AmigaDOS clients have always seen.
      const edits = overridesStamp(db) + hiddenStamp(db);
      return edits > 0 ? `c${row.n}-t${row.t}-o${edits}` : `c${row.n}-t${row.t}`;
    } finally {
      db.close();
    }
  } catch {
    return 'unknown';
  }
}

/** How many doors the repository actually offers - hidden ones excluded. */
export function getDoorCount(cfg: ServerConfig): number {
  const db = openDb(cfg, { readonly: true });
  try {
    const exclude = hiddenExclusion(db);
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM door_catalog${exclude ? ` WHERE ${exclude}` : ''}`).get() as {
        n: number;
      }
    ).n;
  } finally {
    db.close();
  }
}

/**
 * `archiveName` with its own trailing extension removed (everything after
 * the last '.'), or the whole name when there is no '.'. Deliberately
 * generic rather than a hardcoded list of known extensions (.LHA, .LZX,
 * .LZH, ...) - the corpus is not guaranteed to stay within that set, and
 * "everything after the last dot" is what every one of those actually is.
 */
export function stripArchiveExtension(archiveName: string): string {
  const dot = archiveName.lastIndexOf('.');
  return dot === -1 ? archiveName : archiveName.slice(0, dot);
}

/**
 * Resolves `GET /archive/<basename>.diz` (routes.ts) to the one catalog
 * archive it means, so a client can fetch a door's FILE_ID.DIZ without
 * knowing its exact extension.
 *
 * Two passes, in this order:
 *   1. Exact, case-insensitive match against the FULL archive_name. This
 *      lets a client that already knows the exact filename (extension
 *      included) just append ".diz" - e.g. archive/ACC-V103.LHA.diz - and
 *      also protects against the case below: if a real archive happens to
 *      be named exactly `basename`, that is unambiguous even if some other
 *      archive's basename-with-extension-stripped later collides.
 *   2. Unique match on `basename` against every catalog row's own
 *      extension-stripped name. `archive_name` is UNIQUE in the schema, so
 *      this can only be ambiguous when two DIFFERENT archives share a
 *      basename under different extensions (e.g. FOO.LHA and FOO.LZX) - in
 *      which case this returns 'ambiguous' rather than guessing which one
 *      the client meant.
 *
 * Returns the resolved archive_name, 'ambiguous', or null (no match).
 */
// ─── Archive stripping ────────────────────────────────────────────────────────

export interface StripOnServerResult {
  ok: boolean;
  removed?: number;
  newJunkCount?: number;
  reason?: string;
}

/**
 * Strip junk members from a catalog archive in place. The archive must be
 * LHA/LZH (LZX cannot be rewritten). After deletion the row is
 * re-described: size, digests, junk_count, and indexed_at are refreshed.
 */
export function stripArchiveOnServer(
  cfg: ServerConfig,
  archiveName: string,
  members: string[],
  adminId: number | null
): StripOnServerResult {
  const db = openDb(cfg);
  try {
    const row = db
      .prepare('SELECT id, archive_path FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
      .get(archiveName) as { id: string; archive_path: string } | undefined;
    if (!row) {
      return { ok: false, reason: 'no such door' };
    }

    const absPath = resolveArchivePath(cfg, row.archive_path);
    if (!fs.existsSync(absPath)) {
      return { ok: false, reason: `archive file not found on disk: ${path.basename(absPath)}` };
    }

    const binary = findArchiverBinary();
    const ext = path.extname(absPath).toLowerCase();
    if (ext !== '.lha' && ext !== '.lzh') {
      return {
        ok: false,
        reason: ext === '.lzx'
          ? 'LZX archives cannot be rewritten: no LZX writer exists.'
          : `Unsupported archive format: ${ext || '(none)'}`,
      };
    }
    if (!binary) {
      return { ok: false, reason: 'No lha binary available on this server.' };
    }

    // Empty members list: the stripper found 0 ads. Mark the door as reviewed
    // (ads_stripped=1) without touching the archive on disk.
    if (members.length === 0) {
      db.prepare(
        `UPDATE door_catalog SET ads_stripped = 1, indexed_at = strftime('%s','now') WHERE id = ?`
      ).run(row.id);
      return { ok: true, removed: 0, newJunkCount: 0 };
    }

    const deleteResult = deleteMembers(absPath, members, { binary });
    if (!deleteResult.ok) {
      return { ok: false, reason: deleteResult.reason };
    }

    // Re-describe the archive after modification
    const checksums = getArchiveChecksums(absPath);
    const stat = fs.statSync(absPath);

    // Delete catalog file rows for removed members
    const deleteFiles = db.prepare('DELETE FROM door_catalog_files WHERE catalog_id = ? AND path = ?');
    for (const member of members) {
      deleteFiles.run(row.id, member);
    }

    // Count remaining junk files
    const junkRow = db
      .prepare('SELECT COUNT(*) AS n FROM door_catalog_files WHERE catalog_id = ? AND is_junk = 1')
      .get(row.id) as { n: number };
    const newJunkCount = junkRow.n;

    // Update the catalog row
    db.prepare(
      `UPDATE door_catalog SET
        archive_size = ?, md5 = ?, sha256 = ?,
        junk_count = ?, ads_stripped = 1, indexed_at = strftime('%s','now')
       WHERE id = ?`
    ).run(stat.size, checksums.md5, checksums.sha256, newJunkCount, row.id);

    return { ok: true, removed: members.length, newJunkCount };
  } finally {
    db.close();
  }
}

export function findArchiveNameForDizBasename(cfg: ServerConfig, basename: string): string | 'ambiguous' | null {
  const db = openDb(cfg, { readonly: true });
  try {
    const exact = db
      .prepare('SELECT archive_name FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
      .get(basename) as { archive_name: string } | undefined;
    if (exact) return exact.archive_name;

    const rows = db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[];
    const target = basename.toLowerCase();
    const matches = rows.filter((r) => stripArchiveExtension(r.archive_name).toLowerCase() === target);
    if (matches.length === 1) return matches[0].archive_name;
    if (matches.length > 1) return 'ambiguous';
    return null;
  } finally {
    db.close();
  }
}
