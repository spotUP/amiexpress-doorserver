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
  group?: string;
  dir?: number;
  from?: string;
  to?: string;
  sort?: string;
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
  release_group AS releaseGroup, release_group_full AS releaseGroupFull,
  raw_desc AS rawDesc`;

/**
 * Sort keys are an allowlist mapped to SQL, never interpolated from the
 * query string: `sort` reaches this straight from a URL.
 */
export const RELEASE_SORT_COLUMNS: Record<string, string> = {
  id: 'id',
  filename: 'filename COLLATE NOCASE',
  group: 'release_group COLLATE NOCASE',
  flag: 'flag',
  size: 'size_bytes',
  date: 'date_iso',
  dir: 'dir_no',
  file: 'file_no',
  version: 'version COLLATE NOCASE',
  author: 'author COLLATE NOCASE',
  downloads: 'dl_count',
  uploader: 'uploader COLLATE NOCASE',
};

export function resolveReleaseSort(sort: string | undefined): string {
  if (sort && Object.prototype.hasOwnProperty.call(RELEASE_SORT_COLUMNS, sort)) {
    return RELEASE_SORT_COLUMNS[sort];
  }
  return RELEASE_SORT_COLUMNS.id;
}

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
  'releaseGroup',
  'releaseGroupFull',
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
  releaseGroup: 'release_group AS releaseGroup',
  releaseGroupFull: 'release_group_full AS releaseGroupFull',
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
  if (q.group) {
    conds.push('release_group = ?');
    params.push(q.group.toUpperCase());
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
  // sort+order are forced to id ascending so "everything after X" means one
  // thing. A cursor running in any other order is a contradiction.
  const offset = q.since !== undefined ? 0 : Math.max(0, Math.floor(q.offset ?? 0));
  const sortSql = q.since !== undefined ? RELEASE_SORT_COLUMNS.id : resolveReleaseSort(q.sort);
  const order = q.since !== undefined ? 'ASC' : q.order === 'desc' ? 'DESC' : 'ASC';
  const orderBy = sortSql === RELEASE_SORT_COLUMNS.id ? `ORDER BY id ${order}` : `ORDER BY ${sortSql} ${order}, id ASC`;
  const columns = columnsFor(q.fields, ALL_COLUMNS);
  return withReleasesDb(
    rel,
    (db: Database.Database) => {
      const { clause, params } = whereOf(q);
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM release_files ${clause}`).get(...params) as { n: number })
        .n;
      const rows = db
        .prepare(`SELECT ${columns} FROM release_files ${clause} ${orderBy} LIMIT ? OFFSET ?`)
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

export interface ReleaseStats {
  total: number;
  /** Entries naming an uploader (chevron + explicit credits, ~3% of corpus). */
  withUploader: number;
  withDlCount: number;
  byFlag: { value: string | null; n: number }[];
  byGroup: { value: string | null; n: number }[];
  byUploader: { value: string | null; n: number }[];
  byAuthor: { value: string | null; n: number }[];
  sizeDistribution: { value: string | null; n: number }[];
  /** Entry months (`YYYY-MM`), chronological. */
  overTime: { value: string | null; n: number }[];
}

/** Aggregated statistics for the dashboard. Mirrors GET /stats on doors. */
export function getReleasesStats(rel: ReleasesConfig): ReleaseStats {
  return withReleasesDb(
    rel,
    (db: Database.Database) => {
      const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
      const all = (sql: string): { value: string | null; n: number }[] =>
        db.prepare(sql).all() as { value: string | null; n: number }[];
      const total = one('SELECT COUNT(*) AS n FROM release_files');
      const withUploader = one(
        `SELECT COUNT(*) AS n FROM release_files WHERE uploader IS NOT NULL AND uploader != ''`
      );
      const withDlCount = one('SELECT COUNT(*) AS n FROM release_files WHERE dl_count IS NOT NULL');
      const byFlag = all(
        `SELECT NULLIF(flag, '') AS value, COUNT(*) AS n
           FROM release_files GROUP BY value ORDER BY n DESC`
      );
      const byGroup = all(
        `SELECT release_group AS value, COUNT(*) AS n
           FROM release_files WHERE release_group IS NOT NULL AND release_group != ''
           GROUP BY value ORDER BY n DESC LIMIT 20`
      );
      const byUploader = all(
        `SELECT uploader AS value, COUNT(*) AS n
           FROM release_files WHERE uploader IS NOT NULL AND uploader != ''
           GROUP BY value ORDER BY n DESC LIMIT 20`
      );
      const byAuthor = all(
        `SELECT author AS value, COUNT(*) AS n
           FROM release_files WHERE author IS NOT NULL AND author != ''
           GROUP BY value ORDER BY n DESC LIMIT 20`
      );
      const sizeDistribution = all(
        `SELECT
           CASE
             WHEN size_bytes IS NULL THEN 'No size (nuked)'
             WHEN size_bytes < 10240 THEN '< 10 KB'
             WHEN size_bytes < 102400 THEN '10-100 KB'
             WHEN size_bytes < 1048576 THEN '100 KB - 1 MB'
             WHEN size_bytes < 10485760 THEN '1-10 MB'
             ELSE '10+ MB'
           END AS value,
           COUNT(*) AS n
         FROM release_files GROUP BY value ORDER BY MIN(size_bytes) IS NULL, MIN(size_bytes)`
      );
      const overTime = all(
        `SELECT substr(date_iso, 1, 7) AS value, COUNT(*) AS n
           FROM release_files GROUP BY value ORDER BY value`
      );
      return { total, withUploader, withDlCount, byFlag, byGroup, byUploader, byAuthor, sizeDistribution, overTime };
    },
    { readonly: true }
  );
}

export interface FactsFile {
  filename: string;
  dirNo: number;
  fileNo: number;
  dateIso: string;
}

export interface ReleaseFacts {
  span: {
    firstDate: string;
    lastDate: string;
    firstFile: FactsFile;
    lastFile: FactsFile;
  };
  /**
   * Earliest RELIABLY-DATED file description that reads as a real DIZ: 4+
   * lines with art runs (`____`, `****`, `----`, `++++`, `||||`, `¼`, …),
   * excluding rows whose date contradicts a twin row (same filename AND
   * size, different date — e.g. SLT!RX10.LZX is listed as both 12-18-89
   * and 12-18-98 while its own art says ©1998, so neither row's date can
   * crown it "first"). rawDesc is included so the page can render the
   * winner verbatim.
   */
  firstDiz: (FactsFile & { lines: number; rawDesc: string }) | null;
  peakYear: { year: string; n: number };
  peakMonth: { month: string; n: number };
  topExt: { ext: string; n: number }[];
  /** First year LHA uploads outnumber DMS ones (the format migration). */
  extCrossover: { year: string } | null;
  weekday: { day: string; counts: number[] };
  biggest: (FactsFile & { sizeBytes: number }) | null;
  longestDesc: (FactsFile & { chars: number; lines: number }) | null;
  mostDownloaded: (FactsFile & { dlCount: number }) | null;
  medianSize: number | null;
  /** Entries dated after today (capture typos like 2038-08-10). */
  futureCount: number;
}

/** Extension leaderboard over a fixed list (LIKE keeps it index-free but
 *  exact: one full scan per call, ~300k rows, fine for a dialog fetch). */
const FACT_EXTS = ['LHA', 'DMS', 'TXT', 'LZX', 'ZIP', 'NFO', 'WRP', 'LZH', 'EXE', 'DOC'];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Curated headline records for the facts page. One dialog fetch. */
export function getReleasesFacts(rel: ReleasesConfig): ReleaseFacts {
  return withReleasesDb(
    rel,
    (db: Database.Database) => {
      const span = db
        .prepare('SELECT MIN(date_iso) AS firstDate, MAX(date_iso) AS lastDate FROM release_files')
        .get() as { firstDate: string; lastDate: string };
      const fileBy = (order: string): FactsFile =>
        db
          .prepare(
            `SELECT filename, dir_no AS dirNo, file_no AS fileNo, date_iso AS dateIso
               FROM release_files ORDER BY date_iso ${order}, id ${order} LIMIT 1`
          )
          .get() as FactsFile;
      const firstDizRow = db
        .prepare(
          `SELECT filename, dir_no AS dirNo, file_no AS fileNo, date_iso AS dateIso,
                  LENGTH(raw_desc) - LENGTH(REPLACE(raw_desc, CHAR(10), '')) + 1 AS lines,
                  raw_desc AS rawDesc
             FROM release_files
            WHERE LENGTH(raw_desc) - LENGTH(REPLACE(raw_desc, CHAR(10), '')) + 1 >= 4
              -- LIKE underscore is a wildcard, so the underscore run is
              -- ESCAPEd (the rest are literal). Unescaped, it would match
              -- any 4+ characters, i.e. every row.
              AND (raw_desc LIKE '%\\_\\_\\_\\_%' ESCAPE '\\' OR raw_desc LIKE '%****%'
                -- Dashes need 8+: prose uses short runs for emphasis
                -- ("Animation By ----Animator---"), boxes use dozens.
                OR raw_desc LIKE '%--------%'
                OR raw_desc LIKE '%++++%' OR raw_desc LIKE '%||||%' OR raw_desc LIKE '%¼%'
                OR raw_desc LIKE '%────%' OR raw_desc LIKE '%====%')
              -- Same file twice with two dates means at least one date is a
              -- BBS typo: neither row may claim a "first". (Different sizes
              -- are different builds and keep their dates.)
              AND NOT EXISTS (
                SELECT 1 FROM release_files twin
                 WHERE twin.filename = release_files.filename
                   AND COALESCE(twin.size_bytes, -1) = COALESCE(release_files.size_bytes, -1)
                   AND twin.date_iso <> release_files.date_iso
              )
            ORDER BY date_iso ASC, id ASC LIMIT 1`
        )
        .get() as ((FactsFile & { lines: number; rawDesc: string }) | undefined);
      const peakYear = db
        .prepare(
          `SELECT substr(date_iso, 1, 4) AS year, COUNT(*) AS n
             FROM release_files GROUP BY year ORDER BY n DESC LIMIT 1`
        )
        .get() as { year: string; n: number };
      const peakMonth = db
        .prepare(
          `SELECT substr(date_iso, 1, 7) AS month, COUNT(*) AS n
             FROM release_files GROUP BY month ORDER BY n DESC LIMIT 1`
        )
        .get() as { month: string; n: number };
      const extSums = FACT_EXTS.map((e) => `SUM(CASE WHEN filename LIKE '%.${e}' THEN 1 ELSE 0 END) AS "${e}"`).join(
        ', '
      );
      const extRow = db.prepare(`SELECT ${extSums} FROM release_files`).get() as Record<string, number>;
      const topExt = FACT_EXTS.map((ext) => ({ ext: `.${ext}`, n: extRow[ext] ?? 0 }))
        .filter((r) => r.n > 0)
        .sort((a, b) => b.n - a.n);
      const crossoverRows = db
        .prepare(
          `SELECT substr(date_iso, 1, 4) AS y,
                  SUM(CASE WHEN filename LIKE '%.DMS' THEN 1 ELSE 0 END) AS dms,
                  SUM(CASE WHEN filename LIKE '%.LHA' THEN 1 ELSE 0 END) AS lha
             FROM release_files GROUP BY y ORDER BY y`
        )
        .all() as { y: string; dms: number; lha: number }[];
      const crossover = crossoverRows.find((r) => r.dms > 0 && r.lha > r.dms) ?? null;
      const wdRows = db
        .prepare(
          `SELECT CAST(strftime('%w', date_iso) AS INTEGER) AS wd, COUNT(*) AS n
             FROM release_files GROUP BY wd`
        )
        .all() as { wd: number; n: number }[];
      const counts = [0, 0, 0, 0, 0, 0, 0];
      for (const r of wdRows) counts[r.wd] = r.n;
      const topWd = counts.indexOf(Math.max(...counts));
      const biggest = db
        .prepare(
          `SELECT filename, dir_no AS dirNo, file_no AS fileNo, date_iso AS dateIso, size_bytes AS sizeBytes
             FROM release_files WHERE size_bytes IS NOT NULL ORDER BY size_bytes DESC LIMIT 1`
        )
        .get() as ((FactsFile & { sizeBytes: number }) | undefined);
      const longest = db
        .prepare(
          `SELECT filename, dir_no AS dirNo, file_no AS fileNo, date_iso AS dateIso,
                  LENGTH(raw_desc) AS chars,
                  LENGTH(raw_desc) - LENGTH(REPLACE(raw_desc, CHAR(10), '')) + 1 AS lines
             FROM release_files ORDER BY chars DESC LIMIT 1`
        )
        .get() as ((FactsFile & { chars: number; lines: number }) | undefined);
      const mostDl = db
        .prepare(
          `SELECT filename, dir_no AS dirNo, file_no AS fileNo, date_iso AS dateIso, dl_count AS dlCount
             FROM release_files WHERE dl_count IS NOT NULL ORDER BY dl_count DESC LIMIT 1`
        )
        .get() as ((FactsFile & { dlCount: number }) | undefined);
      const sized = (db.prepare('SELECT COUNT(*) AS n FROM release_files WHERE size_bytes IS NOT NULL').get() as {
        n: number;
      }).n;
      const medianSize =
        sized === 0
          ? null
          : (db
              .prepare('SELECT size_bytes AS v FROM release_files WHERE size_bytes IS NOT NULL ORDER BY v LIMIT 1 OFFSET ?')
              .get(Math.floor((sized - 1) / 2)) as { v: number }).v;
      const futureCount = (
        db.prepare(`SELECT COUNT(*) AS n FROM release_files WHERE date_iso > date('now')`).get() as { n: number }
      ).n;
      return {
        span: { firstDate: span.firstDate, lastDate: span.lastDate, firstFile: fileBy('ASC'), lastFile: fileBy('DESC') },
        firstDiz: firstDizRow ?? null,
        peakYear,
        peakMonth,
        topExt,
        extCrossover: crossover ? { year: crossover.y } : null,
        weekday: { day: WEEKDAYS[topWd], counts },
        biggest: biggest ?? null,
        longestDesc: longest ?? null,
        mostDownloaded: mostDl ?? null,
        medianSize,
        futureCount,
      };
    },
    { readonly: true }
  );
}

export function listReleaseGroups(rel: ReleasesConfig): { abbreviation: string; fullName: string; files: number }[] {
  return withReleasesDb(
    rel,
    (db) =>
      db
        .prepare(
          `SELECT release_group AS abbreviation, release_group_full AS fullName, COUNT(*) AS files
             FROM release_files WHERE release_group IS NOT NULL
             GROUP BY release_group ORDER BY files DESC`
        )
        .all() as { abbreviation: string; fullName: string; files: number }[],
    { readonly: true }
  );
}

/**
 * One random file entry, full columns. For "surprise me" callers (chat bots
 * included): no parameters, no filters.
 */
export function getRandomRelease(rel: ReleasesConfig): ReleaseRow | null {
  return withReleasesDb(
    rel,
    (db) =>
      (db.prepare(`SELECT ${ALL_COLUMNS} FROM release_files ORDER BY RANDOM() LIMIT 1`).get() as
        | ReleaseRow
        | undefined) ?? null,
    { readonly: true }
  );
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
