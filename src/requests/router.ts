/**
 * The global-requests surface: every path under /requests/v1.
 *
 * A sibling API, shaped exactly like src/achievements/router.ts:
 *
 * - **No CORS middleware, deliberately.** Every board-facing request carries a
 *   board key, and a board key must never be inside a browser. A future web
 *   view of requests would be a SEPARATE unauthenticated read-only endpoint,
 *   not CORS on this one.
 * - **requireBoard(ach) gates everything except /health and /admin/*.** Auth
 *   reuses the achievements board registry verbatim - the boards table is the
 *   server's only one, and rows live in the same achievements.db.
 * - **The router answers its own 404**, so an unmatched requests path never
 *   falls through to the single-page app's catch-all (which would answer
 *   index.html and a 200). The requests health probe returning 200 today is
 *   exactly that fall-through, measured live before this surface existed.
 */
import express, { NextFunction, Request, Response } from 'express';
import { requireAdmin } from '../auth';
import type { ServerConfig } from '../config';
import type { AchievementsConfig } from '../achievements/config';
import { requireBoard } from '../achievements/boards';
import type { BoardRequest } from '../achievements/boards';
import { SurfaceError } from '../achievements/errors';
import { rateLimit, rateLimitAdmin, requestHandleKey } from '../achievements/ratelimit';
import { withRequestsDb } from './config';
import { renderDetailTxt, renderListTxt } from './render';
import {
  claimRequest,
  deleteRequest,
  doneRequest,
  getRequest,
  listRequests,
  parseListQuery,
  postRequest,
  releaseRequest,
  requestCounts,
  requestsRevision,
  voteRequest,
  withdrawRequest,
} from './store';
import { REQUESTS_CONTRACT_VERSION } from '../../contract/request-types';

/** A request body is small; the achievements limit is generous even so. */
const BODY_LIMIT = '32kb';

/** The board a key proved it is. A key can never name another board. */
function keyBoard(req: BoardRequest): string {
  const id = req.board?.id;
  if (!id) throw new SurfaceError('unauthenticated', 401, 'a board key is required');
  return id;
}

/** A path id is a positive integer, or the request is a 404, not a 400. */
function parseId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new SurfaceError('not_found', 404, 'no such request');
  return Number(raw);
}

/** The handle the caller sent, validated the way the store validates it. */
function bodyHandle(req: BoardRequest): { handle: string; handleKey: string } {
  const body = (req.body ?? {}) as { handle?: unknown };
  const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
  const handleKey = requestHandleKey(handle);
  if (handle.length === 0 || handleKey === null) {
    throw new SurfaceError('bad_handle', 400, 'a handle is required');
  }
  return { handle, handleKey };
}

export function createRequestsRouter(cfg: ServerConfig, ach: AchievementsConfig): express.Router {
  const router = express.Router();

  // Every response, errors included, carries both headers. Mounted before the
  // body parser so a body that is not JSON is refused with them too.
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.set('X-Requests-Contract', REQUESTS_CONTRACT_VERSION);
    res.set('X-Requests-Revision', withRequestsDb(ach, (db) => requestsRevision(db), { readonly: true }));
    next();
  });

  router.use(express.json({ limit: BODY_LIMIT }));

  // No board key: a monitor and a sysop can ask whether the surface is alive,
  // and every number here is a count, never a name.
  router.get('/health', (_req: Request, res: Response) => {
    const counts = withRequestsDb(ach, (db) => requestCounts(db), { readonly: true });
    res.json({ status: 'ok', contractVersion: REQUESTS_CONTRACT_VERSION, ...counts });
  });

  // Curation: hard delete, gated by the door server's admin token, never by a
  // board key - the same posture the achievements admin routes take.
  const admin = express.Router();
  admin.use(requireAdmin(cfg));
  admin.use(rateLimitAdmin());
  admin.delete('/requests/:id', (req: Request, res: Response) => {
    const id = parseId(String(req.params.id));
    const deleted = withRequestsDb(ach, (db) => deleteRequest(db, id));
    res.json({ deleted });
  });
  router.use('/admin', admin);

  // Everything below is board-facing and needs a key.
  router.use(requireBoard(ach));

  // ---- reads (no rate limit; the read exemption the project rule states) ----
  router.get('/list', (req: BoardRequest, res: Response) => {
    const q = parseListQuery(req.query as Record<string, unknown>);
    const lb = withRequestsDb(ach, (db) => listRequests(db, q, keyBoard(req)), { readonly: true });
    res.json(lb);
  });

  router.get('/list.txt', (req: BoardRequest, res: Response) => {
    const q = parseListQuery(req.query as Record<string, unknown>);
    const lb = withRequestsDb(ach, (db) => listRequests(db, q, keyBoard(req)), { readonly: true });
    res.set('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.send(renderListTxt(lb.revision, lb.rows));
  });

  router.get('/requests/:id.txt', (req: BoardRequest, res: Response) => {
    const id = parseId(String(req.params.id));
    const detail = withRequestsDb(ach, (db) => getRequest(db, id), { readonly: true });
    if (!detail) throw new SurfaceError('not_found', 404, `no request #${id}`);
    res.set('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.send(renderDetailTxt(detail));
  });

  router.get('/requests/:id', (req: BoardRequest, res: Response) => {
    const id = parseId(String(req.params.id));
    const detail = withRequestsDb(ach, (db) => getRequest(db, id), { readonly: true });
    if (!detail) throw new SurfaceError('not_found', 404, `no request #${id}`);
    res.json(detail);
  });

  // ---- writes (rate limited) ----
  router.post('/requests', rateLimit('requestPost'), (req: BoardRequest, res: Response) => {
    const boardId = keyBoard(req);
    const body = (req.body ?? {}) as { kind?: unknown; title?: unknown; notes?: unknown; handle?: unknown };
    const now = Math.floor(Date.now() / 1000);
    const out = withRequestsDb(ach, (db) =>
      postRequest(db, { kind: body.kind, title: body.title, notes: body.notes, boardId, handle: body.handle }, now)
    );
    res.json(out);
  });

  router.post('/requests/:id/vote', rateLimit('requestAction'), (req: BoardRequest, res: Response) => {
    const id = parseId(String(req.params.id));
    const boardId = keyBoard(req);
    const { handleKey } = bodyHandle(req);
    const now = Math.floor(Date.now() / 1000);
    res.json(withRequestsDb(ach, (db) => voteRequest(db, id, boardId, handleKey, now)));
  });

  router.post('/requests/:id/claim', rateLimit('requestAction'), (req: BoardRequest, res: Response) => {
    const id = parseId(String(req.params.id));
    const boardId = keyBoard(req);
    const { handle, handleKey } = bodyHandle(req);
    const now = Math.floor(Date.now() / 1000);
    res.json(withRequestsDb(ach, (db) => claimRequest(db, id, boardId, handle, handleKey, now)));
  });

  router.post('/requests/:id/release', rateLimit('requestAction'), (req: BoardRequest, res: Response) => {
    const id = parseId(String(req.params.id));
    const boardId = keyBoard(req);
    const { handleKey } = bodyHandle(req);
    const now = Math.floor(Date.now() / 1000);
    res.json(withRequestsDb(ach, (db) => releaseRequest(db, id, boardId, handleKey, now)));
  });

  router.post('/requests/:id/done', rateLimit('requestAction'), (req: BoardRequest, res: Response) => {
    const id = parseId(String(req.params.id));
    const boardId = keyBoard(req);
    const { handleKey } = bodyHandle(req);
    const body = (req.body ?? {}) as { note?: unknown };
    const now = Math.floor(Date.now() / 1000);
    res.json(withRequestsDb(ach, (db) => doneRequest(db, id, boardId, handleKey, body.note, now)));
  });

  router.post('/requests/:id/withdraw', rateLimit('requestAction'), (req: BoardRequest, res: Response) => {
    const id = parseId(String(req.params.id));
    const boardId = keyBoard(req);
    const { handleKey } = bodyHandle(req);
    const now = Math.floor(Date.now() / 1000);
    res.json(withRequestsDb(ach, (db) => withdrawRequest(db, id, boardId, handleKey, now)));
  });

  // A requests path that matches no route above answers HERE, as this API, in
  // JSON - never the single-page app's index.html.
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', detail: 'no such requests endpoint' });
  });

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof SurfaceError) {
      if (err.retryAfter !== undefined) res.set('Retry-After', String(err.retryAfter));
      res.status(err.status).json({
        error: err.code,
        detail: err.message,
        ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
      });
      return;
    }
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(400).json({ error: 'bad_request', detail: (err as Error).message });
      return;
    }
    console.error(`[ERROR] requests: ${(err as Error).message}`);
    res.status(500).json({ error: 'internal_error' });
  });

  return router;
}
