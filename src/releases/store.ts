/**
 * Read access to releases.db. One shared filtered query serves JSON and
 * .txt alike, so the two formats can never disagree about what matches.
 */
import type Database from 'better-sqlite3';
import { withReleasesDb } from './db';
import type { ReleasesConfig } from './config';
import type { ReleaseRow } from '../../contract/release-types';

export interface ReleaseQuery {
  q?: string;
  flag?: string;
  dir?: number;
  from?: string;
  to?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export const LIST_DEFAULT_LIMIT = 100;
export const LIST_MAX_LIMIT = 500;

const COLUMNS = `id, dir_no AS dirNo, file_no AS fileNo, filename, flag,
  size_bytes AS sizeBytes, size_note AS sizeNote, date_iso AS dateIso,
  dl_count AS dlCount, uploader, description, version, author`;

function whereOf(q: ReleaseQuery): { clause: string; params: (string | number)[] } {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (q.q?.trim()) {
    const like = `%${q.q.trim()}%`;
    conds.push('(filename LIKE ? OR description LIKE ?)');
    params.push(like, like);
  }
  if (q.flag) {
    conds.push('flag = ?');
    params.push(q.flag.toUpperCase());
  }
  if (q.dir !== undefined) {
    conds.push('dir_no = ?');
    params.push(q.dir);
  }
  if (q.from) {
    conds.push('date_iso >= ?');
    params.push(q.from);
  }
  if (q.to) {
    conds.push('date_iso <= ?');
    params.push(q.to);
  }
  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

export function getReleasesRevision(rel: ReleasesConfig): string {
  return withReleasesDb(
    rel,
    (db) => {
      const row = db
        .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM release_files')
        .get() as { n: number; m: number };
      return `r${row.n}-t${row.m}`;
    },
    { readonly: true }
  );
}

export function getReleasesCount(rel: ReleasesConfig): number {
  return withReleasesDb(
    rel,
    (db) => (db.prepare('SELECT COUNT(*) AS n FROM release_files').get() as { n: number }).n,
    { readonly: true }
  );
}

export function queryReleases(
  rel: ReleasesConfig,
  q: ReleaseQuery
): { total: number; rows: ReleaseRow[]; limit: number; offset: number } {
  const limit = Math.min(LIST_MAX_LIMIT, Math.max(1, Math.floor(q.limit ?? LIST_DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const order = q.order === 'desc' ? 'DESC' : 'ASC';
  return withReleasesDb(
    rel,
    (db: Database.Database) => {
      const { clause, params } = whereOf(q);
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM release_files ${clause}`).get(...params) as { n: number })
        .n;
      const rows = db
        .prepare(`SELECT ${COLUMNS} FROM release_files ${clause} ORDER BY id ${order} LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as ReleaseRow[];
      return { total, rows, limit, offset };
    },
    { readonly: true }
  );
}

export function getReleaseById(rel: ReleasesConfig, id: number): ReleaseRow | null {
  return withReleasesDb(
    rel,
    (db) =>
      (db.prepare(`SELECT ${COLUMNS} FROM release_files WHERE id = ?`).get(id) as ReleaseRow | undefined) ??
      null,
    { readonly: true }
  );
}
