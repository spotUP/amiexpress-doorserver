/**
 * The releases surface: read-only HTTP over releases.db, beside the door repo.
 *
 *   GET /health        { status, contractVersion, revision, files }
 *   GET /stats         aggregated counts for the dashboard
 *   GET /facts         headline records for the facts page
 *   GET /random        one random ReleaseRow (same shape as /files/:id)
 *   GET /list          JSON ReleaseListResponse (?q=&flag=&dir=&from=&to=&sort=&order=&limit=&offset=)
 *   GET /list.txt      house plain-text index (same filters, ISO-8859-1/CRLF)
 *   GET /files/:id     one ReleaseRow, or 404 { error: "not_found" }
 *
 * Every response carries X-Releases-Contract + X-Releases-Revision (errors
 * included). CORS is deliberately open (Allow-Origin *, no credentials),
 * exactly like the door repo: a public, read-only listing anyone may read,
 * including from a browser. Mounted BEFORE mountWebUi in app.ts for the same
 * reason the achievements mount is (the SPA catch-all only exempts /api/).
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { RELEASES_CONTRACT_VERSION, type ReleaseField } from '../../contract/release-types';
import { esc, oneLine, toLatin1Safe } from '../text-format';
import {
  DUMP_DEFAULT_FIELDS,
  getRandomRelease,
  getReleaseById,
  getReleasesCount,
  getReleasesFacts,
  getReleasesRevision,
  getReleasesStats,
  listReleaseGroups,
  queryReleases,
  streamReleases,
} from './store';
import type { ReleasesConfig } from './config';
import type { ServerConfig } from '../config';

function parseQuery(req: Request) {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const num = (v: unknown): number | undefined => {
    if (typeof v !== 'string' || !v.trim()) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const order = req.query.order === 'desc' ? 'desc' : 'asc';
  const fields =
    typeof req.query.fields === 'string'
      ? (req.query.fields.split(',').map((f) => f.trim()).filter(Boolean) as ReleaseField[])
      : undefined;
  return {
    q: str(req.query.q),
    flag: str(req.query.flag),
    group: str(req.query.group),
    dir: num(req.query.dir),
    from: str(req.query.from),
    to: str(req.query.to),
    sort: str(req.query.sort),
    order: order as 'asc' | 'desc',
    limit: num(req.query.limit),
    offset: num(req.query.offset),
    since: num(req.query.since),
    fields,
  };
}

export function createReleasesRouter(_cfg: ServerConfig, rel: ReleasesConfig): express.Router {
  const router = express.Router();

  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, X-Releases-Revision');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Releases-Contract', RELEASES_CONTRACT_VERSION);
    res.setHeader('X-Releases-Revision', getReleasesRevision(rel));
    next();
  });

  router.options(/.*/, (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'If-None-Match, Range, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
  });

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      contractVersion: RELEASES_CONTRACT_VERSION,
      revision: getReleasesRevision(rel),
      files: getReleasesCount(rel),
    });
  });

  router.get('/list', (req: Request, res: Response) => {
    const { total, rows, limit, offset } = queryReleases(rel, parseQuery(req));
    res.json({
      contractVersion: RELEASES_CONTRACT_VERSION,
      revision: getReleasesRevision(rel),
      total,
      offset,
      limit,
      rows,
    });
  });

  // House plain-text index for 68K clients without a JSON parser:
  //   RELEASE|1|<revision>|<count>
  //   <id>|<filename>|<flag>|<sizeBytes>|<dateIso>|<description>
  // Same escaping rules as list.txt (pipe → !, one row per line, Latin-1,
  // CRLF incl. after the last row) and the same append-only promise.
  router.get('/list.txt', (req: Request, res: Response) => {
    // Full columns: a field subset could leave a hole in a positional format.
    const { rows } = queryReleases(rel, { ...parseQuery(req), fields: undefined, limit: 500, offset: 0 });
    const lines = [`RELEASE|1|${getReleasesRevision(rel)}|${rows.length}`];
    for (const r of rows) {
      const filename = toLatin1Safe(esc(oneLine(r.filename ?? '')));
      const desc = toLatin1Safe(esc(oneLine(r.description ?? ''))).slice(0, 120);
      lines.push(`${r.id}|${filename}|${r.flag ?? ''}|${r.sizeBytes ?? ''}|${r.dateIso}|${desc}`);
    }
    res.set('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.send(Buffer.from(lines.join('\r\n') + '\r\n', 'latin1'));
  });

  // Bulk pull for bots: every matching row as NDJSON (one JSON object per
  // line), slim columns by default (no art block — fetch /files/:id for
  // that). Same filters as /list; resume a broken pull with ?since=<last id>
  // (?limit caps the response for chunking; default uncapped).
  router.get('/dump', (req: Request, res: Response) => {
    const q = parseQuery(req);
    res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.set('X-Releases-Total', String(getReleasesCount(rel)));
    let first = true;
    const write = (row: object): void => {
      if (!first) res.write('\n');
      first = false;
      res.write(JSON.stringify(row));
    };
    try {
      const { rows } = streamReleases(
        rel,
        {
          q: q.q,
          flag: q.flag,
          group: q.group,
          dir: q.dir,
          from: q.from,
          to: q.to,
          since: q.since,
          limit: q.limit,
          fields: q.fields ?? DUMP_DEFAULT_FIELDS,
        },
        write
      );
      void rows;
    } catch {
      // A mid-stream failure cannot become a status code; end the stream and
      // let the row count tell the bot it is short. Resume with ?since=.
      res.end();
      return;
    }
    res.end();
  });

  router.get('/groups', (_req: Request, res: Response) => {
    res.json({
      contractVersion: RELEASES_CONTRACT_VERSION,
      revision: getReleasesRevision(rel),
      groups: listReleaseGroups(rel),
    });
  });

  router.get('/stats', (_req: Request, res: Response) => {
    res.json({
      contractVersion: RELEASES_CONTRACT_VERSION,
      revision: getReleasesRevision(rel),
      ...getReleasesStats(rel),
    });
  });

  router.get('/facts', (_req: Request, res: Response) => {
    res.json({
      contractVersion: RELEASES_CONTRACT_VERSION,
      revision: getReleasesRevision(rel),
      ...getReleasesFacts(rel),
    });
  });

  router.get('/random', (_req: Request, res: Response) => {
    const row = getRandomRelease(rel);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(row);
  });

  router.get('/files/:id', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const row = getReleaseById(rel, id);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(row);
  });

  return router;
}
