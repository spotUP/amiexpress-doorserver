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
import type { SessionReply } from '../../contract/chat-types';
import { SurfaceError } from '../achievements/errors';
import { charge } from '../achievements/ratelimit';
import { withAchievementsDb } from '../achievements/db';
import type { AchievementsConfig } from '../achievements/config';
import { nowSec } from './config';
import type { ChatConfig } from './config';
import { emitEvent, pruneEvents } from './events';
import { sweepFiles } from './files';

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

/** The identity on the wire: the handle and the registered board id, upper-cased. */
export function userOf(boardId: string, handle: string): string {
  return `${handle}@${boardId.toUpperCase()}`;
}

export function validHandle(handle: unknown): handle is string {
  return typeof handle === 'string' && HANDLE.test(handle);
}

/** `handle@BOARD` -> parts, or null when it is not an identity. */
export function splitUser(user: unknown): { handle: string; board: string } | null {
  if (typeof user !== 'string') return null;
  const at = user.lastIndexOf('@');
  if (at < 1) return null;
  const handle = user.slice(0, at);
  const board = user.slice(at + 1);
  if (!validHandle(handle) || board.length === 0 || /[^A-Za-z0-9-]/.test(board)) return null;
  return { handle, board: board.toLowerCase() };
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
  body: { handle?: unknown; sysop?: unknown; client?: unknown }
): SessionReply {
  if (!validHandle(body.handle)) {
    throw new SurfaceError('bad_request', 400, 'handle must be 1 to 32 characters with no whitespace, | or @');
  }
  const handle = body.handle;
  const client = typeof body.client === 'string' ? body.client.slice(0, 64) : '';
  charge([{ key: `chat:sess:${boardId}`, limit: { max: 60, windowSeconds: 60 } }]);
  sweepSessions(db, cfg);
  const live = db.prepare('SELECT COUNT(*) AS n FROM chat_sessions WHERE board_id = ?').get(boardId) as { n: number };
  if (live.n >= cfg.sessionsPerBoard) {
    throw new SurfaceError('rate_limited', 429, 'this board has too many live chat sessions', 10);
  }
  const sid = crypto.randomBytes(16).toString('hex');
  const now = nowSec();
  const user = userOf(boardId, handle);
  db.prepare(
    `INSERT INTO chat_sessions (sid, board_id, handle, user, sysop, client, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sid, boardId, handle, user, body.sysop === true ? 1 : 0, client, now, now);
  // The board's first chat session ever: the conditional UPDATE is the atomic
  // claim, so only the call that changes the row announces the board.
  const first = db.prepare('UPDATE boards SET chat_first_seen_at = ? WHERE id = ? AND chat_first_seen_at IS NULL').run(now, boardId);
  if (first.changes === 1) {
    const b = db.prepare('SELECT name FROM boards WHERE id = ?').get(boardId) as { name: string } | undefined;
    emitEvent(db, { type: 'board_joined', roomId: null, user: '', text: b?.name ?? boardId });
  }
  return { sid, user, expiresIn: cfg.sessionTtlSeconds };
}

/** Remove a session and say `left` for every room that no other session of the user keeps. */
export function expireSession(db: Database.Database, sid: string): void {
  const s = db.prepare('SELECT user FROM chat_sessions WHERE sid = ?').get(sid) as { user: string } | undefined;
  if (!s) return;
  const rooms = db.prepare('SELECT room_id FROM chat_members WHERE sid = ?').all(sid) as { room_id: string }[];
  db.prepare('DELETE FROM chat_members WHERE sid = ?').run(sid);
  db.prepare('DELETE FROM chat_sessions WHERE sid = ?').run(sid);
  if (!db.prepare('SELECT 1 FROM chat_sessions WHERE user = ?').get(s.user)) {
    db.prepare('DELETE FROM chat_presence WHERE user = ?').run(s.user);
  }
  for (const r of rooms) {
    const other = db.prepare('SELECT 1 FROM chat_members WHERE room_id = ? AND user = ?').get(r.room_id, s.user);
    if (!other) emitEvent(db, { type: 'left', roomId: r.room_id, user: s.user });
  }
}

/**
 * The live session behind a sid, touched. A stale or foreign sid is refused;
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
  db.prepare('UPDATE chat_sessions SET last_seen = ? WHERE sid = ?').run(now, sid);
  return { sid, boardId, handle: row.handle, user: row.user, sysop: row.sysop === 1, admin: false };
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
 * bare handle; the author becomes `as@<this board>`, never another board's
 * user, and loses the session's sysop/admin standing.
 */
export function actingCtx(db: Database.Database, ctx: ChatCtx, as: unknown): ChatCtx {
  if (as === undefined || as === null || as === '') return ctx;
  if (!ctx.sid) throw new SurfaceError('unauthorized', 401, 'this needs a chat session');
  const b = db.prepare('SELECT chat_relay FROM boards WHERE id = ?').get(ctx.boardId) as { chat_relay: number } | undefined;
  if (b?.chat_relay !== 1) throw new SurfaceError('not_relay', 403, 'only a relay board may speak as another user');
  if (!validHandle(as)) throw new SurfaceError('bad_request', 400, 'as must be a bare handle (no @, |, or spaces)');
  return { sid: ctx.sid, boardId: ctx.boardId, handle: as, user: userOf(ctx.boardId, as), sysop: false, admin: false, relayOf: ctx.user };
}
