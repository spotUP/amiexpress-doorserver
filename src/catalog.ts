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
import * as path from 'path';
import { openDb } from './db';
import type { ServerConfig } from './config';

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
  corpus_id: string | null;
  source: string | null;
  md5: string | null;
  sha256: string | null;
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

export function getCatalogEntryByArchive(cfg: ServerConfig, archiveName: string): CatalogEntry | null {
  const db = openDb(cfg, { readonly: true });
  try {
    // COLLATE NOCASE matches the BBS original (door-catalog.service.ts:150):
    // archive-name lookup is case-insensitive, and clients rely on it.
    const row = db
      .prepare('SELECT * FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
      .get(archiveName) as CatalogEntry | undefined;
    return row ?? null;
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
export function getCatalogRevision(cfg: ServerConfig): string {
  try {
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db
        .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(indexed_at), 0) AS t FROM door_catalog')
        .get() as { n: number; t: number };
      return `c${row.n}-t${row.t}`;
    } finally {
      db.close();
    }
  } catch {
    return 'unknown';
  }
}

export function getDoorCount(cfg: ServerConfig): number {
  const db = openDb(cfg, { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM door_catalog').get() as { n: number }).n;
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
