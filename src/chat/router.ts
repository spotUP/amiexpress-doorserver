/**
 * The federated live-chat surface, mounted at /chat/v1.
 *
 * Auth: a board key (`Authorization: Board <id>.<secret>`) on everything but
 * /health, then `X-Chat-Session: <sid>` on everything but POST /sessions. A
 * server admin may add `X-Admin-Token: Bearer <jwt>`. Handlers here are glue:
 * the rules live in store.ts, permissions.ts and roles.ts.
 */
import express, { NextFunction, Request, Response } from 'express';
import { CHAT_CONTRACT_VERSION, CHAT_LIMITS } from '../../contract/chat-types';
import { verifyToken } from '../auth';
import type { ServerConfig } from '../config';
import { openDb } from '../db';
import { withAchievementsDb } from '../achievements/db';
import type { AchievementsConfig } from '../achievements/config';
import { requireBoard } from '../achievements/boards';
import type { BoardRequest } from '../achievements/boards';
import { SurfaceError } from '../achievements/errors';
import type Database from 'better-sqlite3';
import { loadChatConfig } from './config';
import { fetchVisibleEvents, headSeq, heldPollCount, waitForEvents } from './events';
import type { EventRec } from './events';
import { clampMaxBytes, displayLabels, fitRows, markOrigin, renderText, sendText } from './render';
import * as roles from './roles';
import { actingCtx, createSession, expireSession, resolveSession, startSweeper } from './sessions';
import type { ChatCtx } from './sessions';
import * as store from './store';
import type { Body } from './store';
import { requireSysop } from './permissions';

const ADMIN_CTX: ChatCtx = { sid: null, boardId: '', handle: 'admin', user: '', sysop: false, admin: true };

export function createChatRouter(cfg: ServerConfig, ach: AchievementsConfig): express.Router {
  const chat = loadChatConfig();
  const router = express.Router();
  startSweeper(ach, chat);

  router.use((_req: Request, res: Response, next: NextFunction) => {
    res.set('X-Chat-Contract', CHAT_CONTRACT_VERSION);
    next();
  });
  router.use(express.json({ limit: '32kb' }));

  router.get('/health', (_req: Request, res: Response) => {
    const sessions = withAchievementsDb(ach, (db) => (db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get() as { n: number }).n, { readonly: true });
    res.json({ status: 'ok', contractVersion: CHAT_CONTRACT_VERSION, sessions, heldPolls: heldPollCount() });
  });

  router.use(requireBoard(ach));

  function isAdmin(req: Request): boolean {
    const raw = req.header('x-admin-token');
    if (!raw || !cfg.jwtSecret) return false;
    const token = raw.replace(/^Bearer\s+/i, '');
    const payload = verifyToken(token, cfg.jwtSecret);
    if (!payload) return false;
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db.prepare('SELECT id, username FROM admin_users WHERE id = ?').get(payload.id) as { id: number; username: string } | undefined;
      return row !== undefined && row.username === payload.username;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  function context(db: Database.Database, req: Request, admin: boolean): ChatCtx {
    const sid = req.header('x-chat-session');
    if (!sid) {
      if (admin) return ADMIN_CTX;
      throw new SurfaceError('unauthorized', 401, 'X-Chat-Session is required');
    }
    const boardId = (req as BoardRequest).board?.id ?? '';
    const ctx = resolveSession(db, chat, sid, boardId);
    return admin ? { ...ctx, admin: true } : ctx;
  }

  /** Resolve the session (committed on its own), then run `fn`, in one transaction when it writes. */
  function run<T>(req: Request, write: boolean, fn: (db: Database.Database, ctx: ChatCtx) => T): T {
    const admin = isAdmin(req);
    return withAchievementsDb(ach, (db) => {
      const ctx = context(db, req, admin);
      return write ? db.transaction(() => fn(db, ctx))() : fn(db, ctx);
    });
  }

  /**
   * `run` for the message verbs a relay board may perform for its users:
   * `as` (body, or query on DELETE) swaps in the relayed author (actingCtx).
   */
  function runAs<T>(req: Request, fn: (db: Database.Database, ctx: ChatCtx) => T): T {
    const as = body(req).as ?? req.query.as;
    return run(req, true, (db, ctx) => fn(db, actingCtx(db, ctx, as)));
  }

  const body = (req: Request): Body => (req.body && typeof req.body === 'object' ? (req.body as Body) : {});
  const p = (req: Request, k: string): string => String(req.params[k] ?? '');
  const roleColor = (db: Database.Database, cache: Map<string, string>, user: string): string => {
    let c = cache.get(user);
    if (c === undefined) {
      c = roles.roleOf(db, user)?.colorHex ?? '';
      cache.set(user, c);
    }
    return c;
  };
  const roleName = (db: Database.Database, user: string): string => roles.roleOf(db, user)?.name ?? '';

  // ---- sessions ----
  router.post('/sessions', (req: BoardRequest, res: Response) => {
    const out = withAchievementsDb(ach, (db) => db.transaction(() => createSession(db, chat, req.board!.id, body(req)))());
    res.status(201).json(out);
  });
  router.delete('/sessions/current', (req: Request, res: Response) => {
    const sid = req.header('x-chat-session') ?? '';
    run(req, true, (db, ctx) => {
      if (ctx.sid) expireSession(db, ctx.sid);
    });
    res.json({ ok: true, sid });
  });

  // ---- rooms ----
  router.get('/rooms.txt', (req: Request, res: Response) => {
    const out = run(req, false, (db, ctx) => ({ rev: headSeq(db), rows: store.listRooms(db, ctx) }));
    sendText(res, renderText('ROOMS', out.rev, out.rows.map((r) => [r.id, r.name, r.topic, r.visibility, r.members, r.owner, r.kind])));
  });
  router.get('/rooms', (req: Request, res: Response) => {
    res.json(run(req, false, (db, ctx) => store.listRooms(db, ctx)));
  });
  router.post('/rooms', (req: Request, res: Response) => {
    res.status(201).json(run(req, true, (db, ctx) => store.createRoom(db, ctx, body(req))));
  });
  router.post('/rooms/:id/join', (req: Request, res: Response) => {
    res.json(run(req, true, (db, ctx) => store.joinRoom(db, ctx, p(req, 'id'))));
  });
  router.post('/rooms/:id/leave', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.leaveRoom(db, ctx, p(req, 'id')));
    res.json({ ok: true });
  });
  router.get('/rooms/:id/members.txt', (req: Request, res: Response) => {
    const out = run(req, false, (db, ctx) => {
      const cache = new Map<string, string>();
      const members = store.roomMembers(db, ctx, p(req, 'id'));
      const labels = displayLabels(members.map((m) => m.user));
      const rows = members.map((m) => [m.user, m.sysop ? 1 : 0, m.op ? 1 : 0, roleColor(db, cache, m.user), roleName(db, m.user), m.status, m.statusText, labels.get(m.user) ?? m.user]);
      return { rev: headSeq(db), rows };
    });
    sendText(res, renderText('MEMBERS', out.rev, out.rows));
  });
  /** HISTORY rows with the D7 label column and ` [Discord]` marker; `present` adds the room's members to the clash set. */
  const historyRows = (db: Database.Database, recs: store.HistoryRec[], present: string[]): (string | number)[][] => {
    const cache = new Map<string, string>();
    const labels = displayLabels([...recs.map((h) => h.user), ...present]);
    return recs.map((h) => [h.seq, h.id, h.user, h.at, h.replyTo, h.threadId, roleColor(db, cache, h.user), markOrigin(h.user, h.text), labels.get(h.user) ?? h.user]);
  };
  const historyText = (fetch: (db: Database.Database, ctx: ChatCtx) => { recs: store.HistoryRec[]; rooms: string[] }) => (req: Request, res: Response) => {
    const out = run(req, false, (db, ctx) => {
      const got = fetch(db, ctx);
      return { rev: headSeq(db), rows: historyRows(db, got.recs, store.memberUsers(db, got.rooms)) };
    });
    sendText(res, renderText('HISTORY', out.rev, out.rows));
  };
  router.get('/rooms/:id/history.txt', (req: Request, res: Response) =>
    historyText((db, ctx) => ({ recs: store.roomHistory(db, ctx, p(req, 'id'), req.query), rooms: [p(req, 'id')] }))(req, res));
  router.post('/rooms/:id/messages', (req: Request, res: Response) => {
    res.status(201).json(runAs(req, (db, ctx) => store.postMessage(db, ctx, p(req, 'id'), body(req))));
  });

  // ---- messages ----
  router.put('/messages/:id', (req: Request, res: Response) => {
    res.json(runAs(req, (db, ctx) => store.editMessage(db, ctx, p(req, 'id'), body(req))));
  });
  router.delete('/messages/:id', (req: Request, res: Response) => {
    runAs(req, (db, ctx) => store.deleteMessage(db, ctx, p(req, 'id')));
    res.json({ ok: true });
  });
  router.post('/messages/:id/react', (req: Request, res: Response) => {
    res.json(runAs(req, (db, ctx) => store.react(db, ctx, p(req, 'id'), body(req))));
  });
  router.delete('/messages/:id/react/:emoji', (req: Request, res: Response) => {
    res.json(runAs(req, (db, ctx) => store.unreact(db, ctx, p(req, 'id'), p(req, 'emoji'))));
  });
  router.get('/messages/:id/reactions.txt', (req: Request, res: Response) => {
    const out = run(req, false, (db, ctx) => ({ rev: headSeq(db), rows: store.reactionRows(db, ctx, p(req, 'id')) }));
    sendText(res, renderText('REACTIONS', out.rev, out.rows.map((r) => [r.emoji, r.count, r.mine ? 1 : 0])));
  });
  router.post('/messages/:id/thread', (req: Request, res: Response) => {
    res.status(201).json(runAs(req, (db, ctx) => store.postThread(db, ctx, p(req, 'id'), body(req))));
  });
  router.get('/threads/:id.txt', (req: Request, res: Response) =>
    historyText((db, ctx) => ({ recs: store.threadHistory(db, ctx, p(req, 'id')), rooms: [store.roomOfMessage(db, p(req, 'id'))] }))(req, res));

  router.get('/who.txt', (req: Request, res: Response) => {
    const out = run(req, false, (db, ctx) => {
      const cache = new Map<string, string>();
      const who = store.whoRows(db, ctx);
      const labels = displayLabels(who.map((w) => w.user));
      return { rev: headSeq(db), rows: who.map((w) => [w.user, w.room, w.sysop ? 1 : 0, roleColor(db, cache, w.user), w.idle, w.status, w.statusText, labels.get(w.user) ?? w.user]) };
    });
    sendText(res, renderText('WHO', out.rev, out.rows));
  });

  // ---- presence, profile, ignore list ----
  router.put('/presence', (req: Request, res: Response) => {
    res.json(run(req, true, (db, ctx) => store.setPresence(db, ctx, body(req))));
  });
  router.delete('/presence', (req: Request, res: Response) => {
    res.json(run(req, true, (db, ctx) => store.clearPresence(db, ctx)));
  });
  router.get('/users/:user/profile.txt', (req: Request, res: Response) => {
    const out = run(req, false, (db, ctx) => ({ rev: headSeq(db), pr: store.profileOf(db, ctx, p(req, 'user')) }));
    const x = out.pr;
    sendText(res, renderText('PROFILE', out.rev, [[x.user, x.nick, x.board, x.status, x.statusText, x.firstSeen, x.lastSeen, x.idle, x.online ? 1 : 0, x.sharedRooms]]));
  });
  router.get('/ignores.txt', (req: Request, res: Response) => {
    const out = run(req, false, (db, ctx) => ({ rev: headSeq(db), rows: store.listIgnores(db, ctx) }));
    sendText(res, renderText('IGNORES', out.rev, out.rows.map((r) => [r.user, r.at])));
  });
  router.post('/ignores', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.addIgnore(db, ctx, body(req)));
    res.status(201).json({ ok: true });
  });
  router.delete('/ignores/:user', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.removeIgnore(db, ctx, p(req, 'user')));
    res.json({ ok: true });
  });

  // ---- invites ----
  router.post('/rooms/:id/invites', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.invite(db, ctx, p(req, 'id'), body(req), true));
    res.status(201).json({ ok: true });
  });
  router.delete('/rooms/:id/invites/:user', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.invite(db, ctx, p(req, 'id'), {}, false, p(req, 'user')));
    res.json({ ok: true });
  });

  // ---- direct messages ----
  router.get('/dm.txt', (req: Request, res: Response) => {
    const out = run(req, false, (db, ctx) => ({ rev: headSeq(db), rows: store.dmThreads(db, ctx) }));
    sendText(res, renderText('DM', out.rev, out.rows.map((r) => [r.threadId, r.peer, r.lastAt, r.unread])));
  });
  router.post('/dm/:peer', (req: Request, res: Response) => {
    res.status(201).json(run(req, true, (db, ctx) => store.postDm(db, ctx, p(req, 'peer'), body(req))));
  });
  router.post('/dm-group', (req: Request, res: Response) => {
    res.status(201).json(run(req, true, (db, ctx) => store.postDmGroup(db, ctx, body(req))));
  });
  router.get('/dm/:threadId/history.txt', (req: Request, res: Response) => {
    const out = run(req, true, (db, ctx) => ({ rev: headSeq(db), rows: historyRows(db, store.dmHistory(db, ctx, p(req, 'threadId'), req.query), []) }));
    sendText(res, renderText('HISTORY', out.rev, out.rows));
  });

  // ---- events: the long poll ----
  router.get('/events.txt', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sid = req.header('x-chat-session') ?? '';
      const board = (req as BoardRequest).board?.id ?? '';
      const wanted = req.query.wait === undefined ? chat.pollDefaultWaitSeconds : Number(req.query.wait);
      const waitSec = Number.isFinite(wanted) ? Math.min(Math.max(Math.floor(wanted), 0), chat.pollMaxWaitSeconds) : chat.pollDefaultWaitSeconds;
      const user = run(req, false, (_db, ctx) => ctx.user);
      const since = req.query.since === undefined
        ? withAchievementsDb(ach, (db) => headSeq(db), { readonly: true })
        : Math.max(0, Math.floor(Number(req.query.since)) || 0);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const events: EventRec[] = await waitForEvents({
        sid, board, waitMs: waitSec * 1000, maxHeldPerBoard: chat.heldPollsPerBoard, signal: abort.signal,
        fetch: () => withAchievementsDb(ach, (db) => fetchVisibleEvents(db, sid, user, since, board), { readonly: true }),
      });
      if (abort.signal.aborted) return;
      const out = withAchievementsDb(ach, (db) => {
        // The session may have been replaced or have expired while held; touch it again.
        context(db, req, false);
        const cache = new Map<string, string>();
        const labels = displayLabels([...events.map((e) => e.user), ...store.memberUsers(db, events.map((e) => e.room_id ?? ''))]);
        const text = (e: EventRec): string => (e.type === 'message' || e.type === 'edit' ? markOrigin(e.user, e.text) : e.text);
        return events.map((e) => [e.seq, e.type, e.label, e.user, e.ref, e.at, roleColor(db, cache, e.user), text(e), e.reply_to, e.user ? labels.get(e.user) ?? e.user : '']);
      });
      // A 68K reply buffer is 8 KB: stop before the reply passes maxBytes and let the client poll on from the last seq.
      const fitted = fitRows(out, clampMaxBytes(req.query.maxBytes));
      const last = fitted.length > 0 ? events[fitted.length - 1].seq : since;
      sendText(res, renderText('EVENTS', last, fitted));
    } catch (err) {
      next(err);
    }
  });

  // ---- moderation ----
  for (const action of ['kick', 'ban', 'unban', 'mute', 'unmute'] as const) {
    router.post(`/rooms/:id/${action}`, (req: Request, res: Response) => {
      run(req, true, (db, ctx) => store.moderate(db, ctx, p(req, 'id'), action, body(req)));
      res.json({ ok: true });
    });
  }
  router.post('/rooms/:id/op', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.setOp(db, ctx, p(req, 'id'), body(req), true));
    res.json({ ok: true });
  });
  router.post('/rooms/:id/deop', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.setOp(db, ctx, p(req, 'id'), body(req), false));
    res.json({ ok: true });
  });
  router.post('/rooms/:id/mode', (req: Request, res: Response) => {
    res.json(run(req, true, (db, ctx) => store.setMode(db, ctx, p(req, 'id'), body(req))));
  });
  router.post('/rooms/:id/typing', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.setTyping(db, ctx, p(req, 'id'), body(req)));
    res.json({ ok: true });
  });
  router.get('/rooms/:id/canvas.txt', (req: Request, res: Response) => {
    const out = run(req, false, (db, ctx) => store.getCanvas(db, ctx, p(req, 'id'), req.query));
    sendText(res, renderText('CANVAS', out.rev, out.rows));
  });
  router.post('/rooms/:id/canvas', (req: Request, res: Response) => {
    res.json(run(req, true, (db, ctx) => store.applyCanvasOps(db, ctx, p(req, 'id'), body(req))));
  });
  router.put('/rooms/:id/motd', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.setRoomMotd(db, ctx, p(req, 'id'), body(req)));
    res.json({ ok: true });
  });
  router.put('/rooms/:id/topic', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.setTopic(db, ctx, p(req, 'id'), body(req)));
    res.json({ ok: true });
  });
  router.put('/rooms/:id/visibility', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.setVisibility(db, ctx, p(req, 'id'), body(req)));
    res.json({ ok: true });
  });
  router.delete('/rooms/:id', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.deleteRoom(db, ctx, p(req, 'id')));
    res.json({ ok: true });
  });
  router.post('/rooms/:id/clear', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.clearRoom(db, ctx, p(req, 'id')));
    res.json({ ok: true });
  });

  // ---- motd ----
  router.get('/motd', (req: Request, res: Response) => {
    res.json({ text: run(req, false, (db) => store.getMotd(db)) });
  });
  router.put('/motd', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.setMotd(db, ctx, body(req)));
    res.json({ ok: true });
  });

  // ---- Discord mirror: the board sysop's /discord on|off; the bridge reads the board list ----
  router.get('/discord', (req: Request, res: Response) => {
    res.json({ on: run(req, false, (db, ctx) => store.getDiscordMirror(db, ctx)) });
  });
  router.put('/discord', (req: Request, res: Response) => {
    res.json({ on: run(req, true, (db, ctx) => store.setDiscordMirror(db, ctx, body(req))) });
  });
  router.get('/discord/boards.txt', (req: Request, res: Response) => {
    const out = run(req, false, (db) => ({ rev: headSeq(db), rows: store.discordMirrorBoards(db).map((b) => [b]) }));
    sendText(res, renderText('DISCORD', out.rev, out.rows));
  });

  // ---- roles: the sysop of a board manages that board's roles; an admin names ?board= ----
  const roleBoard = (req: Request, ctx: ChatCtx): string => {
    requireSysop(ctx);
    const b = ctx.admin && !ctx.boardId ? String(req.query.board ?? '').toLowerCase() : ctx.boardId;
    if (!b) throw new SurfaceError('bad_request', 400, 'board is required');
    return b;
  };
  router.get('/roles', (req: Request, res: Response) => {
    res.json(run(req, false, (db, ctx) => roles.listRoles(db, roleBoard(req, ctx))));
  });
  router.post('/roles', (req: Request, res: Response) => {
    res.status(201).json(run(req, true, (db, ctx) => roles.createRole(db, roleBoard(req, ctx), body(req))));
  });
  router.get('/roles/assignments', (req: Request, res: Response) => {
    res.json(run(req, false, (db, ctx) => roles.listAssignments(db, roleBoard(req, ctx))));
  });
  router.put('/roles/assignments/:handle', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => roles.setAssignments(db, roleBoard(req, ctx), p(req, 'handle'), body(req).roleIds));
    res.json({ ok: true });
  });
  router.put('/roles/:id', (req: Request, res: Response) => {
    res.json(run(req, true, (db, ctx) => roles.updateRole(db, roleBoard(req, ctx), p(req, 'id'), body(req))));
  });
  router.delete('/roles/:id', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => roles.deleteRole(db, roleBoard(req, ctx), p(req, 'id')));
    res.json({ ok: true });
  });

  // ---- optional: pins, search, emoji ----
  router.get('/rooms/:id/pins', (req: Request, res: Response) => {
    res.json(run(req, false, (db, ctx) => store.listPins(db, ctx, p(req, 'id'))));
  });
  router.post('/rooms/:id/pins', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.pin(db, ctx, p(req, 'id'), body(req), true));
    res.status(201).json({ ok: true });
  });
  router.delete('/rooms/:id/pins/:messageId', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.pin(db, ctx, p(req, 'id'), {}, false, p(req, 'messageId')));
    res.json({ ok: true });
  });
  router.get('/search', (req: Request, res: Response) => {
    res.json(run(req, false, (db, ctx) => store.search(db, ctx, req.query)));
  });
  router.get('/emoji', (req: Request, res: Response) => {
    res.json(run(req, false, (db) => store.listEmoji(db)));
  });
  // The 68K door's list: image data URLs do not fit its reply buffer, so the text form carries only the text fields.
  router.get('/emoji.txt', (req: Request, res: Response) => {
    const out = run(req, false, (db) => ({ rev: headSeq(db), rows: store.listEmoji(db) }));
    sendText(res, renderText('EMOJI', out.rev, out.rows.map((r) => [r.name, r.display, r.ascii])));
  });
  // A board relays its own BBS activity; board auth only, no chat session.
  router.post('/bbs-events', (req: Request, res: Response) => {
    const boardId = (req as BoardRequest).board!.id;
    withAchievementsDb(ach, (db) => db.transaction(() => store.relayBbsEvent(db, boardId, body(req)))());
    res.status(204).end();
  });
  router.put('/emoji/:name', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.putEmoji(db, ctx, p(req, 'name'), body(req), roleBoard(req, ctx)));
    res.json({ ok: true });
  });
  router.delete('/emoji/:name', (req: Request, res: Response) => {
    run(req, true, (db, ctx) => store.deleteEmoji(db, ctx, p(req, 'name'), roleBoard(req, ctx)));
    res.json({ ok: true });
  });

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', detail: 'no such chat endpoint' });
  });

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof SurfaceError) {
      if (err.retryAfter !== undefined) res.set('Retry-After', String(err.retryAfter));
      res.status(err.status).json({ error: err.code, detail: err.message, ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}) });
      return;
    }
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(400).json({ error: 'bad_request', detail: (err as Error).message });
      return;
    }
    console.error(`[ERROR] chat: ${(err as Error).message}`);
    res.status(500).json({ error: 'internal_error' });
  });

  return router;
}

export { CHAT_LIMITS };
