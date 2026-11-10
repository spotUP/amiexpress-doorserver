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
import type Database from 'better-sqlite3';
import express, { NextFunction, Request, Response } from 'express';
import { requireAdmin } from '../auth';
import type { AuthedRequest } from '../auth';
import type { ServerConfig } from '../config';
import type { AchievementsConfig } from './config';
import { withAchievementsDb } from './db';
import { catalogRevision, catalogRows, parseSince, renderCatalogTxt } from './catalog';
import { SurfaceError } from './errors';
import { achievementsHealth } from './health';
import { queueMail, verificationMail } from './mail';
import {
  VERIFY_CODE_TTL_SECONDS,
  registerPlayer,
  resendCode,
  verifyPlayer,
} from './players';
import type { IssuedCode } from './players';
import { linkBoard, rotateLinkCode, unlinkBoard } from './links';
import { storeEvents } from './events';
import { evaluate } from './engine';
import { registerDoorCatalog } from './doors';
import { patchProfile, readProfile } from './profile';
import { leaderboard, parseLeaderboardQuery, renderLeaderboardTxt } from './leaderboard';
import { ensureCurrentSeason } from './seasons';
import { refreshRarityIfStale } from './rarity';
import { chargeMail, rateLimit, rateLimitAdmin } from './ratelimit';
import {
  auditBoard,
  createBoard,
  getBoard,
  listBoards,
  registerBoard,
  requireBoard,
  rotateBoardKey,
  setBoardSuspended,
  setBoardRelay,
  validateRegistration,
} from './boards';
import type { BoardRequest, BoardRow } from './boards';
import { ACHIEVEMENTS_CONTRACT_VERSION } from '../../contract/achievement-types';
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
    chatRelay: row.chat_relay === 1,
    discordMirror: row.discord_mirror === 1,
  };
}

export function createAchievementsRouter(
  cfg: ServerConfig,
  ach: AchievementsConfig
): express.Router {
  const router = express.Router();

  // Every response, errors included, carries both headers: a client can then
  // notice a catalog change without asking for the catalog, and can tell
  // this API's own 401 apart from a reverse proxy's. Mounted before the body
  // parser so a body that is not JSON is refused with them too.
  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.set('X-Achievements-Contract', ACHIEVEMENTS_CONTRACT_VERSION);
    res.set(
      'X-Achievements-Revision',
      withAchievementsDb(ach, (db) => catalogRevision(db), { readonly: true })
    );
    next();
  });

  router.use(express.json({ limit: BODY_LIMIT }));

  // No board key: a monitor and a sysop must be able to ask whether the
  // surface is alive, and every number here is a count, never a name.
  router.get('/health', (_req: Request, res: Response) => {
    res.json(achievementsHealth(ach));
  });

  // Self-service registration: no key, no approval, no rate limit (sysop
  // decision). The board is active at once; the plaintext key is shown once.
  // A 68K door sends Accept: text/plain and gets "OK <id>.<secret>\n".
  router.post('/boards/register', (req: Request, res: Response) => {
    const reg = validateRegistration(req.body);
    const minted = withAchievementsDb(ach, (db) => registerBoard(db, reg));
    if (req.accepts(['json', 'text/plain']) === 'text/plain') {
      res.status(201).type('text/plain').send(`OK ${minted.key}\n`);
      return;
    }
    res.status(201).json(minted);
  });

  // ---------------------------------------------------------------------
  // Curation: issuing board keys. Gated by the ADMIN token, never by a board
  // key - a board can no more mint itself a second key than suspend a rival.
  // ---------------------------------------------------------------------
  const admin = express.Router();
  admin.use(requireAdmin(cfg));
  admin.use(rateLimitAdmin());

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

  // Relay boards (the Discord bridge) speak `as` many of their own users
  // through one chat session. Only the server admin may grant that.
  for (const [path, relay, action] of [
    ['/boards/:id/relay', true, 'board:relay'],
    ['/boards/:id/unrelay', false, 'board:unrelay'],
  ] as const) {
    admin.post(path, (req: Request, res: Response) => {
      const id = String(req.params.id);
      withAchievementsDb(ach, (db) => {
        const row = getBoard(db, id);
        if (!row) {
          res.status(404).json({ error: 'bad_request', detail: 'no such board' });
          return;
        }
        setBoardRelay(db, row.id, relay);
        auditBoard(db, row.id, action, 1);
        res.json(summarise(getBoard(db, row.id) as BoardRow));
      });
    });
  }

  router.use('/admin', admin);

  // Everything below this line is board-facing and needs a key.
  router.use(requireBoard(ach));

  // THE CLOCK (D12). No scheduler: the top of every write request is when a
  // season that has ended gets closed and a day-old rarity gets recomputed.
  // Both do nothing unless the calendar says otherwise, so the cost on the
  // hot path is two indexed reads.
  router.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const now = Math.floor(Date.now() / 1000);
      withAchievementsDb(ach, (db) =>
        db.transaction(() => {
          ensureCurrentSeason(db, now);
          refreshRarityIfStale(db, now);
        })()
      );
    }
    next();
  });

  // ---------------------------------------------------------------------
  // Players. A board registers on its caller's behalf, so every route here
  // is behind the board key - but the PLAYER is identified by an email the
  // board never sees again: no response from this surface carries an
  // address, and a test asserts that over every body the suite produces.
  //
  // Mail is QUEUED inside the same open handle that wrote the code, never
  // sent inline. That is why no route here holds a Mailer: the seam lives
  // at the drain (mail.ts), which is the only thing that ever opens a
  // socket, and an SMTP server that is refusing connections cannot turn a
  // registration into a 500.
  // ---------------------------------------------------------------------
  const queueCode = (db: Database.Database, issued: IssuedCode, now: number): void => {
    // Three mails an hour per address (AC-17), charged here where the mail
    // is, so a refused registration costs the address nothing.
    chargeMail(issued.to);
    const mail = verificationMail(ach, issued.code, VERIFY_CODE_TTL_SECONDS);
    queueMail(db, issued.to, mail.subject, mail.body, now);
  };

  router.post('/players', rateLimit('register'), (req: BoardRequest, res: Response) => {
    const body = (req.body ?? {}) as { email?: unknown; handle?: unknown };
    if (typeof body.email !== 'string' || typeof body.handle !== 'string') {
      throw new SurfaceError('bad_request', 400, 'email and handle are required');
    }
    const email = body.email;
    const handle = body.handle;
    withAchievementsDb(ach, (db) => {
      const now = Math.floor(Date.now() / 1000);
      queueCode(db, registerPlayer(db, email, handle, now), now);
      auditBoard(db, req.board?.id ?? null, 'player:register', 1, now);
      // 202 whether or not the address already existed. The response never
      // reveals whether an email is registered.
      res.status(202).json({ queued: true });
    });
  });

  router.post('/players/resend', rateLimit('register'), (req: BoardRequest, res: Response) => {
    const body = (req.body ?? {}) as { email?: unknown };
    if (typeof body.email !== 'string') {
      throw new SurfaceError('bad_request', 400, 'email is required');
    }
    const email = body.email;
    withAchievementsDb(ach, (db) => {
      const now = Math.floor(Date.now() / 1000);
      const issued = resendCode(db, email, now);
      // null means the address has no player. It is NOT an error and it is
      // NOT visible: the same 202 either way, so this endpoint cannot be
      // used as a register of who has signed up.
      if (issued) {
        queueCode(db, issued, now);
        auditBoard(db, req.board?.id ?? null, 'player:resend', 1, now);
      }
      res.status(202).json({ queued: true });
    });
  });

  router.post('/players/verify', rateLimit('verify'), (req: BoardRequest, res: Response) => {
    const body = (req.body ?? {}) as { email?: unknown; code?: unknown };
    if (typeof body.email !== 'string' || typeof body.code !== 'string') {
      throw new SurfaceError('bad_request', 400, 'email and code are required');
    }
    const email = body.email;
    const code = body.code;
    withAchievementsDb(ach, (db) => {
      const now = Math.floor(Date.now() / 1000);
      const profile = verifyPlayer(db, email, code, now);
      auditBoard(db, req.board?.id ?? null, 'player:verify', 1, now);
      res.json(profile);
    });
  });

  // ---------------------------------------------------------------------
  // Links. Every route here acts on THE KEY'S BOARD; there is no board field
  // in any body, and a key that could name another board could unlink it.
  // ---------------------------------------------------------------------
  const keyBoard = (req: BoardRequest): string => {
    const id = req.board?.id;
    if (!id) throw new SurfaceError('unauthenticated', 401, 'a board key is required');
    return id;
  };

  router.post('/links', rateLimit('links'), (req: BoardRequest, res: Response) => {
    const body = (req.body ?? {}) as { email?: unknown; code?: unknown };
    if (typeof body.email !== 'string' || typeof body.code !== 'string') {
      throw new SurfaceError('bad_request', 400, 'email and code are required');
    }
    const email = body.email;
    const code = body.code;
    withAchievementsDb(ach, (db) => {
      const now = Math.floor(Date.now() / 1000);
      const boardId = keyBoard(req);
      const out = db.transaction(() => linkBoard(db, boardId, email, code, now))();
      auditBoard(db, boardId, 'link', 1, now);
      res.json(out);
    });
  });

  router.delete('/links', rateLimit('links'), (req: BoardRequest, res: Response) => {
    const body = (req.body ?? {}) as { email?: unknown };
    if (typeof body.email !== 'string') {
      throw new SurfaceError('bad_request', 400, 'email is required');
    }
    const email = body.email;
    withAchievementsDb(ach, (db) => {
      const now = Math.floor(Date.now() / 1000);
      const boardId = keyBoard(req);
      const out = unlinkBoard(db, boardId, email);
      auditBoard(db, boardId, 'unlink', 1, now);
      res.json(out);
    });
  });

  router.post('/links/rotate', rateLimit('links'), (req: BoardRequest, res: Response) => {
    const body = (req.body ?? {}) as { email?: unknown; code?: unknown };
    if (typeof body.email !== 'string' || typeof body.code !== 'string') {
      throw new SurfaceError('bad_request', 400, 'email and code are required');
    }
    const email = body.email;
    const code = body.code;
    withAchievementsDb(ach, (db) => {
      const now = Math.floor(Date.now() / 1000);
      const boardId = keyBoard(req);
      const out = rotateLinkCode(db, email, code, now);
      auditBoard(db, boardId, 'link:rotate', 1, now);
      res.json(out);
    });
  });

  // ---------------------------------------------------------------------
  // Events. One request, one transaction: a batch-level refusal thrown
  // inside it rolls back whatever the loop had stored before it fired, so
  // "nothing is stored" is a property of the transaction, not of the order
  // the checks happen to run in.
  // ---------------------------------------------------------------------
  router.post('/events', rateLimit('events'), (req: BoardRequest, res: Response) => {
    withAchievementsDb(ach, (db) => {
      const now = Math.floor(Date.now() / 1000);
      const boardId = keyBoard(req);
      const body: unknown = req.body;
      const out = db.transaction(() => {
        const folded = { playerIds: [] as number[], types: [] as string[] };
        const stored = storeEvents(db, boardId, body, now, folded);
        // The fold decided which players and types moved; the engine asks
        // its one indexed question about exactly those.
        const verdict = evaluate(db, folded.playerIds, folded.types, boardId, now);
        return { ...stored, unlocks: verdict.unlocks, progress: verdict.progress };
      })();
      res.json(out);
    });
  });

  // ---------------------------------------------------------------------
  // The catalog, JSON and text. The ETag is the revision, set and checked
  // through req.fresh BEFORE a row is read, exactly as /manifest does: a
  // 304 never pays for the rows it throws away.
  // ---------------------------------------------------------------------
  const catalogHeaders = (req: Request, res: Response): string | null => {
    const revision = withAchievementsDb(ach, (db) => catalogRevision(db), { readonly: true });
    res.set('ETag', `"${revision}"`);
    if (req.fresh) {
      res.status(304).end();
      return null;
    }
    return revision;
  };
  const sinceOf = (req: Request): { since: string | null; epoch: number | null } => {
    const raw = typeof req.query.since === 'string' ? req.query.since : undefined;
    return { since: raw ?? null, epoch: parseSince(raw) };
  };

  router.get('/catalog', (req: BoardRequest, res: Response) => {
    const revision = catalogHeaders(req, res);
    if (revision === null) return;
    const boardId = keyBoard(req);
    const { since, epoch } = sinceOf(req);
    const achievements = withAchievementsDb(ach, (db) => catalogRows(db, boardId, epoch), { readonly: true });
    res.json({ contractVersion: ACHIEVEMENTS_CONTRACT_VERSION, revision, since: epoch === null ? null : since, achievements });
  });

  router.get('/catalog.txt', (req: BoardRequest, res: Response) => {
    const revision = catalogHeaders(req, res);
    if (revision === null) return;
    const boardId = keyBoard(req);
    const { epoch } = sinceOf(req);
    const rows = withAchievementsDb(ach, (db) => catalogRows(db, boardId, epoch), { readonly: true });
    res.set('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.send(renderCatalogTxt(rows, revision));
  });

  // A door's own definitions. Whole-request: the transaction is what makes
  // "nothing is written when any id fails" true.
  router.put('/catalog/doors/:door', rateLimit('doorCatalog'), (req: BoardRequest, res: Response) => {
    const door = String(req.params.door);
    const body: unknown = req.body;
    withAchievementsDb(ach, (db) => {
      const now = Math.floor(Date.now() / 1000);
      const boardId = keyBoard(req);
      res.json(db.transaction(() => registerDoorCatalog(db, boardId, door, body, now))());
    });
  });

  // ---------------------------------------------------------------------
  // The profile, from a linked board. The address is in the path, URL
  // encoded; the answer never contains it.
  // ---------------------------------------------------------------------
  router.get('/players/:email', (req: BoardRequest, res: Response) => {
    const email = decodeURIComponent(String(req.params.email));
    withAchievementsDb(ach, (db) => {
      res.json(readProfile(db, keyBoard(req), email));
    });
  });

  router.patch('/players/:email', (req: BoardRequest, res: Response) => {
    const email = decodeURIComponent(String(req.params.email));
    const body = (req.body ?? {}) as { private?: unknown; handle?: unknown };
    if (body.private !== undefined && typeof body.private !== 'boolean') {
      throw new SurfaceError('bad_request', 400, 'private is a boolean');
    }
    if (body.handle !== undefined && typeof body.handle !== 'string') {
      throw new SurfaceError('bad_request', 400, 'handle is a string');
    }
    const patch = { private: body.private as boolean | undefined, handle: body.handle as string | undefined };
    withAchievementsDb(ach, (db) => {
      const now = Math.floor(Date.now() / 1000);
      const boardId = keyBoard(req);
      const out = db.transaction(() => patchProfile(db, boardId, email, patch))();
      auditBoard(db, boardId, 'player:patch', 1, now);
      res.json(out);
    });
  });

  // ---------------------------------------------------------------------
  // Leaderboards. The ETag is the leaderboard's OWN fingerprint,
  // l<rows>-t<newest unlock>, scoped to the query, so a 68K client holds
  // one against a board scoreboard the way it holds one against the
  // catalog. Computing it means running the query, which is the listing
  // itself - so unlike the catalog there is nothing to save by checking
  // freshness first, and the rows are simply not sent.
  // ---------------------------------------------------------------------
  const listing = (req: Request, res: Response): ReturnType<typeof leaderboard> | null => {
    const q = parseLeaderboardQuery(req.query as Record<string, unknown>);
    const now = Math.floor(Date.now() / 1000);
    const lb = withAchievementsDb(ach, (db) => leaderboard(db, q, now), { readonly: true });
    res.set('ETag', `"${lb.revision}"`);
    if (req.fresh) {
      res.status(304).end();
      return null;
    }
    return lb;
  };

  router.get('/leaderboard', (req: BoardRequest, res: Response) => {
    const lb = listing(req, res);
    if (lb === null) return;
    const { newestAt: _newestAt, ...body } = lb;
    res.json(body);
  });

  router.get('/leaderboard.txt', (req: BoardRequest, res: Response) => {
    const lb = listing(req, res);
    if (lb === null) return;
    res.set('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.send(renderLeaderboardTxt(lb));
  });

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
    if (err instanceof SurfaceError) {
      if (err.retryAfter !== undefined) res.set('Retry-After', String(err.retryAfter));
      res.status(err.status).json({
        error: err.code,
        detail: err.message,
        ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}),
      });
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
