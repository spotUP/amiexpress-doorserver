/**
 * Chat sessions: one row per connected client, kept alive by any request.
 *
 * A session that is silent for the TTL dies, on access (lazily, with a 401
 * session_expired) or in the sweeper, and either way the same code emits
 * `left` for every room it was in. Presence is the set of live sessions.
 */
import * as crypto from 'crypto';
import type Database from 'better-sqlite3';
import { CHAT_LIMITS } from '../../contract/chat-types';
import type { NeedsAccountReply, SessionReply } from '../../contract/chat-types';
import { SurfaceError } from '../achievements/errors';
import { charge } from '../achievements/ratelimit';
import { withAchievementsDb } from '../achievements/db';
import type { AchievementsConfig } from '../achievements/config';
import { activeWindowSeconds, nowSec } from './config';
import type { ChatConfig } from './config';
import { emitEvent, pruneEvents } from './events';
import { sweepFiles } from './files';
import { accountByHandle, botAccount, cleanPrefill, handleFree, isGlobalAdmin, linkedAccount, validBbsUser } from './accounts';
import type { AccountRow } from './accounts';

export interface ChatCtx {
  sid: string | null;
  boardId: string;
  handle: string;
  user: string;
  sysop: boolean;
  admin: boolean;
  /**
   * Set when a relay board's session speaks `as` one of its users: the
   * session's own user (`bridge@DISCORD`). `user`/`handle` are then the
   * relayed author; room membership is the session's, bans and mutes the
   * author's.
   */
  relayOf?: string;
}

const HANDLE = /^[^\s|@]{1,32}$/;

/**
 * The old per-board identity `handle@BOARD`: a board session without an account link, and a relay
 * board's unlinked author. An account's user key is its bare handle (accounts.ts).
 */
export function userOf(boardId: string, handle: string): string {
  return `${handle}@${boardId.toUpperCase()}`;
}

export function validHandle(handle: unknown): handle is string {
  return typeof handle === 'string' && HANDLE.test(handle);
}

/** A user key -> parts, or null when it is not an identity. An account handle has board ''; `handle@BOARD` its board, lower-cased. */
export function splitUser(user: unknown): { handle: string; board: string } | null {
  if (typeof user !== 'string') return null;
  const at = user.lastIndexOf('@');
  if (at < 0) return validHandle(user) ? { handle: user, board: '' } : null;
  if (at < 1) return null;
  const handle = user.slice(0, at);
  const board = user.slice(at + 1);
  if (!validHandle(handle) || board.length === 0 || /[^A-Za-z0-9-]/.test(board)) return null;
  return { handle, board: board.toLowerCase() };
}

/** Every user a board opened as a bot (createSession `bot: true`), for displayLabels. */
export function botUsers(db: Database.Database): Set<string> {
  return new Set((db.prepare('SELECT user FROM chat_bots').all() as { user: string }[]).map((r) => r.user));
}

export function newId(prefix: string): string {
  return prefix + crypto.randomBytes(6).toString('hex');
}

interface SessionRow {
  sid: string;
  board_id: string;
  handle: string;
  user: string;
  sysop: number;
  last_seen: number;
}

export function createSession(
  db: Database.Database,
  cfg: ChatConfig,
  boardId: string,
  body: { handle?: unknown; bbs_user?: unknown; sysop?: unknown; client?: unknown; bot?: unknown }
): SessionReply {
  // The BBS user the board vouches for. `handle` is the pre-account spelling of the same thing.
  const bbsUser = body.bbs_user ?? body.handle;
  if (!validBbsUser(bbsUser)) throw new SurfaceError('bad_request', 400, 'bbs_user is required');
  charge([{ key: `chat:sess:${boardId}`, limit: { max: 60, windowSeconds: 60 } }]);
  sweepSessions(db, cfg);
  const live = db.prepare('SELECT COUNT(*) AS n FROM chat_sessions WHERE board_id = ?').get(boardId) as { n: number };
  if (live.n >= cfg.sessionsPerBoard) {
    throw new SurfaceError('rate_limited', 429, 'this board has too many live chat sessions', 10);
  }
  // `bot` is set by the board's own code under its board token (like `sysop`); a caller only picks a name.
  if (body.bot === true) return openSession(db, cfg, boardId, botAccount(db, boardId, bbsUser).handle, null, body);
  // A board reaches an account only through its own link (accounts.ts); a bot's link is the bot's alone.
  const linked = linkedAccount(db, boardId, bbsUser);
  if (linked) {
    if (linked.bot === 1) throw new SurfaceError('conflict', 409, 'that handle belongs to this board\'s bot');
    return openSession(db, cfg, boardId, linked.handle, null, body);
  }
  // No link: the old per-board identity `handle@BOARD`. It is never an account, whatever its handle.
  // shortcut: kept so boards and tests that predate accounts still chat; remove once every client sends bbs_user and handles needs_account.
  if (!validHandle(bbsUser)) {
    throw new SurfaceError('bad_request', 400, 'handle must be 1 to 32 characters with no whitespace, | or @');
  }
  const legacy = userOf(boardId, bbsUser);
  if (accountByHandle(db, bbsUser)?.bot === 1 || db.prepare('SELECT 1 FROM chat_bots WHERE lower(user) = lower(?)').get(legacy)) {
    throw new SurfaceError('conflict', 409, 'that handle belongs to a bot');
  }
  return openSession(db, cfg, boardId, bbsUser, legacy, body);
}

/**
 * POST /sessions from a board: the session of the linked account, or, for a `bbs_user` with no
 * link, `needs_account` and no session (the caller then registers or links through the board).
 */
export function boardSession(
  db: Database.Database,
  cfg: ChatConfig,
  boardId: string,
  body: { handle?: unknown; bbs_user?: unknown; prefill?: unknown; sysop?: unknown; client?: unknown; bot?: unknown }
): SessionReply | NeedsAccountReply {
  if (body.bbs_user !== undefined && body.bot !== true && validBbsUser(body.bbs_user) && !linkedAccount(db, boardId, body.bbs_user)) {
    const prefill = cleanPrefill(body.prefill);
    return { needs_account: true, prefill, handle_free: handleFree(db, prefill.handle ?? body.bbs_user) };
  }
  return createSession(db, cfg, boardId, body);
}

/** A session for a caller who proved the account itself (token or password); it belongs to no board. */
export function accountSession(db: Database.Database, cfg: ChatConfig, account: AccountRow, body: { client?: unknown }): SessionReply {
  charge([{ key: `chat:sess:acct:${account.id}`, limit: { max: 20, windowSeconds: 60 } }]);
  sweepSessions(db, cfg);
  return openSession(db, cfg, '', account.handle, null, body);
}

/** A fresh session for a caller who already logged in (PLP/1 login, and its renewal): board '' is an account login. */
export function loginSession(
  db: Database.Database,
  cfg: ChatConfig,
  boardId: string,
  body: { handle: string; sysop?: unknown; client?: unknown }
): SessionReply {
  if (boardId !== '') return createSession(db, cfg, boardId, body);
  const account = accountByHandle(db, body.handle);
  if (!account || account.bot === 1) throw new SurfaceError('unauthorized', 401, 'wrong handle or password');
  return accountSession(db, cfg, account, body);
}

/** Insert the session row. `legacyUser` null: an account session, keyed by the bare handle. */
export function openSession(
  db: Database.Database,
  cfg: ChatConfig,
  boardId: string,
  handle: string,
  legacyUser: string | null,
  body: { sysop?: unknown; client?: unknown }
): SessionReply {
  const client = typeof body.client === 'string' ? body.client.slice(0, 64) : '';
  const sid = crypto.randomBytes(16).toString('hex');
  const now = nowSec();
  const user = legacyUser ?? handle;
  // Only a board says who its sysop is; a board-less session has none.
  db.prepare(
    `INSERT INTO chat_sessions (sid, board_id, handle, user, sysop, client, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sid, boardId, handle, user, boardId !== '' && body.sysop === true ? 1 : 0, client, now, now);
  // The hub's own `away` (last session expired) ends with the first new session.
  db.prepare('DELETE FROM chat_presence WHERE user = ? AND auto = 1').run(user);
  // The board's first chat session ever: the conditional UPDATE is the atomic
  // claim, so only the call that changes the row announces the board.
  const first = db.prepare('UPDATE boards SET chat_first_seen_at = ? WHERE id = ? AND chat_first_seen_at IS NULL').run(now, boardId);
  if (first.changes === 1) {
    const b = db.prepare('SELECT name FROM boards WHERE id = ?').get(boardId) as { name: string } | undefined;
    emitEvent(db, { type: 'board_joined', roomId: null, user: '', text: b?.name ?? boardId });
  }
  return { sid, user, expiresIn: cfg.sessionTtlSeconds, activeWindow: activeWindowSeconds(db) };
}

/** Remove a session and say `left` for every room that no other session of the user keeps. */
export function expireSession(db: Database.Database, sid: string): void {
  const s = db.prepare('SELECT user FROM chat_sessions WHERE sid = ?').get(sid) as { user: string } | undefined;
  if (!s) return;
  const rooms = db.prepare('SELECT room_id FROM chat_members WHERE sid = ?').all(sid) as { room_id: string }[];
  db.prepare('DELETE FROM chat_members WHERE sid = ?').run(sid);
  db.prepare('DELETE FROM chat_sessions WHERE sid = ?').run(sid);
  if (!db.prepare('SELECT 1 FROM chat_sessions WHERE user = ?').get(s.user)) {
    // A user who stays a member of some room is shown away, not gone. A status the user set
    // (busy, dnd, their own away text) survives; only the hub's own away is written here.
    const kept = db.prepare('SELECT 1 FROM chat_memberships WHERE user = ?').get(s.user);
    if (kept) {
      db.prepare(
        `INSERT INTO chat_presence (user, status, text, updated_at, auto) VALUES (?, 'away', '', ?, 1)
         ON CONFLICT(user) DO UPDATE SET status = 'away', text = '', updated_at = excluded.updated_at, auto = 1
         WHERE chat_presence.auto = 1`
      ).run(s.user, nowSec());
    } else {
      db.prepare('DELETE FROM chat_presence WHERE user = ?').run(s.user);
    }
  }
  for (const r of rooms) {
    const other = db.prepare('SELECT 1 FROM chat_members WHERE room_id = ? AND user = ?').get(r.room_id, s.user);
    if (!other) emitEvent(db, { type: 'left', roomId: r.room_id, user: s.user });
  }
}

/** How old a stored last_seen may get before resolveSession rewrites it: 15 s, or a sixth of a short test TTL. */
export function lastSeenSlackSeconds(cfg: ChatConfig): number {
  return Math.min(15, Math.floor(cfg.sessionTtlSeconds / 6));
}

/**
 * The live session behind a sid, touched when its stamp is older than the slack. A stale or foreign sid is refused;
 * a stale one is removed first, committed on its own so the refusal cannot
 * roll the `left` events back.
 */
export function resolveSession(db: Database.Database, cfg: ChatConfig, sid: string, boardId: string): ChatCtx {
  const row = db.prepare('SELECT sid, board_id, handle, user, sysop, last_seen FROM chat_sessions WHERE sid = ?').get(sid) as
    | SessionRow
    | undefined;
  if (!row) throw new SurfaceError('session_expired', 401, 'the session is gone; start a new one');
  if (row.board_id !== boardId) throw new SurfaceError('unauthorized', 401, 'that session belongs to another board');
  const now = nowSec();
  if (now - row.last_seen > cfg.sessionTtlSeconds) {
    db.transaction(() => expireSession(db, sid)).immediate();
    throw new SurfaceError('session_expired', 401, 'the session timed out; start a new one');
  }
  // The touch is a write transaction (journal create/fsync/delete) on every request; voice PUTs
  // at 2/s made it the hub's p95. Only a stale stamp is rewritten: a client then stays alive
  // while its request gap is under ttl - slack (90 - 15 = 75 s), and `idle` reads in slack steps.
  if (now - row.last_seen >= lastSeenSlackSeconds(cfg)) {
    db.prepare('UPDATE chat_sessions SET last_seen = ? WHERE sid = ?').run(now, sid);
  }
  // D6: a global admin is an account (a bare-handle user key); `handle@BOARD` never matches the list.
  return { sid, boardId, handle: row.handle, user: row.user, sysop: row.sysop === 1, admin: isGlobalAdmin(cfg, row.user) };
}

/** The Partyline room and /draw mode this session was on (migration 22), for a resume onto a new screen. */
export function getScreenPlace(db: Database.Database, sid: string): { roomId: string; canvas: boolean } {
  const r = db.prepare('SELECT pl_room, pl_canvas FROM chat_sessions WHERE sid = ?').get(sid) as { pl_room: string; pl_canvas: number } | undefined;
  return { roomId: r?.pl_room ?? '', canvas: r?.pl_canvas === 1 };
}

export function setScreenPlace(db: Database.Database, sid: string, roomId: string, canvas: boolean): void {
  db.prepare('UPDATE chat_sessions SET pl_room = ?, pl_canvas = ? WHERE sid = ?').run(roomId, canvas ? 1 : 0, sid);
}

export function sweepSessions(db: Database.Database, cfg: ChatConfig): number {
  const stale = db
    .prepare('SELECT sid FROM chat_sessions WHERE last_seen < ?')
    .all(nowSec() - cfg.sessionTtlSeconds) as { sid: string }[];
  if (stale.length === 0) return 0;
  db.transaction(() => {
    for (const s of stale) expireSession(db, s.sid);
  }).immediate();
  return stale.length;
}

/** A timed mute that ran out is deleted and announced as `unmuted` (ref 'system'), like a manual unmute. */
export function sweepMutes(db: Database.Database): number {
  return db.transaction(() => {
    const done = db.prepare('SELECT room_id, user FROM chat_mutes WHERE until IS NOT NULL AND until <= ?').all(nowSec()) as { room_id: string; user: string }[];
    for (const m of done) {
      db.prepare('DELETE FROM chat_mutes WHERE room_id = ? AND user = ?').run(m.room_id, m.user);
      emitEvent(db, { type: 'unmuted', roomId: m.room_id, user: m.user, ref: 'system' });
    }
    return done.length;
  }).immediate();
}

// ---- the sweeper: one timer per database file ----

const sweepers = new Map<string, NodeJS.Timeout>();
const SWEEP_MS = 15_000;
const PRUNE_EVERY = 240; // sweeps: hourly

export function startSweeper(ach: AchievementsConfig, cfg: ChatConfig, filesDir: string | null = null): void {
  if (sweepers.has(ach.dbPath)) return;
  let ticks = 0;
  const timer = setInterval(() => {
    try {
      withAchievementsDb(ach, (db) => {
        sweepSessions(db, cfg);
        sweepMutes(db);
        sweepFiles(db, filesDir);
        ticks += 1;
        if (ticks % PRUNE_EVERY === 1) pruneEvents(db, cfg.eventsKept ?? CHAT_LIMITS.eventsKept);
      });
    } catch (err) {
      console.error(`[ERROR] chat sweeper: ${(err as Error).message}`);
    }
  }, SWEEP_MS);
  timer.unref();
  sweepers.set(ach.dbPath, timer);
}

export function _stopChatSweepersForTests(): void {
  for (const t of sweepers.values()) clearInterval(t);
  sweepers.clear();
}

/**
 * The identity a request acts as. No `as`: the session itself. With `as`: the
 * board must be a relay board (admin-set boards.chat_relay) and `as` a valid
 * bare handle; the author becomes the account this board linked `as` to, else
 * `as@<this board>`, never another board's user, and loses the session's
 * sysop/admin standing.
 */
export function actingCtx(db: Database.Database, ctx: ChatCtx, as: unknown): ChatCtx {
  if (as === undefined || as === null || as === '') return ctx;
  if (!ctx.sid) throw new SurfaceError('unauthorized', 401, 'this needs a chat session');
  const b = db.prepare('SELECT chat_relay FROM boards WHERE id = ?').get(ctx.boardId) as { chat_relay: number } | undefined;
  if (b?.chat_relay !== 1) throw new SurfaceError('not_relay', 403, 'only a relay board may speak as another user');
  if (!validHandle(as)) throw new SurfaceError('bad_request', 400, 'as must be a bare handle (no @, |, or spaces)');
  const handle = linkedAccount(db, ctx.boardId, as)?.handle;
  return { sid: ctx.sid, boardId: ctx.boardId, handle: handle ?? as, user: handle ?? userOf(ctx.boardId, as), sysop: false, admin: false, relayOf: ctx.user };
}
