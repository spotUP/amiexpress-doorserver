/**
 * Read access to releases.db. One shared filtered query serves JSON and
 * .txt alike, so the two formats can never disagree about what matches.
 */
import type Database from 'better-sqlite3';
import { withReleasesDb } from './db';
import type { ReleasesConfig } from './config';
import type { ReleaseField, ReleaseRow } from '../../contract/release-types';

export interface ReleaseQuery {
  q?: string;
  flag?: string;
  dir?: number;
  from?: string;
  to?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /**
   * Cursor for delta polling: only rows with id greater than this. Forces
   * ascending order (a cursor running backwards is a contradiction) and
   * ignores offset (offset+mutation = skipped rows; the cursor IS the position).
   */
  since?: number;
  /** Column subset (`?fields=id,filename,flag`); unknown names are ignored. */
  fields?: ReleaseField[];
}

export const LIST_DEFAULT_LIMIT = 100;
export const LIST_MAX_LIMIT = 500;

const ALL_COLUMNS = `id, dir_no AS dirNo, file_no AS fileNo, filename, flag,
  size_bytes AS sizeBytes, size_note AS sizeNote, date_iso AS dateIso,
  dl_count AS dlCount, uploader, description, version, author,
  raw_desc AS rawDesc`;

/** Slim default for bulk pulls: everything except the art block. */
export const DUMP_DEFAULT_FIELDS: ReleaseField[] = [
  'id',
  'dirNo',
  'fileNo',
  'filename',
  'flag',
  'sizeBytes',
  'sizeNote',
  'dateIso',
  'dlCount',
  'uploader',
  'description',
  'version',
  'author',
];

const FIELD_TO_COLUMN: Record<ReleaseField, string> = {
  id: 'id',
  dirNo: 'dir_no AS dirNo',
  fileNo: 'file_no AS fileNo',
  filename: 'filename',
  flag: 'flag',
  sizeBytes: 'size_bytes AS sizeBytes',
  sizeNote: 'size_note AS sizeNote',
  dateIso: 'date_iso AS dateIso',
  dlCount: 'dl_count AS dlCount',
  uploader: 'uploader',
  description: 'description',
  version: 'version',
  author: 'author',
  rawDesc: 'raw_desc AS rawDesc',
};

/** The SELECT list for a field subset. `id` is always included: without it a
 *  bot cannot resume a dump or name a row, and including it is harmless. */
export function columnsFor(fields: ReleaseField[] | undefined, fallback: string): string {
  if (!fields || fields.length === 0) return fallback;
  const seen = new Set<string>(['id']);
  const cols: string[] = [FIELD_TO_COLUMN.id];
  for (const f of fields) {
    const col = FIELD_TO_COLUMN[f];
    if (col && !seen.has(f)) {
      seen.add(f);
      cols.push(col);
    }
  }
  return cols.join(', ');
}

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
  if (q.since !== undefined) {
    conds.push('id > ?');
    params.push(q.since);
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
): { total: number; rows: Partial<ReleaseRow>[]; limit: number; offset: number } {
  const limit = Math.min(LIST_MAX_LIMIT, Math.max(1, Math.floor(q.limit ?? LIST_DEFAULT_LIMIT)));
  // A cursor is the position: offset is ignored while one is active, and the
  // order is forced ascending so "everything after X" means one thing.
  const offset = q.since !== undefined ? 0 : Math.max(0, Math.floor(q.offset ?? 0));
  const order = q.since !== undefined ? 'ASC' : q.order === 'desc' ? 'DESC' : 'ASC';
  const columns = columnsFor(q.fields, ALL_COLUMNS);
  return withReleasesDb(
    rel,
    (db: Database.Database) => {
      const { clause, params } = whereOf(q);
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM release_files ${clause}`).get(...params) as { n: number })
        .n;
      const rows = db
        .prepare(`SELECT ${columns} FROM release_files ${clause} ORDER BY id ${order} LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as Partial<ReleaseRow>[];
      return { total, rows, limit, offset };
    },
    { readonly: true }
  );
}

/**
 * Every row after `sinceId`, slim columns, callback-driven so a dump streams
 * instead of materialising 299k rows. Chunked internally; resume by passing
 * the last seen id back as `since`.
 */
export function streamReleases(
  rel: ReleasesConfig,
  q: Omit<ReleaseQuery, 'offset' | 'order'> & { limit?: number },
  onRow: (row: Partial<ReleaseRow>) => void
): { rows: number } {
  const columns = columnsFor(q.fields, columnsFor(DUMP_DEFAULT_FIELDS, ALL_COLUMNS));
  const cap = q.limit !== undefined ? Math.max(1, Math.floor(q.limit)) : Infinity;
  let rows = 0;
  withReleasesDb(
    rel,
    (db: Database.Database) => {
      // The loop owns the cursor; since arrives as its start, not as a filter.
      const { clause: where, params } = whereOf({ ...q, since: undefined, order: 'asc' });
      let cursor = q.since ?? 0;
      outer: for (;;) {
        const page = db
          .prepare(
            `SELECT ${columns} FROM release_files ${where ? `${where} AND` : 'WHERE'} id > ? ORDER BY id ASC LIMIT 2000`
          )
          .all(...params, cursor) as Partial<ReleaseRow>[];
        if (!page.length) break;
        for (const row of page) {
          if (rows >= cap) break outer;
          onRow(row);
          rows++;
          if (typeof row.id === 'number') cursor = row.id;
        }
        if (page.length < 2000) break;
      }
    },
    { readonly: true }
  );
  return { rows };
}

export function getReleaseById(rel: ReleasesConfig, id: number): ReleaseRow | null {
  return withReleasesDb(
    rel,
    (db) =>
      (db.prepare(`SELECT ${ALL_COLUMNS} FROM release_files WHERE id = ?`).get(id) as ReleaseRow | undefined) ??
      null,
    { readonly: true }
  );
}
