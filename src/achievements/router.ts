/**
 * The achievements surface: every path under /achievements/v1.
 *
 * A sibling API, not a door-repo route. Three things about the shape of this
 * router are load-bearing:
 *
 * - **No CORS middleware sits in front of it, deliberately (D13).** The door
 *   repo is public, read-only and meant to be read from a browser, which is
 *   what src/cors.ts exists for. Every request here carries a board key, and
 *   a board key must never be inside a browser.
 * - **requireBoard gates everything except /health and /admin/*.** The admin
 *   routes issue keys, which is curation: they take the door server's admin
 *   token instead, because curation already has an auth story.
 * - **The router answers its own 404.** Without a terminal handler an
 *   unmatched achievements path falls through to the single-page app's
 *   catch-all in src/app.ts and is answered with index.html and a 200 - the
 *   exact behaviour AC-1's SYM-2 measured before this surface existed.
 */
import express, { NextFunction, Request, Response } from 'express';
import { requireAdmin } from '../auth';
import type { AuthedRequest } from '../auth';
import type { ServerConfig } from '../config';
import type { AchievementsConfig } from './config';
import { withAchievementsDb } from './db';
import {
  BoardError,
  auditBoard,
  createBoard,
  getBoard,
  listBoards,
  requireBoard,
  rotateBoardKey,
  setBoardSuspended,
} from './boards';
import type { BoardRow } from './boards';
import type { BoardSummary } from '../../contract/achievement-types';

/** A 100-event batch is ~20 KB; the limit matches src/admin-routes.ts. */
const BODY_LIMIT = '256kb';

function iso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function summarise(row: BoardRow): BoardSummary {
  return {
    id: row.id,
    name: row.name,
    contact: row.contact,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    suspendedAt: iso(row.suspended_at),
  };
}

export function createAchievementsRouter(
  cfg: ServerConfig,
  ach: AchievementsConfig
): express.Router {
  const router = express.Router();

  router.use(express.json({ limit: BODY_LIMIT }));

  // ---------------------------------------------------------------------
  // Curation: issuing board keys. Gated by the ADMIN token, never by a board
  // key - a board can no more mint itself a second key than suspend a rival.
  // ---------------------------------------------------------------------
  const admin = express.Router();
  admin.use(requireAdmin(cfg));

  admin.get('/boards', (_req: Request, res: Response) => {
    res.json(withAchievementsDb(ach, (db) => listBoards(db).map(summarise), { readonly: true }));
  });

  admin.post('/boards', (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { id?: unknown; name?: unknown; contact?: unknown };
    if (typeof body.id !== 'string' || typeof body.name !== 'string') {
      res.status(400).json({ error: 'bad_request', detail: 'id and name are required' });
      return;
    }
    const contact = typeof body.contact === 'string' ? body.contact : null;
    withAchievementsDb(ach, (db) => {
      const minted = createBoard(db, body.id as string, body.name as string, contact);
      auditBoard(db, minted.id, 'board:create', 1);
      // The plaintext key is returned ONCE, here and at rotation.
      res.json(minted);
    });
  });

  admin.post('/boards/:id/rotate', (req: Request, res: Response) => {
    const id = String(req.params.id);
    withAchievementsDb(ach, (db) => {
      if (!getBoard(db, id)) {
        res.status(404).json({ error: 'bad_request', detail: 'no such board' });
        return;
      }
      const minted = rotateBoardKey(db, id);
      auditBoard(db, minted.id, 'board:rotate', 1);
      res.json(minted);
    });
  });

  for (const [path, suspended, action] of [
    ['/boards/:id/suspend', true, 'board:suspend'],
    ['/boards/:id/resume', false, 'board:resume'],
  ] as const) {
    admin.post(path, (req: Request, res: Response) => {
      const id = String(req.params.id);
      withAchievementsDb(ach, (db) => {
        const row = getBoard(db, id);
        if (!row) {
          res.status(404).json({ error: 'bad_request', detail: 'no such board' });
          return;
        }
        setBoardSuspended(db, row.id, suspended);
        auditBoard(db, row.id, action, 1);
        res.json(summarise(getBoard(db, row.id) as BoardRow));
      });
    });
  }

  router.use('/admin', admin);

  // Everything below this line is board-facing and needs a key.
  router.use(requireBoard(ach));

  // An achievements path that matches no route above must NOT fall through
  // to the single-page app. It answers here, as this API, in JSON.
  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'bad_request', detail: 'no such achievements endpoint' });
  });

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof BoardError) {
      res.status(err.status).json({ error: err.code, detail: err.message });
      return;
    }
    // A body that is not JSON, or one over the limit: body-parser's own
    // error, answered in this API's shape rather than Express's HTML page.
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(400).json({ error: 'bad_request', detail: (err as Error).message });
      return;
    }
    // 500 is RETRYABLE BY STATUS (ACHIEVEMENTS-API.md, section 6) and is the
    // one answer a client never reads an error code out of, so this string is
    // deliberately outside ERROR_CODES - that list enumerates the terminal
    // 4xx codes a client may switch on exhaustively, and adding an unreachable
    // 5xx member to it would widen a frozen contract for no client's benefit.
    console.error(`[ERROR] achievements: ${(err as Error).message}`);
    res.status(500).json({ error: 'internal_error' });
  });

  return router;
}
