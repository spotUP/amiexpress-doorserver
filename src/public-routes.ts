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
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { getCatalogRevision, getArchiveFiles, getCatalogEntryByArchive } from './catalog';
import { analyseDoor, buildGroupTags, readName, type NameSource } from './describe';
import { applyOverrides, hiddenExclusion, isOverridden, loadOverrides, type OverrideMap } from './effective';
import { AmigaGuideParser } from './amigaguide-parser';
import { UploadError, discardBody, receiveUpload, storeSubmission } from './submissions';
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
  indexed_at: number;
  has_doc: number;
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
  description: string;
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
  hasDoc: boolean;
  downloadUrl: string;
}

/**
 * One row as the web sees it: human corrections applied, and a description
 * that is either what a person wrote or what the classifier read out of the
 * DIZ - `descriptionSource` says which, so the UI can show it.
 */
function toJson(row: DoorRow, overrides: OverrideMap, groupTags: ReadonlySet<string>): DoorJson {
  const corrected = applyOverrides(row, row.id, overrides);
  const edited = isOverridden(row.id, 'description', overrides);
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
    nameSource: named.source,
    description: edited ? corrected.description ?? '' : facts.description,
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
    hasDoc: corrected.has_doc === 1,
    downloadUrl: `/api/door-repo/archive/${encodeURIComponent(corrected.archive_name)}`,
  };
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
        content: node.content,
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
    const page = intParam(req.query.page, 1, 1, 100000);
    const perPage = intParam(req.query.per_page, DEFAULT_PER_PAGE, 1, MAX_PER_PAGE);
    const sortKey = strParam(req.query.sort) ?? 'archive';
    const sort = SORT_COLUMNS[sortKey] ?? SORT_COLUMNS.archive;
    const dir = strParam(req.query.dir)?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

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
      const SELECT_ROW = `SELECT id, archive_name, archive_path, binary_name, door_type, name, version, author,
                  d.release_group, ${releaseGroupsTable ? 'rg.full_name' : 'NULL'} AS release_group_full_name,
                  category, description, requires_bbs, file_id_diz, archive_size,
                  md5, sha256, junk_count, indexed_at,
                  (CASE WHEN doc_raw IS NOT NULL AND doc_raw <> '' THEN 1 ELSE 0 END) AS has_doc
             FROM door_catalog d
             ${releaseGroupsTable ? 'LEFT JOIN release_groups rg ON rg.abbreviation = d.release_group' : ''}
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

      const byGroup = all(
        `SELECT COALESCE(d.release_group, 'None') AS value, COUNT(*) AS n
           FROM door_catalog d ${visible ? `WHERE ${hidden.replace('id', 'd.id')}` : ''}
           GROUP BY value ORDER BY n DESC LIMIT 20`
      );

      const byCategory = all(
        `SELECT COALESCE(category, 'None') AS value, COUNT(*) AS n
           FROM door_catalog ${visible} GROUP BY value ORDER BY n DESC`
      );

      const byType = all(
        `SELECT door_type AS value, COUNT(*) AS n
           FROM door_catalog ${visible} GROUP BY value ORDER BY n DESC`
      );

      const byAuthor = all(
        `SELECT COALESCE(author, 'Unknown') AS value, COUNT(*) AS n
           FROM door_catalog ${visible} GROUP BY value ORDER BY n DESC LIMIT 20`
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

  router.get('/events', (req: Request, res: Response) => subscribe(cfg, req, res));

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
