/**
 * The JSON API the web browser reads: search, sort, page, one door in full,
 * and a live stream of catalog revisions.
 *
 * Kept out of routes.ts on purpose. That file is the byte-exact contract the
 * AmigaDOS clients and uhcsearch depend on; this one is free to grow.
 *
 * Everything here is public and read-only. Nothing in it needs a login,
 * because browsing, searching and downloading the door corpus is the point
 * of the site.
 */
import express, { type Request, type Response, type Router } from 'express';
import * as crypto from 'crypto';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { getCatalogRevision, getArchiveFiles, getCatalogEntryByArchive } from './catalog';
import { analyseDoor, buildGroupTags, readName, type NameSource } from './describe';
import { applyOverrides, hiddenExclusion, isOverridden, loadOverrides, type OverrideMap } from './effective';
import { AmigaGuideParser } from './amigaguide-parser';
import { UploadError, discardBody, receiveUpload, storeSubmission } from './submissions';
import { isMatchAllGlob } from './ami-stripper';
import type { ServerConfig } from './config';

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;

/**
 * Sort keys are an allowlist mapped to SQL, never interpolated from the
 * query string: `sort` reaches this straight from a URL.
 */
const SORT_COLUMNS: Record<string, string> = {
  name: 'name COLLATE NOCASE',
  archive: 'archive_name COLLATE NOCASE',
  size: 'archive_size',
  author: 'author COLLATE NOCASE',
  group: 'release_group COLLATE NOCASE',
  type: 'door_type COLLATE NOCASE',
  category: 'category COLLATE NOCASE',
  requires: 'requires_bbs COLLATE NOCASE',
  version: 'version COLLATE NOCASE',
  indexed: 'indexed_at',
  votes: '(COALESCE(v.up, 0) - COALESCE(v.down, 0))',
};

interface DoorRow {
  id: string;
  archive_name: string;
  archive_path: string;
  binary_name: string | null;
  door_type: string;
  name: string;
  version: string | null;
  author: string | null;
  release_group: string | null;
  release_group_full_name: string | null;
  category: string | null;
  description: string | null;
  requires_bbs: string | null;
  file_id_diz: string | null;
  archive_size: number | null;
  md5: string | null;
  sha256: string | null;
  junk_count: number;
  ads_stripped: number;
  indexed_at: number;
  has_doc: number;
  votes_up: number;
  votes_down: number;
  release_date: string | null;
  platform: string | null;
  download_url: string | null;
  credits: string | null;
  external_links: string | null;
  screenshots: string | null;
  demozoo_url: string | null;
}

function firstPathSegment(archivePath: string): string {
  const slash = archivePath.indexOf('/');
  return slash === -1 ? 'Unsorted' : archivePath.slice(0, slash);
}

function hasReleaseGroupsTable(db: Database.Database): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'release_groups'")
    .get();
}

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function strParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

interface DoorJson {
  archiveName: string;
  system: string;
  /** A short label fit for a column: never the DIZ's border art. */
  name: string;
  /** What the corpus scan put in the `name` column, art and all. */
  catalogName: string;
  /** Where the displayed name came from: 'archive' means it is a guess. */
  nameSource: NameSource;
  description: string | null;
  descriptionSource: 'edited' | 'diz';
  version: string | null;
  author: string | null;
  releaseGroup: string | null;
  releaseGroupFullName: string | null;
  category: string | null;
  doorType: string;
  requiresBbs: string | null;
  size: number;
  md5: string | null;
  sha256: string | null;
  junkCount: number;
  adsStripped: boolean;
  hasDoc: boolean;
  downloadUrl: string;
  votesUp: number;
  votesDown: number;
  indexedAt: number;
  releaseDate: string | null;
  platform: string | null;
  credits: DemozooCredit[] | null;
  externalLinks: string[] | null;
  screenshots: { thumbnailUrl: string; standardUrl: string }[] | null;
  demozooUrl: string | null;
}

interface DemozooCredit {
  nick: string;
  category: string;
  role: string;
}

/**
 * One row as the web sees it: human corrections applied, and a description
 * that is either what a person wrote or what the classifier read out of the
 * DIZ - `descriptionSource` says which, so the UI can show it.
 */
function toJson(row: DoorRow, overrides: OverrideMap, groupTags: ReadonlySet<string>): DoorJson {
  const corrected = applyOverrides(row, row.id, overrides);
  const edited = isOverridden(row.id, 'description', overrides);
  const nameEdited = isOverridden(row.id, 'name', overrides);
  const facts = analyseDoor(
    {
      dizText: corrected.file_id_diz,
      name: corrected.name,
      archiveName: corrected.archive_name,
      binaryName: corrected.binary_name,
      catalogVersion: corrected.version,
      catalogAuthor: corrected.author,
    },
    groupTags
  );
  const named = readName(corrected.name, corrected.binary_name, corrected.archive_name, groupTags);
  const system = firstPathSegment(corrected.archive_path);
  return {
    archiveName: corrected.archive_name,
    system,
    name: named.name,
    catalogName: corrected.name,
    nameSource: nameEdited ? 'catalog' : named.source,
    description: edited ? (corrected.description || null) : facts.description,
    descriptionSource: edited ? 'edited' : 'diz',
    version: corrected.version ?? facts.version ?? null,
    author: corrected.author ?? (facts.author || null),
    releaseGroup: corrected.release_group,
    releaseGroupFullName: corrected.release_group_full_name,
    category: corrected.category,
    doorType: corrected.door_type,
    requiresBbs: corrected.requires_bbs ?? (facts.requiresBbs || null),
    size: corrected.archive_size ?? 0,
    md5: corrected.md5,
    sha256: corrected.sha256,
    junkCount: corrected.junk_count ?? 0,
    adsStripped: corrected.ads_stripped === 1,
    hasDoc: corrected.has_doc === 1,
    downloadUrl: `/api/door-repo/archive/${encodeURIComponent(corrected.archive_name)}`,
    votesUp: corrected.votes_up ?? 0,
    votesDown: corrected.votes_down ?? 0,
    indexedAt: corrected.indexed_at ?? 0,
    releaseDate: corrected.release_date ?? null,
    platform: corrected.platform ?? null,
    credits: parseJsonOrNull<DemozooCredit[]>(corrected.credits),
    externalLinks: parseJsonOrNull<string[]>(corrected.external_links),
    screenshots: parseJsonOrNull<{ thumbnailUrl: string; standardUrl: string }[]>(corrected.screenshots),
    demozooUrl: corrected.demozoo_url ?? null,
  };
}

/** A column written as JSON by the Demozoo importer. Return null for empty
 *  strings or anything JSON.parse refuses: the door's row was scanned before
 *  the column existed, so the value will be NULL, and a stray empty string
 *  should not be turned into a meaningless "[]". */
function parseJsonOrNull<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * 1125 of the 3218 documented doors ship an AmigaGuide file rather than a
 * plain README: hypertext with @node sections and links between them. Served
 * raw it reads as markup.
 */
function isAmigaGuide(doc: string | null): boolean {
  return Boolean(doc && /^\s*@database\b/i.test(doc));
}

interface GuideJson {
  database: string;
  mainNode: string;
  nodes: { name: string; title: string; content: string; links: { text: string; target: string }[] }[];
}

/** The document as nodes the browser can walk, or null when it is not one. */
function parseGuide(doc: string | null): GuideJson | null {
  if (!isAmigaGuide(doc)) return null;
  try {
    const parser = new AmigaGuideParser();
    const parsed = parser.parse(doc as string);
    return {
      database: parsed.database,
      mainNode: parsed.mainNode,
      nodes: Array.from(parsed.nodes.values()).map((node) => ({
        name: node.name,
        title: node.title,
        content: parser.stripInlineMarkup(node.content),
        links: node.links.map((link) => ({ text: link.text, target: link.target })),
      })),
    };
  } catch {
    // A malformed guide is still readable as text; it must never 500 the
    // door's own page.
    return null;
  }
}

export function createPublicRouter(cfg: ServerConfig): Router {
  const router = express.Router();

  router.get('/doors', (req: Request, res: Response) => {
    const q = strParam(req.query.q);
    const type = strParam(req.query.type);
    const system = strParam(req.query.system);
    const requires = strParam(req.query.requires);
    const category = strParam(req.query.category);
    const latest = strParam(req.query.latest) === '1';
    const unstripped = strParam(req.query.unstripped) === '1';
    const page = intParam(req.query.page, 1, 1, 100000);
    const perPage = intParam(req.query.per_page, DEFAULT_PER_PAGE, 1, MAX_PER_PAGE);
    const sortKey = strParam(req.query.sort) ?? 'indexed';
    const sort = SORT_COLUMNS[sortKey] ?? SORT_COLUMNS.indexed;
    const dir = strParam(req.query.dir)?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (type) {
      where.push('door_type = ?');
      params.push(type);
    }
    if (category) {
      where.push('category = ?');
      params.push(category);
    }
    if (requires) {
      where.push('requires_bbs = ?');
      params.push(requires);
    }
    if (unstripped) {
      where.push('ads_stripped = 0');
    }
    if (system) {
      // The system is the first path segment; "Unsorted" means there is none.
      if (system === 'Unsorted') {
        where.push("archive_path NOT LIKE '%/%'");
      } else {
        where.push('archive_path LIKE ?');
        params.push(`${system}/%`);
      }
    }
    if (q) {
      const like = `%${q}%`;
      where.push(
        '(archive_name LIKE ? OR name LIKE ? OR author LIKE ? OR release_group LIKE ? OR description LIKE ? OR file_id_diz LIKE ?)'
      );
      params.push(like, like, like, like, like, like);
    }
    // Where a name came from is DERIVED, not stored, so this one filter
    // cannot be a WHERE clause: the rows are read, read-named, filtered and
    // only then paged. It costs a full scan, and only when it is asked for -
    // it exists so a curator can work through the names that are guesses.
    const nameSource = strParam(req.query.name_source);

    const db = openDb(cfg, { readonly: true });
    try {
      const hidden = hiddenExclusion(db);
      if (hidden) where.push(hidden);
      const releaseGroupsTable = hasReleaseGroupsTable(db);
      // When latest=1, only show the most recently indexed door per unique name+author.
      if (latest) {
        where.push(`d.indexed_at = (SELECT MAX(d2.indexed_at) FROM door_catalog d2 WHERE d2.name = d.name AND COALESCE(d2.author, '') = COALESCE(d.author, ''))`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const SELECT_ROW = `SELECT d.id, archive_name, archive_path, binary_name, door_type, name, version, author,
                  d.release_group, ${releaseGroupsTable ? 'rg.full_name' : 'NULL'} AS release_group_full_name,
                  category, description, requires_bbs, file_id_diz, archive_size,
                  md5, sha256, junk_count, ads_stripped, indexed_at,
                  (CASE WHEN doc_raw IS NOT NULL AND doc_raw <> '' THEN 1 ELSE 0 END) AS has_doc,
                  COALESCE(v.up, 0) AS votes_up, COALESCE(v.down, 0) AS votes_down,
                  release_date, platform, download_url, credits, external_links, screenshots, demozoo_url
             FROM door_catalog d
             ${releaseGroupsTable ? 'LEFT JOIN release_groups rg ON rg.abbreviation = d.release_group' : ''}
             LEFT JOIN (SELECT catalog_id,
                               SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up,
                               SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down
                        FROM door_votes GROUP BY catalog_id) v ON v.catalog_id = d.id
             ${whereSql}
             ORDER BY ${sort} ${dir}, archive_name COLLATE NOCASE ASC`;

      let total: number;
      let rows: DoorRow[];
      let filterBySource: ((row: DoorRow) => boolean) | null = null;

      // Group tags come from the WHOLE catalog, not the page: a prefix is a
      // release tag only if three or more archives carry it, and one page of
      // 50 rows would recognise almost none of them.
      const allNames = (
        db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[]
      ).map((r) => r.archive_name);
      const groupTags = buildGroupTags(allNames);
      const overrides = loadOverrides(db);

      if (nameSource) {
        filterBySource = (row) =>
          readName(
            applyOverrides(row, row.id, overrides).name,
            row.binary_name,
            row.archive_name,
            groupTags
          ).source === nameSource;
        const matching = (db.prepare(SELECT_ROW).all(...params) as DoorRow[]).filter(filterBySource);
        total = matching.length;
        rows = matching.slice((page - 1) * perPage, page * perPage);
      } else {
        total = (
          db.prepare(`SELECT COUNT(*) AS n FROM door_catalog d ${whereSql}`).get(...params) as { n: number }
        ).n;
        rows = db.prepare(`${SELECT_ROW} LIMIT ? OFFSET ?`).all(...params, perPage, (page - 1) * perPage) as DoorRow[];
      }

      res.json({
        revision: getCatalogRevision(cfg),
        total,
        page,
        perPage,
        sort: sortKey,
        dir: dir.toLowerCase(),
        rows: rows.map((row) => toJson(row, overrides, groupTags)),
      });
    } finally {
      db.close();
    }
  });

  /** Everything about one door, including the full FILE_ID.DIZ and file list. */
  router.get('/doors/:archiveName', (req: Request, res: Response) => {
    // Express 5 types a wildcard-free param as string | string[]; a repeated
    // path segment is not a door name.
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const entry = archiveName ? getCatalogEntryByArchive(cfg, archiveName) : null;
    if (!entry) {
      res.status(404).json({ error: 'no such door' });
      return;
    }
    const db = openDb(cfg, { readonly: true });
    let groupTags: ReadonlySet<string>;
    let overrides: OverrideMap;
    let releaseGroupFullName: string | null = null;
    let votesUp = 0;
    let votesDown = 0;
    try {
      groupTags = buildGroupTags(
        (db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[]).map(
          (r) => r.archive_name
        )
      );
      overrides = loadOverrides(db);
      if (entry.release_group) {
        const rgRow = db
          .prepare('SELECT full_name FROM release_groups WHERE abbreviation = ?')
          .get(entry.release_group) as { full_name: string } | undefined;
        releaseGroupFullName = rgRow?.full_name ?? null;
      }
      // Get vote counts
      const catId = (entry as unknown as { id: string }).id;
      if (catId) {
        const counts = db
          .prepare('SELECT vote, COUNT(*) AS n FROM door_votes WHERE catalog_id = ? GROUP BY vote')
          .all(catId) as { vote: number; n: number }[];
        votesUp = counts.find((c) => c.vote === 1)?.n ?? 0;
        votesDown = counts.find((c) => c.vote === -1)?.n ?? 0;
      }
    } finally {
      db.close();
    }

    const row: DoorRow = {
      ...entry,
      release_group_full_name: releaseGroupFullName,
      archive_size: entry.archive_size,
      requires_bbs: (entry as unknown as { requires_bbs?: string | null }).requires_bbs ?? null,
      indexed_at: 0,
      has_doc: entry.doc_raw && entry.doc_raw.length > 0 ? 1 : 0,
      votes_up: votesUp,
      votes_down: votesDown,
      demozoo_url: (entry as unknown as { demozoo_url?: string | null }).demozoo_url ?? null,
    };

    res.json({
      ...toJson(row, overrides, groupTags),
      // The raw DIZ and doc are what a sysop actually wants to read before
      // installing a door, and the admin UI shows them side by side with the
      // classifier's answer.
      fileIdDiz: entry.file_id_diz,
      docFilename: entry.doc_filename,
      doc: entry.doc_raw,
      suggestedTooltypes: entry.suggested_tooltypes,
      docFormat: isAmigaGuide(entry.doc_raw) ? 'amigaguide' : 'text',
      guide: parseGuide(entry.doc_raw),
      files: getArchiveFiles(cfg, entry.id).map((f) => ({
        path: f.path,
        size: f.size,
        isJunk: f.is_junk === 1,
        junkReason: f.junk_reason,
      })),
    });
  });

  /** What the filter dropdowns offer, with counts. */
  router.get('/facets', (_req: Request, res: Response) => {
    const db = openDb(cfg, { readonly: true });
    try {
      const hidden = hiddenExclusion(db);
      const visible = hidden ? `WHERE ${hidden}` : '';
      const andVisible = hidden ? `AND ${hidden}` : '';
      const counted = (sql: string) => db.prepare(sql).all() as { value: string | null; n: number }[];
      res.json({
        revision: getCatalogRevision(cfg),
        systems: counted(
          `SELECT CASE WHEN instr(archive_path, '/') > 0
                       THEN substr(archive_path, 1, instr(archive_path, '/') - 1)
                       ELSE 'Unsorted' END AS value,
                  COUNT(*) AS n
             FROM door_catalog ${visible} GROUP BY value ORDER BY n DESC`
        ),
        types: counted(
          `SELECT door_type AS value, COUNT(*) AS n FROM door_catalog ${visible} GROUP BY value ORDER BY n DESC`
        ),
        categories: counted(
          `SELECT category AS value, COUNT(*) AS n FROM door_catalog
            WHERE category IS NOT NULL AND category <> '' ${andVisible} GROUP BY value ORDER BY n DESC`
        ),
        requires: counted(
          `SELECT requires_bbs AS value, COUNT(*) AS n FROM door_catalog
            WHERE requires_bbs IS NOT NULL AND requires_bbs <> '' ${andVisible} GROUP BY value ORDER BY n DESC`
        ),
      });
    } finally {
      db.close();
    }
  });

  /** Aggregated statistics for the dashboard. */
  router.get('/stats', (_req: Request, res: Response) => {
    const db = openDb(cfg, { readonly: true });
    try {
      const hidden = hiddenExclusion(db);
      const visible = hidden ? `WHERE ${hidden}` : '';
      const andVisible = hidden ? `AND ${hidden}` : '';
      const one = (sql: string, ...params: unknown[]): number =>
        (db.prepare(sql).get(...params) as { n: number }).n;
      const all = (sql: string, ...params: unknown[]): { value: string | null; n: number }[] =>
        db.prepare(sql).all(...params) as { value: string | null; n: number }[];

      const total = one(`SELECT COUNT(*) AS n FROM door_catalog ${visible}`);
      const hiddenCount = one('SELECT COUNT(*) AS n FROM door_hidden');
      const withDoc = one(
        `SELECT COUNT(*) AS n FROM door_catalog ${visible ? `WHERE doc_raw IS NOT NULL AND doc_raw <> '' ${andVisible}` : `WHERE doc_raw IS NOT NULL AND doc_raw <> ''`}`
      );

      const bySystem = all(
        `SELECT CASE WHEN instr(archive_path, '/') > 0
                     THEN substr(archive_path, 1, instr(archive_path, '/') - 1)
                     ELSE 'Unsorted' END AS value,
                COUNT(*) AS n
           FROM door_catalog ${visible} GROUP BY value ORDER BY n DESC`
      );

      // Group / category / author stats: drop the empty-string and NULL
      // buckets. They crowd the top of the chart ('None' / 'Unknown' is
      // usually 30%+ of the catalog because the scan pipeline doesn't
      // always fill these in). A real value the admin can act on
      // (top 20 named groups) is more useful than the missing-data
      // placeholder. `visible` is either '' or a 'WHERE <hidden-excl>'
      // clause, so we add the non-null check as an AND clause when it's
      // present and as WHERE otherwise.
      const groupCond = `release_group IS NOT NULL AND release_group != ''`;
      const byGroup = all(
        `SELECT d.release_group AS value, COUNT(*) AS n
           FROM door_catalog d ${visible ? `${visible} AND d.${groupCond}` : `WHERE d.${groupCond}`}
           GROUP BY value ORDER BY n DESC LIMIT 20`
      );

      const categoryCond = `category IS NOT NULL AND category != ''`;
      const byCategory = all(
        `SELECT category AS value, COUNT(*) AS n
           FROM door_catalog ${visible ? `${visible} AND ${categoryCond}` : `WHERE ${categoryCond}`}
           GROUP BY value ORDER BY n DESC`
      );

      const byType = all(
        `SELECT door_type AS value, COUNT(*) AS n
           FROM door_catalog ${visible} GROUP BY value ORDER BY n DESC`
      );

      // A DIZ credit line ("coded by X" / "X Presents") names the RELEASE
      // GROUP at least as often as it names an individual - the scene's
      // convention is group credit, not solo attribution - and free text
      // gives no structural way to tell the two apart. release_groups.full_name
      // is a curated list of known group names (from release_group lookups
      // elsewhere in the pipeline), so anything on it here is a group that
      // leaked into `author`, not a real "top author".
      const authorCond = `author IS NOT NULL AND author != ''
        AND NOT EXISTS (SELECT 1 FROM release_groups rg WHERE rg.full_name = author COLLATE NOCASE)`;
      const byAuthor = all(
        `SELECT author AS value, COUNT(*) AS n
           FROM door_catalog ${visible ? `${visible} AND ${authorCond}` : `WHERE ${authorCond}`}
           GROUP BY value ORDER BY n DESC LIMIT 20`
      );

      const sizeDistribution = all(
        `SELECT
           CASE
             WHEN archive_size < 10240 THEN '< 10 KB'
             WHEN archive_size < 102400 THEN '10-100 KB'
             WHEN archive_size < 1048576 THEN '100 KB - 1 MB'
             WHEN archive_size < 10485760 THEN '1-10 MB'
             ELSE '10+ MB'
           END AS value,
           COUNT(*) AS n
         FROM door_catalog ${visible} GROUP BY value ORDER BY MIN(archive_size)`
      );

      const indexedOverTime = all(
        `SELECT strftime('%Y-%m', indexed_at, 'unixepoch') AS value, COUNT(*) AS n
           FROM door_catalog ${visible} GROUP BY value ORDER BY value`
      );

      res.json({
        total,
        hiddenCount,
        withDoc,
        bySystem,
        byGroup,
        byCategory,
        byType,
        byAuthor,
        sizeDistribution,
        indexedOverTime,
      });
    } finally {
      db.close();
    }
  });

  /** Export catalog as CSV for offline use. */
  router.get('/export.csv', (_req: Request, res: Response) => {
    const db = openDb(cfg, { readonly: true });
    try {
      const hidden = hiddenExclusion(db);
      const visible = hidden ? `WHERE ${hidden}` : '';
      const rows = db
        .prepare(
          `SELECT d.archive_name, d.archive_path, d.door_type, d.name, d.version, d.author,
                  d.release_group, ${hasReleaseGroupsTable(db) ? 'rg.full_name' : 'NULL'} AS release_group_full_name,
                  d.category, d.description, d.requires_bbs, d.archive_size, d.md5, d.sha256
             FROM door_catalog d
             ${hasReleaseGroupsTable(db) ? 'LEFT JOIN release_groups rg ON rg.abbreviation = d.release_group' : ''}
             ${visible}
             ORDER BY d.archive_name COLLATE NOCASE ASC`
        )
        .all() as Record<string, unknown>[];

      const headers = [
        'archive_name', 'archive_path', 'door_type', 'name', 'version', 'author',
        'release_group', 'release_group_full_name', 'category', 'description',
        'requires_bbs', 'archive_size', 'md5', 'sha256',
      ];

      const escape = (v: unknown): string => {
        const s = v == null ? '' : String(v);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };

      const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="door-catalog.csv"');
      res.send(csv);
    } finally {
      db.close();
    }
  });

  /**
   * Send in a door. Anyone may; nobody publishes. The file waits in
   * quarantine until a curator approves it - see src/submissions.ts for what
   * is checked before it reaches disk.
   */
  router.post('/submissions', (req: Request, res: Response) => {
    void (async () => {
      const db = openDb(cfg);
      try {
        const upload = await receiveUpload(req);
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        const stored = storeSubmission(db, cfg, upload, ip);
        res.status(202).json({
          ok: true,
          id: stored.id,
          archiveName: stored.archiveName,
          size: stored.size,
          message: 'Thank you - it is in the queue and a curator will look at it.',
        });
      } catch (error) {
        if (error instanceof UploadError) {
          res.status(error.status).json({ error: error.message });
          // The refusal is worth reading, so let the upload finish arriving
          // rather than closing the socket under it.
          discardBody(req);
          return;
        }
        // eslint-disable-next-line no-console
        console.log(`[door-repo] WARN submission failed: ${(error as Error).message}`);
        res.status(500).json({ error: 'that upload could not be stored' });
      } finally {
        db.close();
      }
    })();
  });

  router.get('/release-groups', (_req: Request, res: Response) => {
    const db = openDb(cfg, { readonly: true });
    try {
      const hasTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='release_groups'")
        .get();
      if (!hasTable) {
        res.json({ groups: [] });
        return;
      }
      const rows = db
        .prepare('SELECT abbreviation, full_name FROM release_groups ORDER BY abbreviation')
        .all() as { abbreviation: string; full_name: string }[];
      res.json({ groups: rows });
    } finally {
      db.close();
    }
  });

  /**
   * GET /api/door-repo/learned-patterns — read-only list of learned junk
   * patterns for Amiga clients (doorrepo.c) and other consumers.  No auth
   * required: this is public read-only data that helps clients classify
   * files locally.
   */
  router.get('/learned-patterns', (_req: Request, res: Response) => {
    const db = openDb(cfg, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, pattern, archive_name, file_path, learned_by, created_at
             FROM learned_junk_patterns ORDER BY created_at DESC`
        )
        .all() as {
          id: number;
          pattern: string;
          archive_name: string | null;
          file_path: string | null;
          learned_by: string | null;
          created_at: number;
        }[];
      res.json({ patterns: rows });
    } finally {
      db.close();
    }
  });

  router.get('/events', (req: Request, res: Response) => subscribe(cfg, req, res));

  mountLearnRoute(router, cfg);

  return router;
}

// ─── live revision stream ───────────────────────────────────────────────
//
// One poller for the whole process, not one per client: the revision is a
// single SELECT, but 50 open tabs polling it individually would be 50 file
// opens a second. Clients get a message only when the revision actually
// changes, plus a comment line every 25 seconds so an idle connection is not
// closed by a proxy.

const clients = new Set<Response>();
let poller: NodeJS.Timeout | null = null;
let lastRevision: string | null = null;

/**
 * Pushes a bulk-job progress update over the same SSE connections the
 * catalog-revision broadcast already uses - one open connection per
 * browser tab, not a second stream per job.
 */
export function broadcastJobEvent(payload: {
  jobId: string;
  status: string;
  completed: number;
  total: number;
  failedCount: number;
}): void {
  for (const client of clients) {
    client.write(`event: job\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

const POLL_MS = 2000;
const KEEPALIVE_MS = 25000;

function startPolling(cfg: ServerConfig): void {
  if (poller) return;
  lastRevision = getCatalogRevision(cfg);
  poller = setInterval(() => {
    const revision = getCatalogRevision(cfg);
    if (revision === lastRevision) return;
    lastRevision = revision;
    for (const client of clients) {
      client.write(`event: revision\ndata: ${JSON.stringify({ revision })}\n\n`);
    }
  }, POLL_MS);
  // Never hold the process open for a poller; it exists only to serve
  // clients that are already connected.
  poller.unref?.();
}

function stopPollingIfIdle(): void {
  if (clients.size === 0 && poller) {
    clearInterval(poller);
    poller = null;
    lastRevision = null;
  }
}

function subscribe(cfg: ServerConfig, req: Request, res: Response): void {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Caddy and nginx both buffer by default, which would hold every event
    // until the connection closed.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const revision = getCatalogRevision(cfg);
  res.write(`event: revision\ndata: ${JSON.stringify({ revision })}\n\n`);

  clients.add(res);
  startPolling(cfg);

  const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
  keepalive.unref?.();

  req.on('close', () => {
    clearInterval(keepalive);
    clients.delete(res);
    stopPollingIfIdle();
    res.end();
  });
}

/** Exported for tests: drop every subscriber and stop the poller. */
export function _closeEventStreamsForTests(): void {
  for (const client of clients) client.end();
  clients.clear();
  if (poller) {
    clearInterval(poller);
    poller = null;
    lastRevision = null;
  }
}

// ─── Public learn endpoint (DOORMAN / external clients) ────────────────

/**
 * POST /api/learn — teach the classifier a new junk pattern.
 * Authenticated via X-Learn-Key header matching DOORREPO_LEARN_KEY env var.
 * This lets DOORMAN and other external clients contribute patterns without
 * needing a full admin JWT session.
 */
export function mountLearnRoute(router: Router, cfg: ServerConfig): void {
  router.post('/learn', express.json({ limit: '16kb' }), (req: Request, res: Response) => {
    if (!cfg.learnKey) {
      res.status(503).json({ error: 'learn API disabled: DOORREPO_LEARN_KEY is not set' });
      return;
    }
    const providedKey = req.headers['x-learn-key'];
    if (typeof providedKey !== 'string' || providedKey !== cfg.learnKey) {
      res.status(401).json({ error: 'invalid or missing X-Learn-Key header' });
      return;
    }
    const body = (req.body ?? {}) as { pattern?: unknown; archiveName?: unknown; filePath?: unknown };
    const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : '';
    if (!pattern) {
      res.status(400).json({ error: 'pattern is required' });
      return;
    }
    // Same guard as the admin /learn route: a bare '*'/'?' pattern would
    // mark every future archive's preview as all-junk.
    if (isMatchAllGlob(pattern)) {
      res.status(400).json({ error: `pattern '${pattern}' would match every file - refuse to learn` });
      return;
    }
    const archiveName = typeof body.archiveName === 'string' ? body.archiveName : null;
    const filePath = typeof body.filePath === 'string' ? body.filePath : null;
    const db = openDb(cfg);
    try {
      const existing = db
        .prepare('SELECT id FROM learned_junk_patterns WHERE pattern = ? COLLATE NOCASE')
        .get(pattern) as { id: number } | undefined;
      if (existing) {
        res.json({ ok: true, id: existing.id, duplicate: true });
        return;
      }
      const info = db
        .prepare('INSERT INTO learned_junk_patterns (pattern, archive_name, file_path, learned_by) VALUES (?, ?, ?, ?)')
        .run(pattern, archiveName, filePath, 'doorman');
      res.json({ ok: true, id: Number(info.lastInsertRowid), duplicate: false });
    } finally {
      db.close();
    }
  });

  // ─── votes ────────────────────────────────────────────────────────────

  /** Derive a per-visitor voter ID from a persistent cookie. */
  function voterId(req: Request, res: Response): string {
    // Parse voter_id from Cookie header manually (no cookie-parser dep).
    let vid: string | undefined;
    const cookieHeader = req.headers.cookie ?? '';
    for (const pair of cookieHeader.split(';')) {
      const [key, val] = pair.trim().split('=');
      if (key === 'voter_id' && val) { vid = val; break; }
    }
    if (!vid) {
      vid = crypto.randomBytes(16).toString('hex');
      // Set cookie: 1 year, same-site lax, path /
      res.setHeader('Set-Cookie', `voter_id=${vid}; Max-Age=${365 * 24 * 3600}; Path=/; SameSite=Lax`);
    }
    return vid;
  }

  /** GET /doors/:archiveName/votes — vote counts + this visitor's vote. */
  router.get('/doors/:archiveName/votes', (req: Request, res: Response) => {
    const archiveName = req.params.archiveName;
    const db = openDb(cfg);
    try {
      const row = db
        .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string } | undefined;
      if (!row) { res.status(404).json({ error: 'no such door' }); return; }

      const counts = db
        .prepare('SELECT vote, COUNT(*) AS n FROM door_votes WHERE catalog_id = ? GROUP BY vote')
        .all(row.id) as { vote: number; n: number }[];
      const up = counts.find((c) => c.vote === 1)?.n ?? 0;
      const down = counts.find((c) => c.vote === -1)?.n ?? 0;

      const vid = voterId(req, res);
      const mine = db
        .prepare('SELECT vote FROM door_votes WHERE catalog_id = ? AND voter_id = ?')
        .get(row.id, vid) as { vote: number } | undefined;

      res.json({ up, down, score: up - down, myVote: mine?.vote ?? 0 });
    } finally {
      db.close();
    }
  });

  /** POST /doors/:archiveName/vote — cast or change a vote. Body: { vote: 1 | -1 | 0 } */
  router.post('/doors/:archiveName/vote', express.json({ limit: '1kb' }), (req: Request, res: Response) => {
    const archiveName = req.params.archiveName;
    const body = (req.body ?? {}) as { vote?: unknown };
    const vote = Number(body.vote);
    if (vote !== 1 && vote !== -1 && vote !== 0) {
      res.status(400).json({ error: 'vote must be 1, -1, or 0' });
      return;
    }
    const db = openDb(cfg);
    try {
      const row = db
        .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string } | undefined;
      if (!row) { res.status(404).json({ error: 'no such door' }); return; }

      const vid = voterId(req, res);
      if (vote === 0) {
        db.prepare('DELETE FROM door_votes WHERE catalog_id = ? AND voter_id = ?').run(row.id, vid);
      } else {
        db.prepare(
          'INSERT INTO door_votes (catalog_id, voter_id, vote) VALUES (?, ?, ?) ON CONFLICT(catalog_id, voter_id) DO UPDATE SET vote = excluded.vote'
        ).run(row.id, vid, vote);
      }

      const counts = db
        .prepare('SELECT vote, COUNT(*) AS n FROM door_votes WHERE catalog_id = ? GROUP BY vote')
        .all(row.id) as { vote: number; n: number }[];
      const up = counts.find((c) => c.vote === 1)?.n ?? 0;
      const down = counts.find((c) => c.vote === -1)?.n ?? 0;

      res.json({ up, down, score: up - down, myVote: vote });
    } finally {
      db.close();
    }
  });
}
