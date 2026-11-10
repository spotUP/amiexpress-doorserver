/**
 * The chat domain: rooms, messages, reactions, threads, direct messages,
 * moderation, pins, search. Every function takes an open database handle and
 * runs inside the caller's transaction; none awaits.
 */
import * as crypto from 'crypto';
import type Database from 'better-sqlite3';
import { BBS_EVENT_DATA_KEYS, BBS_EVENT_TYPES, CHAT_DEFAULT_ROOM_KEY, CHAT_LIMITS, CHAT_ROOM_KINDS } from '../../contract/chat-types';
import type {
  ChatRoomKind, ChatVisibility, CreateRoomReply, DmPostReply, EditMessageReply, EmojiRow, JoinReply, PinRow,
  PostMessageReply, ReactReply, RoomRow, SearchHit,
} from '../../contract/chat-types';
import { SurfaceError } from '../achievements/errors';
import { charge } from '../achievements/ratelimit';
import { nowSec } from './config';
import { emitEvent, headSeq } from './events';
import { getRoom, isMember, isOp, isOwnerLevel, isRoomStaff, requireMod, requireOwner, requireSysop } from './permissions';
import type { RoomRec } from './permissions';
import { permsOf } from './roles';
import { newId, splitUser, validHandle } from './sessions';
import type { ChatCtx } from './sessions';

export type Body = Record<string, unknown>;

function str(b: Body, k: string, max: number, opts: { empty?: boolean } = {}): string {
  const v = b[k];
  if (typeof v !== 'string') throw new SurfaceError('bad_request', 400, `${k} must be a string`);
  if (!opts.empty && v.trim().length === 0) throw new SurfaceError('bad_request', 400, `${k} must not be empty`);
  if (v.length > max) throw new SurfaceError('too_long', 400, `${k} is longer than ${max} characters`);
  return v;
}

function clientId(b: Body): string {
  const v = b.clientId;
  if (typeof v !== 'string' || v.length === 0) throw new SurfaceError('bad_request', 400, 'clientId is required');
  if (v.length > CHAT_LIMITS.clientIdMax) throw new SurfaceError('too_long', 400, 'clientId is too long');
  return v;
}

function targetUser(b: Body): string {
  const u = b.user;
  const p = splitUser(u);
  if (!p) throw new SurfaceError('bad_request', 400, 'user must be handle@BOARD');
  return u as string;
}

function chargeMessage(ctx: ChatCtx): void {
  charge([
    // A relay session carries many authors: each one gets its own allowance.
    { key: `chat:msg:${ctx.relayOf ? `${ctx.sid}:${ctx.user}` : ctx.sid ?? ctx.user}`, limit: { max: CHAT_LIMITS.messagesPerSession, windowSeconds: CHAT_LIMITS.messagesPerSessionWindowSeconds } },
    { key: `chat:board:${ctx.boardId}`, limit: { max: CHAT_LIMITS.messagesPerBoardPerMinute, windowSeconds: 60 } },
  ]);
}

function requireSession(ctx: ChatCtx): void {
  if (!ctx.sid) throw new SurfaceError('unauthorized', 401, 'this needs a chat session');
}

// ---- rooms ----

function countMembers(db: Database.Database, roomId: string): number {
  return (db.prepare('SELECT COUNT(DISTINCT user) AS n FROM chat_members WHERE room_id = ?').get(roomId) as { n: number }).n;
}

export function listRooms(db: Database.Database, ctx: ChatCtx): RoomRow[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.name, r.topic, r.visibility, r.owner_user, r.kind FROM chat_rooms r
        WHERE r.deleted_at IS NULL AND (r.visibility = 'public' OR ? = 1
              OR r.owner_user = ? OR EXISTS (SELECT 1 FROM chat_members m WHERE m.room_id = r.id AND m.user = ?)
              OR EXISTS (SELECT 1 FROM chat_invites i WHERE i.room_id = r.id AND i.user = ?))
        ORDER BY r.name_key = ? DESC, r.name_key`
    )
    .all(ctx.admin ? 1 : 0, ctx.user, ctx.user, ctx.user, CHAT_DEFAULT_ROOM_KEY) as { id: string; name: string; topic: string; visibility: ChatVisibility; owner_user: string; kind: ChatRoomKind }[];
  return rows.map((r) => ({ id: r.id, name: r.name, topic: r.topic, visibility: r.visibility, members: countMembers(db, r.id), owner: r.owner_user, kind: r.kind }));
}

export function createRoom(db: Database.Database, ctx: ChatCtx, b: Body): CreateRoomReply {
  requireSession(ctx);
  const name = str(b, 'name', CHAT_LIMITS.roomNameMax).trim();
  if (/[|\r\n\t]/.test(name)) throw new SurfaceError('bad_request', 400, 'name must not contain | or line breaks');
  const topic = b.topic === undefined ? '' : str(b, 'topic', CHAT_LIMITS.topicMax, { empty: true });
  const vis = b.visibility === undefined ? 'public' : b.visibility;
  if (vis !== 'public' && vis !== 'private') throw new SurfaceError('bad_request', 400, 'visibility must be public or private');
  const kind = b.kind === undefined ? 'text' : b.kind;
  if (!(CHAT_ROOM_KINDS as readonly unknown[]).includes(kind)) throw new SurfaceError('bad_request', 400, `kind must be one of ${CHAT_ROOM_KINDS.join(', ')}`);
  if (vis === 'private' && !ctx.sysop && !permsOf(db, ctx.boardId, ctx.handle).createPrivate) {
    throw new SurfaceError('forbidden', 403, 'you may not create private rooms');
  }
  charge([{ key: `chat:rooms:${ctx.boardId}`, limit: { max: CHAT_LIMITS.roomCreationsPerBoardPerHour, windowSeconds: 3600 } }]);
  const key = name.toLowerCase();
  if (db.prepare('SELECT 1 FROM chat_rooms WHERE name_key = ?').get(key)) throw new SurfaceError('conflict', 409, 'a room with that name exists');
  const id = newId('room');
  db.prepare('INSERT INTO chat_rooms (id, name, name_key, owner_board, owner_user, topic, visibility, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, name, key, ctx.boardId, ctx.user, topic, vis, kind, nowSec()
  );
  emitEvent(db, { type: 'room_created', roomId: id, user: ctx.user, text: name });
  return { id, name, visibility: vis, kind: kind as ChatRoomKind };
}

function canEnter(db: Database.Database, room: RoomRec, ctx: ChatCtx): boolean {
  if (room.visibility === 'public') return true;
  if (isOwnerLevel(room, ctx) || isOp(db, room.id, ctx.user)) return true;
  return db.prepare('SELECT 1 FROM chat_invites WHERE room_id = ? AND user = ?').get(room.id, ctx.user) !== undefined;
}

export function joinRoom(db: Database.Database, ctx: ChatCtx, id: string): JoinReply {
  requireSession(ctx);
  const room = getRoom(db, id);
  if (db.prepare('SELECT 1 FROM chat_bans WHERE room_id = ? AND user = ?').get(id, ctx.user)) throw new SurfaceError('banned', 403, 'you are banned from this room');
  if (!canEnter(db, room, ctx)) throw new SurfaceError('invite_required', 403, 'this room is private; ask for an invite');
  const first = !isMember(db, id, ctx.user);
  db.prepare('INSERT OR IGNORE INTO chat_members (room_id, sid, user, joined_at) VALUES (?, ?, ?, ?)').run(id, ctx.sid, ctx.user, nowSec());
  if (first) emitEvent(db, { type: 'joined', roomId: id, user: ctx.user });
  const ops = (db.prepare('SELECT user FROM chat_room_ops WHERE room_id = ? ORDER BY user').all(id) as { user: string }[]).map((r) => r.user);
  return { id, name: room.name, topic: room.topic, motd: room.motd, members: countMembers(db, id), ops, since: headSeq(db) };
}

export function leaveRoom(db: Database.Database, ctx: ChatCtx, id: string): void {
  requireSession(ctx);
  getRoom(db, id);
  db.prepare('DELETE FROM chat_members WHERE room_id = ? AND sid = ?').run(id, ctx.sid);
  if (!isMember(db, id, ctx.user)) emitEvent(db, { type: 'left', roomId: id, user: ctx.user });
}

export function roomMembers(db: Database.Database, ctx: ChatCtx, id: string): { user: string; sysop: boolean; op: boolean; status: string; statusText: string }[] {
  const room = getRoom(db, id);
  if (room.visibility === 'private' && !ctx.admin && !isMember(db, id, ctx.user)) throw new SurfaceError('not_member', 403, 'join the room first');
  const rows = db
    .prepare(
      `SELECT m.user AS user, MAX(s.sysop) AS sysop FROM chat_members m JOIN chat_sessions s ON s.sid = m.sid
        WHERE m.room_id = ? GROUP BY m.user ORDER BY m.user`
    )
    .all(id) as { user: string; sysop: number }[];
  const pres = presenceMap(db);
  return rows.map((r) => ({
    user: r.user,
    sysop: r.sysop === 1,
    op: isOp(db, id, r.user) || room.owner_user.toLowerCase() === r.user.toLowerCase(),
    ...presenceFrom(pres, r.user),
  }));
}

export function whoRows(db: Database.Database, ctx: ChatCtx): { user: string; room: string; sysop: boolean; idle: number; status: string; statusText: string }[] {
  const now = nowSec();
  const pres = presenceMap(db);
  const rows = db
    .prepare(
      `SELECT s.user, s.sysop, s.last_seen, r.name, r.visibility, r.id AS rid FROM chat_sessions s
         LEFT JOIN chat_members m ON m.sid = s.sid
         LEFT JOIN chat_rooms r ON r.id = m.room_id AND r.deleted_at IS NULL
        ORDER BY s.user, r.name`
    )
    .all() as { user: string; sysop: number; last_seen: number; name: string | null; visibility: string | null; rid: string | null }[];
  return rows.map((r) => ({
    user: r.user,
    room: r.name && (r.visibility === 'public' || ctx.admin || (r.rid !== null && isMember(db, r.rid, ctx.user))) ? r.name : '',
    sysop: r.sysop === 1,
    idle: Math.max(0, now - r.last_seen),
    ...presenceFrom(pres, r.user),
  }));
}

// ---- presence ----

export const PRESENCE_STATUSES = ['online', 'away', 'busy', 'dnd'] as const;
type Presence = { status: string; statusText: string };

function presenceMap(db: Database.Database): Map<string, Presence> {
  const rows = db.prepare('SELECT user, status, text FROM chat_presence').all() as { user: string; status: string; text: string }[];
  return new Map(rows.map((r) => [r.user.toLowerCase(), { status: r.status, statusText: r.text }]));
}

function presenceFrom(map: Map<string, Presence>, user: string): Presence {
  return map.get(user.toLowerCase()) ?? { status: 'online', statusText: '' };
}

/** Say `presence` in every room the user is in, or once with no room so the user's own sessions see it. */
function emitPresence(db: Database.Database, user: string, p: Presence): void {
  const rooms = db.prepare('SELECT DISTINCT room_id FROM chat_members WHERE user = ?').all(user) as { room_id: string }[];
  const text = `${p.status}|${p.statusText}`;
  if (rooms.length === 0) emitEvent(db, { type: 'presence', roomId: null, label: '', user, text });
  for (const r of rooms) emitEvent(db, { type: 'presence', roomId: r.room_id, user, text });
}

/** Set (`/status`, `/away`) the caller's status. `online` with no text is the same as `/back`. */
export function setPresence(db: Database.Database, ctx: ChatCtx, b: Body): Presence {
  requireSession(ctx);
  const status = b.status;
  if (typeof status !== 'string' || !(PRESENCE_STATUSES as readonly string[]).includes(status)) {
    throw new SurfaceError('bad_request', 400, 'status must be online, away, busy or dnd');
  }
  const text = b.text === undefined ? '' : str(b, 'text', CHAT_LIMITS.statusTextMax, { empty: true });
  if (status === 'online' && text === '') return clearPresence(db, ctx);
  db.prepare(
    `INSERT INTO chat_presence (user, status, text, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user) DO UPDATE SET status = excluded.status, text = excluded.text, updated_at = excluded.updated_at`
  ).run(ctx.user, status, text, nowSec());
  const out = { status, statusText: text };
  emitPresence(db, ctx.user, out);
  return out;
}

/** `/back`. */
export function clearPresence(db: Database.Database, ctx: ChatCtx): Presence {
  requireSession(ctx);
  db.prepare('DELETE FROM chat_presence WHERE user = ?').run(ctx.user);
  const out = { status: 'online', statusText: '' };
  emitPresence(db, ctx.user, out);
  return out;
}

// ---- profile ----

export interface ProfileRec {
  user: string; nick: string; board: string; status: string; statusText: string;
  firstSeen: number; lastSeen: number; idle: number | ''; online: boolean; sharedRooms: string;
}

/** What the server already holds about a user: sessions, events, presence, room membership. Nothing new is stored. */
export function profileOf(db: Database.Database, ctx: ChatCtx, userParam: string): ProfileRec {
  requireSession(ctx);
  const parts = splitUser(userParam);
  if (!parts) throw new SurfaceError('bad_request', 400, 'user must be handle@BOARD');
  const live = db.prepare('SELECT user, handle, MAX(last_seen) AS last_seen, MIN(created_at) AS created FROM chat_sessions WHERE user = ?').get(userParam) as
    { user: string | null; handle: string | null; last_seen: number | null; created: number | null };
  const ev = db.prepare('SELECT MIN(at) AS first, MAX(at) AS last, MIN(user) AS user FROM chat_events WHERE user = ?').get(userParam) as
    { first: number | null; last: number | null; user: string | null };
  if (live.user === null && ev.user === null) throw new SurfaceError('not_found', 404, 'no such chat user');
  const canonical = live.user ?? ev.user ?? userParam;
  const firsts = [live.created, ev.first].filter((x): x is number => x !== null);
  const lasts = [live.last_seen, ev.last].filter((x): x is number => x !== null);
  const online = live.user !== null;
  const pres = online ? presenceFrom(presenceMap(db), canonical) : { status: 'offline', statusText: '' };
  const shared = db
    .prepare(
      `SELECT DISTINCT r.id FROM chat_members a
         JOIN chat_members b ON b.room_id = a.room_id AND b.user = ?
         JOIN chat_rooms r ON r.id = a.room_id AND r.deleted_at IS NULL
        WHERE a.user = ? ORDER BY r.name_key`
    )
    .all(canonical, ctx.user) as { id: string }[];
  const split = splitUser(canonical)!;
  return {
    user: canonical,
    nick: split.handle,
    board: split.board.toUpperCase(),
    ...pres,
    firstSeen: Math.min(...firsts),
    lastSeen: online ? nowSec() : Math.max(...lasts),
    idle: online ? Math.max(0, nowSec() - (live.last_seen ?? nowSec())) : '',
    online,
    sharedRooms: shared.map((r) => r.id).join(','),
  };
}

// ---- ignore list ----

/** Storage only: the server does not filter anything; a door hides the ignored user's lines itself. */
export function listIgnores(db: Database.Database, ctx: ChatCtx): { user: string; at: number }[] {
  requireSession(ctx);
  return db.prepare('SELECT target AS user, at FROM chat_ignores WHERE owner = ? ORDER BY at, target').all(ctx.user) as { user: string; at: number }[];
}

export function addIgnore(db: Database.Database, ctx: ChatCtx, b: Body): void {
  requireSession(ctx);
  const target = targetUser(b);
  if (target.toLowerCase() === ctx.user.toLowerCase()) throw new SurfaceError('bad_request', 400, 'you cannot ignore yourself');
  const have = (db.prepare('SELECT COUNT(*) AS n FROM chat_ignores WHERE owner = ?').get(ctx.user) as { n: number }).n;
  if (have >= CHAT_LIMITS.ignoresPerUser && !db.prepare('SELECT 1 FROM chat_ignores WHERE owner = ? AND target = ?').get(ctx.user, target)) {
    throw new SurfaceError('too_long', 400, `the ignore list is limited to ${CHAT_LIMITS.ignoresPerUser} users`);
  }
  db.prepare('INSERT OR IGNORE INTO chat_ignores (owner, target, at) VALUES (?, ?, ?)').run(ctx.user, target, nowSec());
}

export function removeIgnore(db: Database.Database, ctx: ChatCtx, target: string): void {
  requireSession(ctx);
  db.prepare('DELETE FROM chat_ignores WHERE owner = ? AND target = ?').run(ctx.user, target);
}

// ---- messages ----

interface MsgRow {
  id: string; seq: number; room_id: string; user: string; content: string; client_id: string;
  reply_to: string | null; thread_id: string | null; created_at: number; edited_at: number | null; deleted_at: number | null;
}

function getMessage(db: Database.Database, id: string): MsgRow {
  const m = db.prepare('SELECT * FROM chat_messages WHERE id = ? AND deleted_at IS NULL').get(id) as MsgRow | undefined;
  if (!m) throw new SurfaceError('not_found', 404, 'no such message');
  return m;
}

function requireMemberOf(db: Database.Database, roomId: string, ctx: ChatCtx): void {
  // A relayed author is never a member itself: the relay session is, and a
  // room ban on the author (which evicts ordinary users) is checked here.
  if (!isMember(db, roomId, ctx.relayOf ?? ctx.user)) throw new SurfaceError('not_member', 403, 'join the room first');
  if (ctx.relayOf && db.prepare('SELECT 1 FROM chat_bans WHERE room_id = ? AND user = ?').get(roomId, ctx.user)) {
    throw new SurfaceError('banned', 403, 'you are banned from this room');
  }
}

function requireNotMuted(db: Database.Database, roomId: string, user: string): void {
  const m = db.prepare('SELECT until FROM chat_mutes WHERE room_id = ? AND user = ?').get(roomId, user) as { until: number | null } | undefined;
  if (m && (m.until === null || m.until > nowSec())) throw new SurfaceError('muted', 403, 'you are muted in this room');
}

/** +m (moderated): only the room's staff and voiced users may speak. */
function requireVoice(db: Database.Database, room: RoomRec, ctx: ChatCtx): void {
  if (!room.moderated || isRoomStaff(db, room, ctx)) return;
  if (db.prepare('SELECT 1 FROM chat_room_voices WHERE room_id = ? AND user = ?').get(room.id, ctx.user) !== undefined) return;
  throw new SurfaceError('moderated', 403, 'Room is moderated (+m); you need voice (+v) or op (+o) to speak');
}

function indexFts(db: Database.Database, id: string): void {
  db.prepare("INSERT INTO chat_messages_fts(rowid, content) SELECT rowid, content FROM chat_messages WHERE id = ?").run(id);
}

function unindexFts(db: Database.Database, id: string): void {
  db.prepare("INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) SELECT 'delete', rowid, content FROM chat_messages WHERE id = ?").run(id);
}

export function postMessage(db: Database.Database, ctx: ChatCtx, roomId: string, b: Body, parent?: MsgRow): PostMessageReply {
  requireSession(ctx);
  const room = getRoom(db, roomId);
  const content = str(b, 'content', CHAT_LIMITS.contentMax);
  const cid = clientId(b);
  const dup = db.prepare('SELECT id, seq, created_at FROM chat_messages WHERE room_id = ? AND user = ? AND client_id = ?').get(roomId, ctx.user, cid) as
    | { id: string; seq: number; created_at: number } | undefined;
  if (dup) return { id: dup.id, seq: dup.seq, at: dup.created_at };
  requireMemberOf(db, roomId, ctx);
  requireNotMuted(db, roomId, ctx.user);
  requireVoice(db, room, ctx);
  chargeMessage(ctx);
  let replyTo: string | null = null;
  if (typeof b.replyTo === 'string' && b.replyTo) {
    const target = getMessage(db, b.replyTo);
    if (target.room_id !== roomId) throw new SurfaceError('bad_request', 400, 'replyTo is in another room');
    replyTo = target.id;
  }
  let threadId: string | null = parent ? parent.id : null;
  if (!parent && typeof b.threadId === 'string' && b.threadId) {
    const t = getMessage(db, b.threadId);
    if (t.room_id !== roomId || t.thread_id) throw new SurfaceError('bad_request', 400, 'threadId must be a top-level message of this room');
    threadId = t.id;
  }
  const id = newId('m');
  const at = nowSec();
  db.prepare('INSERT INTO chat_messages (id, seq, room_id, user, content, client_id, reply_to, thread_id, created_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)').run(
    id, roomId, ctx.user, content, cid, replyTo, threadId, at
  );
  indexFts(db, id);
  const seq = emitEvent(db, { type: 'message', roomId, label: threadId ? `thread:${threadId}` : room.id, user: ctx.user, ref: id, text: content });
  db.prepare('UPDATE chat_messages SET seq = ? WHERE id = ?').run(seq, id);
  return { id, seq, at };
}

export function postThread(db: Database.Database, ctx: ChatCtx, messageId: string, b: Body): PostMessageReply {
  const parent = getMessage(db, messageId);
  if (parent.thread_id) throw new SurfaceError('bad_request', 400, 'threads do not nest');
  return postMessage(db, ctx, parent.room_id, b, parent);
}

export function editMessage(db: Database.Database, ctx: ChatCtx, id: string, b: Body): EditMessageReply {
  requireSession(ctx);
  const m = getMessage(db, id);
  if (m.user.toLowerCase() !== ctx.user.toLowerCase()) throw new SurfaceError('forbidden', 403, 'only the author may edit a message');
  requireNotMuted(db, m.room_id, ctx.user);
  const content = str(b, 'content', CHAT_LIMITS.contentMax);
  unindexFts(db, id);
  db.prepare('UPDATE chat_messages SET content = ?, edited_at = ? WHERE id = ?').run(content, nowSec(), id);
  indexFts(db, id);
  const seq = emitEvent(db, { type: 'edit', roomId: m.room_id, label: m.thread_id ? `thread:${m.thread_id}` : m.room_id, user: ctx.user, ref: id, text: content });
  return { id, seq };
}

export function deleteMessage(db: Database.Database, ctx: ChatCtx, id: string): void {
  const m = getMessage(db, id);
  if (m.user.toLowerCase() !== ctx.user.toLowerCase()) requireMod(db, getRoom(db, m.room_id), ctx, 'kick', m.user);
  unindexFts(db, id);
  db.prepare('UPDATE chat_messages SET deleted_at = ? WHERE id = ?').run(nowSec(), id);
  db.prepare('DELETE FROM chat_pins WHERE message_id = ?').run(id);
  emitEvent(db, { type: 'delete', roomId: m.room_id, label: m.thread_id ? `thread:${m.thread_id}` : m.room_id, user: ctx.user, ref: id });
}

export interface HistoryRec { seq: number; id: string; user: string; at: number; replyTo: string; threadId: string; text: string }

function pageArgs(q: { before?: unknown; limit?: unknown }): { before: number; limit: number } {
  const before = Number(q.before);
  const limit = Number(q.limit);
  return {
    before: Number.isInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER,
    limit: Number.isInteger(limit) && limit >= 1 ? Math.min(limit, CHAT_LIMITS.historyMax) : CHAT_LIMITS.historyDefault,
  };
}

export function roomHistory(db: Database.Database, ctx: ChatCtx, id: string, q: { before?: unknown; limit?: unknown }): HistoryRec[] {
  const room = getRoom(db, id);
  if (room.visibility === 'private' && !ctx.admin) requireMemberOf(db, id, ctx);
  const { before, limit } = pageArgs(q);
  const rows = db
    .prepare('SELECT * FROM chat_messages WHERE room_id = ? AND thread_id IS NULL AND deleted_at IS NULL AND seq < ? ORDER BY seq DESC LIMIT ?')
    .all(id, before, limit) as MsgRow[];
  return rows.reverse().map(toHistory);
}

function toHistory(m: MsgRow): HistoryRec {
  return { seq: m.seq, id: m.id, user: m.user, at: m.created_at, replyTo: m.reply_to ?? '', threadId: m.thread_id ?? '', text: m.content };
}

export function threadHistory(db: Database.Database, ctx: ChatCtx, id: string): HistoryRec[] {
  const parent = getMessage(db, id);
  const room = getRoom(db, parent.room_id);
  if (room.visibility === 'private' && !ctx.admin) requireMemberOf(db, room.id, ctx);
  const rows = db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? AND deleted_at IS NULL ORDER BY seq').all(id) as MsgRow[];
  return [parent, ...rows].map(toHistory);
}

// ---- reactions ----

function checkEmoji(e: unknown): string {
  if (typeof e !== 'string' || e.length === 0 || Buffer.byteLength(e, 'utf8') > CHAT_LIMITS.emojiMaxBytes || /[|\r\n]/.test(e)) {
    throw new SurfaceError('bad_request', 400, 'emoji must be 1 to 32 bytes');
  }
  return e;
}

export function react(db: Database.Database, ctx: ChatCtx, id: string, b: Body): ReactReply {
  requireSession(ctx);
  const m = getMessage(db, id);
  requireMemberOf(db, m.room_id, ctx);
  requireNotMuted(db, m.room_id, ctx.user);
  const emoji = checkEmoji(b.emoji);
  const res = db.prepare('INSERT OR IGNORE INTO chat_reactions (message_id, user, emoji, at) VALUES (?, ?, ?, ?)').run(id, ctx.user, emoji, nowSec());
  if (res.changes > 0) emitEvent(db, { type: 'react', roomId: m.room_id, user: ctx.user, ref: id, text: emoji });
  return { count: reactionCount(db, id, emoji) };
}

export function unreact(db: Database.Database, ctx: ChatCtx, id: string, emojiParam: string): ReactReply {
  requireSession(ctx);
  const m = getMessage(db, id);
  const emoji = checkEmoji(emojiParam);
  const res = db.prepare('DELETE FROM chat_reactions WHERE message_id = ? AND user = ? AND emoji = ?').run(id, ctx.user, emoji);
  if (res.changes > 0) emitEvent(db, { type: 'unreact', roomId: m.room_id, user: ctx.user, ref: id, text: emoji });
  return { count: reactionCount(db, id, emoji) };
}

function reactionCount(db: Database.Database, id: string, emoji: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM chat_reactions WHERE message_id = ? AND emoji = ?').get(id, emoji) as { n: number }).n;
}

export function reactionRows(db: Database.Database, ctx: ChatCtx, id: string): { emoji: string; count: number; mine: boolean }[] {
  const m = getMessage(db, id);
  const room = getRoom(db, m.room_id);
  if (room.visibility === 'private' && !ctx.admin) requireMemberOf(db, room.id, ctx);
  const rows = db
    .prepare('SELECT emoji, COUNT(*) AS n, MAX(CASE WHEN user = ? THEN 1 ELSE 0 END) AS mine FROM chat_reactions WHERE message_id = ? GROUP BY emoji ORDER BY MIN(at), emoji')
    .all(ctx.user, id) as { emoji: string; n: number; mine: number }[];
  return rows.map((r) => ({ emoji: r.emoji, count: r.n, mine: r.mine === 1 }));
}

// ---- direct messages ----

export function dmThreadId(a: string, b: string): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return 'dm' + crypto.createHash('sha1').update(`${x}|${y}`).digest('hex').slice(0, 12);
}

/**
 * A DM target must be a real person: the board is registered and the user has
 * been seen in chat (a session, a room message or an earlier DM). Returns the
 * targets that fail, so the caller can name them. Board ids are stored
 * lower-case (splitUser lower-cases them); user columns are COLLATE NOCASE.
 */
function unknownDmTargets(db: Database.Database, ctx: ChatCtx, targets: string[]): string[] {
  const boardOk = db.prepare('SELECT 1 FROM boards WHERE id = ?');
  const userSeen = db.prepare(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM chat_sessions WHERE user = @u)
              OR EXISTS (SELECT 1 FROM chat_messages WHERE user = @u)
              OR EXISTS (SELECT 1 FROM chat_dm_messages WHERE sender = @u OR dm_a = @u OR dm_b = @u)
              OR EXISTS (SELECT 1 FROM chat_dm_members WHERE user = @u)`
  );
  return targets.filter((t) => {
    if (t.toLowerCase() === ctx.user.toLowerCase()) return false;
    const parts = splitUser(t)!;
    return !boardOk.get(parts.board) || !userSeen.get({ u: t });
  });
}

function requireKnownDmTargets(db: Database.Database, ctx: ChatCtx, targets: string[]): void {
  const bad = unknownDmTargets(db, ctx, targets);
  if (bad.length === 0) return;
  throw new SurfaceError('not_found', 404, `unknown user: ${bad.join(', ')}`);
}

export function postDm(db: Database.Database, ctx: ChatCtx, peer: string, b: Body): DmPostReply {
  requireSession(ctx);
  if (!splitUser(peer)) throw new SurfaceError('bad_request', 400, 'peer must be handle@BOARD');
  requireKnownDmTargets(db, ctx, [peer]);
  const content = str(b, 'content', CHAT_LIMITS.contentMax);
  const cid = clientId(b);
  const threadId = dmThreadId(ctx.user, peer);
  const dup = db.prepare('SELECT id, seq, thread_id FROM chat_dm_messages WHERE sender = ? AND client_id = ?').get(ctx.user, cid) as
    | { id: string; seq: number; thread_id: string } | undefined;
  if (dup) return { id: dup.id, seq: dup.seq, threadId: dup.thread_id };
  chargeMessage(ctx);
  const [a, c] = [ctx.user, peer].sort((p, q) => p.toLowerCase().localeCompare(q.toLowerCase()));
  const id = newId('d');
  db.prepare('INSERT INTO chat_dm_messages (id, seq, thread_id, dm_a, dm_b, sender, content, client_id, created_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)').run(
    id, threadId, a, c, ctx.user, content, cid, nowSec()
  );
  const seq = emitEvent(db, { type: 'dm', label: threadId, user: ctx.user, ref: id, text: content, dmA: a, dmB: c });
  db.prepare('UPDATE chat_dm_messages SET seq = ? WHERE id = ?').run(seq, id);
  return { id, seq, threadId };
}

const GROUP_DM_MAX_MEMBERS = 10;

export function dmGroupThreadId(members: string[]): string {
  const key = members.map((m) => m.toLowerCase()).sort().join('|');
  return 'dg' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

export function postDmGroup(db: Database.Database, ctx: ChatCtx, b: Body): DmPostReply {
  requireSession(ctx);
  const raw = (b as { participants?: unknown }).participants;
  if (!Array.isArray(raw) || raw.length < 2) throw new SurfaceError('bad_request', 400, 'participants must be an array of 2 or more');
  for (const x of raw) if (typeof x !== 'string' || !splitUser(x)) throw new SurfaceError('bad_request', 400, 'peer must be handle@BOARD');
  const seen = new Map<string, string>();
  for (const m of [ctx.user, ...(raw as string[])]) if (!seen.has(m.toLowerCase())) seen.set(m.toLowerCase(), m);
  const members = [...seen.values()];
  if (members.length < 3) throw new SurfaceError('bad_request', 400, 'Group DM needs 3+ unique participants (use /msg for 1:1)');
  if (members.length > GROUP_DM_MAX_MEMBERS) throw new SurfaceError('bad_request', 400, `Group DM allows at most ${GROUP_DM_MAX_MEMBERS} members`);
  requireKnownDmTargets(db, ctx, members);
  const content = str(b, 'content', CHAT_LIMITS.contentMax);
  const cid = clientId(b);
  const dup = db.prepare('SELECT id, seq, thread_id FROM chat_dm_messages WHERE sender = ? AND client_id = ?').get(ctx.user, cid) as
    | { id: string; seq: number; thread_id: string } | undefined;
  if (dup) return { id: dup.id, seq: dup.seq, threadId: dup.thread_id };
  chargeMessage(ctx);
  const threadId = dmGroupThreadId(members);
  const addMember = db.prepare('INSERT OR IGNORE INTO chat_dm_members (thread_id, user) VALUES (?, ?)');
  for (const m of members) addMember.run(threadId, m);
  const id = newId('d');
  db.prepare("INSERT INTO chat_dm_messages (id, seq, thread_id, dm_a, dm_b, sender, content, client_id, created_at) VALUES (?, 0, ?, '', '', ?, ?, ?, ?)").run(
    id, threadId, ctx.user, content, cid, nowSec()
  );
  const seq = emitEvent(db, { type: 'dm', label: threadId, user: ctx.user, ref: id, text: content });
  db.prepare('UPDATE chat_dm_messages SET seq = ? WHERE id = ?').run(seq, id);
  db.prepare('UPDATE chat_dm_members SET last_read_seq = ? WHERE thread_id = ? AND user = ?').run(seq, threadId, ctx.user);
  return { id, seq, threadId };
}

export function dmThreads(db: Database.Database, ctx: ChatCtx): { threadId: string; peer: string; lastAt: number; unread: number }[] {
  const rows = db
    .prepare(
      `SELECT thread_id, CASE WHEN dm_a = ? THEN dm_b ELSE dm_a END AS peer, MAX(created_at) AS last_at,
              SUM(CASE WHEN sender <> ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
         FROM chat_dm_messages WHERE dm_a = ? OR dm_b = ? GROUP BY thread_id ORDER BY last_at DESC`
    )
    .all(ctx.user, ctx.user, ctx.user, ctx.user) as { thread_id: string; peer: string; last_at: number; unread: number }[];
  const out = rows.map((r) => ({ threadId: r.thread_id, peer: r.peer, lastAt: r.last_at, unread: r.unread }));
  const groups = db
    .prepare(
      `SELECT mm.thread_id, mm.last_read_seq,
              (SELECT MAX(created_at) FROM chat_dm_messages WHERE thread_id = mm.thread_id) AS last_at,
              (SELECT COUNT(*) FROM chat_dm_messages WHERE thread_id = mm.thread_id AND sender <> ? AND seq > mm.last_read_seq) AS unread
         FROM chat_dm_members mm WHERE mm.user = ?`
    )
    .all(ctx.user, ctx.user) as { thread_id: string; last_at: number | null; unread: number }[];
  for (const g of groups) {
    const peers = (db.prepare('SELECT user FROM chat_dm_members WHERE thread_id = ? AND user <> ?').all(g.thread_id, ctx.user) as { user: string }[])
      .map((r) => r.user)
      .sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
    out.push({ threadId: g.thread_id, peer: peers.join(','), lastAt: g.last_at ?? 0, unread: g.unread });
  }
  return out.sort((x, y) => y.lastAt - x.lastAt);
}

export function dmHistory(db: Database.Database, ctx: ChatCtx, threadId: string, q: { before?: unknown; limit?: unknown }): HistoryRec[] {
  const { before, limit } = pageArgs(q);
  if (threadId.startsWith('dg')) return dmGroupHistory(db, ctx, threadId, before, limit);
  const rows = db
    .prepare('SELECT * FROM chat_dm_messages WHERE thread_id = ? AND (dm_a = ? OR dm_b = ?) AND seq < ? ORDER BY seq DESC LIMIT ?')
    .all(threadId, ctx.user, ctx.user, before, limit) as { id: string; seq: number; sender: string; content: string; created_at: number }[];
  db.prepare('UPDATE chat_dm_messages SET read_at = ? WHERE thread_id = ? AND sender <> ? AND read_at IS NULL AND (dm_a = ? OR dm_b = ?)').run(
    nowSec(), threadId, ctx.user, ctx.user, ctx.user
  );
  return rows.reverse().map((m) => ({ seq: m.seq, id: m.id, user: m.sender, at: m.created_at, replyTo: '', threadId, text: m.content }));
}

function dmGroupHistory(db: Database.Database, ctx: ChatCtx, threadId: string, before: number, limit: number): HistoryRec[] {
  const member = db.prepare('SELECT 1 FROM chat_dm_members WHERE thread_id = ? AND user = ?').get(threadId, ctx.user);
  if (!member) throw new SurfaceError('forbidden', 403, 'not a member of this group');
  const rows = db
    .prepare('SELECT * FROM chat_dm_messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
    .all(threadId, before, limit) as { id: string; seq: number; sender: string; content: string; created_at: number }[];
  db.prepare('UPDATE chat_dm_members SET last_read_seq = (SELECT COALESCE(MAX(seq), 0) FROM chat_dm_messages WHERE thread_id = ?) WHERE thread_id = ? AND user = ?').run(threadId, threadId, ctx.user);
  return rows.reverse().map((m) => ({ seq: m.seq, id: m.id, user: m.sender, at: m.created_at, replyTo: '', threadId, text: m.content }));
}

// ---- invites and moderation ----

export function invite(db: Database.Database, ctx: ChatCtx, id: string, b: Body, add: boolean, userParam?: string): void {
  const room = getRoom(db, id);
  const user = add ? targetUser(b) : userParam ?? '';
  requireMod(db, room, ctx, 'topic');
  if (add) db.prepare('INSERT OR IGNORE INTO chat_invites (room_id, user) VALUES (?, ?)').run(id, user);
  else db.prepare('DELETE FROM chat_invites WHERE room_id = ? AND user = ?').run(id, user);
}

function evict(db: Database.Database, roomId: string, user: string): void {
  if (db.prepare('DELETE FROM chat_members WHERE room_id = ? AND user = ?').run(roomId, user).changes > 0) {
    emitEvent(db, { type: 'left', roomId, user });
  }
}

function modReason(b: Body): string {
  return typeof b.reason === 'string' ? b.reason.slice(0, 120) : '';
}

export function moderate(db: Database.Database, ctx: ChatCtx, id: string, action: 'kick' | 'ban' | 'unban' | 'mute' | 'unmute', b: Body): void {
  const room = getRoom(db, id);
  const user = targetUser(b);
  requireMod(db, room, ctx, action === 'unban' ? 'ban' : action === 'unmute' ? 'mute' : action, user);
  const reason = modReason(b);
  const actor = ctx.user || 'admin';
  switch (action) {
    case 'kick':
      evict(db, id, user);
      emitEvent(db, { type: 'kicked', roomId: id, user, ref: actor, text: reason });
      break;
    case 'ban':
      db.prepare('INSERT OR REPLACE INTO chat_bans (room_id, user, reason, by_user, at) VALUES (?, ?, ?, ?, ?)').run(id, user, reason, actor, nowSec());
      db.prepare('DELETE FROM chat_invites WHERE room_id = ? AND user = ?').run(id, user);
      evict(db, id, user);
      emitEvent(db, { type: 'banned', roomId: id, user, ref: actor, text: reason });
      break;
    case 'unban':
      db.prepare('DELETE FROM chat_bans WHERE room_id = ? AND user = ?').run(id, user);
      break;
    case 'mute': {
      const minutes = b.minutes === undefined ? null : Number(b.minutes);
      if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600)) throw new SurfaceError('bad_request', 400, 'minutes must be 1 to 525600');
      const until = minutes === null ? null : nowSec() + minutes * 60;
      db.prepare('INSERT OR REPLACE INTO chat_mutes (room_id, user, until, by_user, at) VALUES (?, ?, ?, ?, ?)').run(id, user, until, actor, nowSec());
      emitEvent(db, { type: 'muted', roomId: id, user, ref: actor, text: reason });
      break;
    }
    case 'unmute':
      db.prepare('DELETE FROM chat_mutes WHERE room_id = ? AND user = ?').run(id, user);
      emitEvent(db, { type: 'unmuted', roomId: id, user, ref: actor });
      break;
  }
}

export function setOp(db: Database.Database, ctx: ChatCtx, id: string, b: Body, on: boolean): void {
  const room = getRoom(db, id);
  requireOwner(room, ctx);
  const user = targetUser(b);
  if (on) db.prepare('INSERT OR IGNORE INTO chat_room_ops (room_id, user) VALUES (?, ?)').run(id, user);
  else db.prepare('DELETE FROM chat_room_ops WHERE room_id = ? AND user = ?').run(id, user);
  emitEvent(db, { type: on ? 'op' : 'deop', roomId: id, user, ref: ctx.user || 'admin' });
}

/** Mode flags that take a user parameter, as the TS door's parseModeString. */
const MODE_TAKES_USER: Record<string, boolean> = { o: true, v: true, b: true };

/**
 * POST /rooms/:id/mode {modes, params}: the TS door's /mode. Flags apply in
 * order; a bad flag is reported and skipped, the rest still apply.
 *   i  invite-only = private visibility     m  moderated
 *   o  op   v  voice   b  mute (until unmuted), each with a handle@BOARD param
 * Room staff only. One `mode` event carries what was applied.
 */
export function setMode(db: Database.Database, ctx: ChatCtx, id: string, b: Body): { applied: string; errors: string } {
  const room = getRoom(db, id);
  if (!isRoomStaff(db, room, ctx)) throw new SurfaceError('forbidden', 403, 'Only moderators can change modes');
  const modes = str(b, 'modes', 64);
  if (!/^[+\-][a-zA-Z]/.test(modes)) throw new SurfaceError('bad_request', 400, 'Mode string must start with + or -');
  const params = typeof b.params === 'string' ? b.params.split(' ').filter((s) => s !== '') : [];
  const actor = ctx.user || 'admin';
  const applied: string[] = [];
  const errors: string[] = [];
  let sign = '+';
  let p = 0;
  for (const flag of modes) {
    if (flag === '+' || flag === '-') { sign = flag; continue; }
    if (!/[a-zA-Z]/.test(flag)) continue;
    const on = sign === '+';
    const param = MODE_TAKES_USER[flag] && p < params.length ? params[p++] : undefined;
    if (flag === 'i') {
      db.prepare('UPDATE chat_rooms SET visibility = ? WHERE id = ?').run(on ? 'private' : 'public', id);
      applied.push(`${sign}i`);
    } else if (flag === 'm') {
      db.prepare('UPDATE chat_rooms SET moderated = ? WHERE id = ?').run(on ? 1 : 0, id);
      applied.push(`${sign}m`);
    } else if (MODE_TAKES_USER[flag]) {
      if (!param) { errors.push(`Mode ${sign}${flag} requires a username`); continue; }
      if (!splitUser(param)) { errors.push(`User ${param} not found`); continue; }
      if (flag !== 'v' && room.owner_user.toLowerCase() === param.toLowerCase() && !ctx.admin) {
        errors.push(`Mode ${sign}${flag} ${param}: the room owner cannot be moderated`);
        continue;
      }
      const table = flag === 'o' ? 'chat_room_ops' : 'chat_room_voices';
      if (flag === 'b') {
        if (on) db.prepare('INSERT OR REPLACE INTO chat_mutes (room_id, user, until, by_user, at) VALUES (?, ?, NULL, ?, ?)').run(id, param, actor, nowSec());
        else db.prepare('DELETE FROM chat_mutes WHERE room_id = ? AND user = ?').run(id, param);
      } else if (on) db.prepare(`INSERT OR IGNORE INTO ${table} (room_id, user) VALUES (?, ?)`).run(id, param);
      else db.prepare(`DELETE FROM ${table} WHERE room_id = ? AND user = ?`).run(id, param);
      applied.push(`${sign}${flag} ${param}`);
    } else errors.push(`Unknown mode flag: ${flag}`);
  }
  if (applied.length > 0) emitEvent(db, { type: 'mode', roomId: id, user: actor, text: applied.join(' ') });
  return { applied: applied.join(' '), errors: errors.join('|') };
}

export function setTopic(db: Database.Database, ctx: ChatCtx, id: string, b: Body): void {
  const room = getRoom(db, id);
  requireMod(db, room, ctx, 'topic');
  const topic = str(b, 'topic', CHAT_LIMITS.topicMax, { empty: true });
  db.prepare('UPDATE chat_rooms SET topic = ? WHERE id = ?').run(topic, id);
  emitEvent(db, { type: 'topic', roomId: id, user: ctx.user || 'admin', text: topic });
}

/** POST /rooms/:id/typing {text}: the caller's whole input buffer ('' = stopped). Members only; text is trimmed to 200 characters. */
export const TYPING_TEXT_MAX = 200;
export function setTyping(db: Database.Database, ctx: ChatCtx, id: string, b: Body): void {
  const room = getRoom(db, id);
  requireMemberOf(db, room.id, ctx);
  const text = str(b, 'text', Number.MAX_SAFE_INTEGER, { empty: true }).slice(0, TYPING_TEXT_MAX);
  emitEvent(db, { type: 'typing', roomId: id, user: ctx.user, text });
}

/** The room's message of the day (the TS door's /motd): moderators and the owner only, empty clears it. */
export function setRoomMotd(db: Database.Database, ctx: ChatCtx, id: string, b: Body): void {
  const room = getRoom(db, id);
  requireMod(db, room, ctx, 'topic');
  const motd = str(b, 'motd', CHAT_LIMITS.contentMax, { empty: true });
  db.prepare('UPDATE chat_rooms SET motd = ? WHERE id = ?').run(motd, id);
  emitEvent(db, { type: 'room_motd', roomId: id, user: ctx.user || 'admin', text: motd });
}

export function setVisibility(db: Database.Database, ctx: ChatCtx, id: string, b: Body): void {
  const room = getRoom(db, id);
  requireOwner(room, ctx);
  if (b.visibility !== 'public' && b.visibility !== 'private') throw new SurfaceError('bad_request', 400, 'visibility must be public or private');
  db.prepare('UPDATE chat_rooms SET visibility = ? WHERE id = ?').run(b.visibility, id);
}

export function deleteRoom(db: Database.Database, ctx: ChatCtx, id: string): void {
  const room = getRoom(db, id);
  requireOwner(room, ctx);
  emitEvent(db, { type: 'room_deleted', roomId: id, user: ctx.user || 'admin', text: room.name });
  db.prepare('UPDATE chat_rooms SET deleted_at = ?, name_key = ? WHERE id = ?').run(nowSec(), `${room.name.toLowerCase()}~deleted~${id}`, id);
  db.prepare('DELETE FROM chat_members WHERE room_id = ?').run(id);
}

export function clearRoom(db: Database.Database, ctx: ChatCtx, id: string): void {
  const room = getRoom(db, id);
  requireOwner(room, ctx);
  const ids = db.prepare('SELECT id FROM chat_messages WHERE room_id = ? AND deleted_at IS NULL').all(id) as { id: string }[];
  for (const m of ids) unindexFts(db, m.id);
  db.prepare('UPDATE chat_messages SET deleted_at = ? WHERE room_id = ? AND deleted_at IS NULL').run(nowSec(), id);
  db.prepare('DELETE FROM chat_pins WHERE room_id = ?').run(id);
  emitEvent(db, { type: 'delete', roomId: id, user: ctx.user || 'admin', ref: '*' });
}

// ---- motd, pins, search, emoji ----

export function getMotd(db: Database.Database): string {
  const r = db.prepare('SELECT text FROM chat_motd WHERE id = 1').get() as { text: string } | undefined;
  return r?.text ?? '';
}

export function setMotd(db: Database.Database, ctx: ChatCtx, b: Body): void {
  requireSysop(ctx);
  const text = str(b, 'text', CHAT_LIMITS.contentMax, { empty: true });
  db.prepare('INSERT INTO chat_motd (id, text) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text').run(text);
  emitEvent(db, { type: 'motd', user: ctx.user || 'admin', text });
}

export function listPins(db: Database.Database, ctx: ChatCtx, id: string): PinRow[] {
  const room = getRoom(db, id);
  if (room.visibility === 'private' && !ctx.admin) requireMemberOf(db, id, ctx);
  const rows = db
    .prepare('SELECT p.message_id, m.user, m.content, m.created_at, p.pinned_by, p.at FROM chat_pins p JOIN chat_messages m ON m.id = p.message_id WHERE p.room_id = ? AND m.deleted_at IS NULL ORDER BY p.at')
    .all(id) as { message_id: string; user: string; content: string; created_at: number; pinned_by: string; at: number }[];
  return rows.map((r) => ({ messageId: r.message_id, user: r.user, content: r.content, pinnedBy: r.pinned_by, at: r.at, messageAt: r.created_at }));
}

export function pin(db: Database.Database, ctx: ChatCtx, id: string, b: Body, on: boolean, messageId?: string): void {
  const room = getRoom(db, id);
  requireMod(db, room, ctx, 'topic');
  const mid = on ? (typeof b.messageId === 'string' ? b.messageId : '') : messageId ?? '';
  if (on) {
    const m = getMessage(db, mid);
    if (m.room_id !== id) throw new SurfaceError('bad_request', 400, 'that message is in another room');
    db.prepare('INSERT OR IGNORE INTO chat_pins (room_id, message_id, pinned_by, at) VALUES (?, ?, ?, ?)').run(id, mid, ctx.user || 'admin', nowSec());
  } else {
    db.prepare('DELETE FROM chat_pins WHERE room_id = ? AND message_id = ?').run(id, mid);
  }
}

export function search(db: Database.Database, ctx: ChatCtx, q: { q?: unknown; room?: unknown; user?: unknown; limit?: unknown }): SearchHit[] {
  const words = typeof q.q === 'string' ? q.q.match(/[\p{L}\p{N}_]+/gu) ?? [] : [];
  if (words.length === 0) throw new SurfaceError('bad_request', 400, 'q is required');
  const match = words.slice(0, 8).map((w) => `"${w}"`).join(' ');
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), CHAT_LIMITS.historyMax);
  const room = typeof q.room === 'string' ? q.room : '';
  // A handle alone ("spot") matches that handle on every board; "spot@UPROUGH" matches one.
  const user = typeof q.user === 'string' ? q.user.trim() : '';
  const rows = db
    .prepare(
      `SELECT m.id, m.room_id, r.name, m.user, m.created_at, m.content
         FROM chat_messages_fts f JOIN chat_messages m ON m.rowid = f.rowid JOIN chat_rooms r ON r.id = m.room_id
        WHERE chat_messages_fts MATCH ? AND m.deleted_at IS NULL AND r.deleted_at IS NULL
          AND (? = '' OR m.room_id = ?)
          AND (? = '' OR lower(m.user) = lower(?) OR lower(substr(m.user, 1, instr(m.user, '@') - 1)) = lower(?))
          AND (r.visibility = 'public' OR ? = 1 OR EXISTS (SELECT 1 FROM chat_members c WHERE c.room_id = r.id AND c.user = ?))
        ORDER BY m.seq DESC LIMIT ?`
    )
    .all(match, room, room, user, user, user, ctx.admin ? 1 : 0, ctx.user, limit) as
    { id: string; room_id: string; name: string; user: string; created_at: number; content: string }[];
  return rows.map((r) => ({ id: r.id, room: r.name, user: r.user, at: r.created_at, content: r.content }));
}

export function listEmoji(db: Database.Database): EmojiRow[] {
  const rows = db.prepare('SELECT board_id, name, data_url, display, ascii FROM chat_emoji ORDER BY board_id, name').all() as
    { board_id: string; name: string; data_url: string; display: string; ascii: string }[];
  return rows.map((r) => ({ boardId: r.board_id, name: r.name, dataUrl: r.data_url, display: r.display, ascii: r.ascii }));
}

function checkEmojiText(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0 || Buffer.byteLength(v, 'utf8') > CHAT_LIMITS.emojiMaxBytes || /[|\r\n]/.test(v)) {
    throw new SurfaceError('bad_request', 400, `${what} must be 1 to 32 bytes without | or line breaks`);
  }
  return v;
}

/** Body is {display, ascii} (the LiveChat door's custom emoji) or {dataUrl} (an image). */
export function putEmoji(db: Database.Database, ctx: ChatCtx, name: string, b: Body, boardId: string): void {
  requireSysop(ctx);
  if (!/^[A-Za-z0-9_]{1,32}$/.test(name)) throw new SurfaceError('bad_request', 400, 'emoji name must be 1 to 32 letters, digits or _');
  if (b.dataUrl === undefined && (b.display !== undefined || b.ascii !== undefined)) {
    const display = checkEmojiText(b.display, 'display');
    const ascii = checkEmojiText(b.ascii, 'ascii');
    db.prepare("INSERT OR REPLACE INTO chat_emoji (board_id, name, data_url, display, ascii) VALUES (?, ?, '', ?, ?)").run(boardId, name, display, ascii);
    return;
  }
  const url = b.dataUrl;
  if (typeof url !== 'string' || url.length > 24000 || !/^data:image\/(png|gif|jpeg);base64,[A-Za-z0-9+/=]+$/.test(url)) {
    throw new SurfaceError('bad_request', 400, 'send {display, ascii} or a base64 png, gif or jpeg dataUrl under 24000 characters');
  }
  db.prepare("INSERT OR REPLACE INTO chat_emoji (board_id, name, data_url, display, ascii) VALUES (?, ?, ?, '', '')").run(boardId, name, url);
}

/**
 * A board relays one of its own BBS events (the backend's bbsEventEmitter
 * payload). Only whitelisted data keys are kept, urlencoded into the text
 * field, so the plain-text events feed stays one row per event.
 */
export function relayBbsEvent(db: Database.Database, boardId: string, b: Body): number {
  const type = str(b, 'type', 32);
  if (!(BBS_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new SurfaceError('bad_request', 400, `type must be one of ${BBS_EVENT_TYPES.join(', ')}`);
  }
  const username = str(b, 'username', 64);
  const node = b.nodeId;
  if (typeof node !== 'number' || !Number.isInteger(node) || node < 0 || node > 999) {
    throw new SurfaceError('bad_request', 400, 'nodeId must be an integer from 0 to 999');
  }
  const data = (b.data !== null && typeof b.data === 'object' ? b.data : {}) as Body;
  const params = new URLSearchParams();
  for (const k of BBS_EVENT_DATA_KEYS) {
    const v = data[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') params.set(k, String(v).slice(0, 200));
  }
  return emitEvent(db, { type: 'bbs', boardId, label: String(node), user: username, ref: type, text: params.toString() });
}

export function deleteEmoji(db: Database.Database, ctx: ChatCtx, name: string, boardId: string): void {
  requireSysop(ctx);
  db.prepare('DELETE FROM chat_emoji WHERE board_id = ? AND name = ?').run(boardId, name);
}

export { validHandle };

// ---- Discord mirror (per-board opt-in, D2/D5/D6) ----

export function getDiscordMirror(db: Database.Database, ctx: ChatCtx): boolean {
  const r = db.prepare('SELECT discord_mirror FROM boards WHERE id = ?').get(ctx.boardId) as { discord_mirror: number } | undefined;
  return r?.discord_mirror === 1;
}

/** `/discord on|off`: the board's sysop decides whether its callers are copied to Discord. */
export function setDiscordMirror(db: Database.Database, ctx: ChatCtx, b: Body): boolean {
  requireSession(ctx);
  if (!ctx.sysop) throw new SurfaceError('forbidden', 403, 'sysop only');
  if (typeof b.on !== 'boolean') throw new SurfaceError('bad_request', 400, 'on must be true or false');
  const res = db.prepare('UPDATE boards SET discord_mirror = ? WHERE id = ? AND discord_mirror <> ?').run(b.on ? 1 : 0, ctx.boardId, b.on ? 1 : 0);
  if (res.changes > 0) emitEvent(db, { type: 'discord_mirror', user: ctx.user, ref: ctx.boardId.toUpperCase(), text: b.on ? '1' : '0' });
  return b.on;
}

/**
 * Everyone joined to any of `roomIds`, for the D7 label clash set only. No
 * permission check: the caller already holds rows from these rooms, and the
 * names are used to decide a label, never returned as rows.
 */
/** The room a message lives in; 404 when the message is gone. */
export function roomOfMessage(db: Database.Database, id: string): string {
  return getMessage(db, id).room_id;
}

export function memberUsers(db: Database.Database, roomIds: Iterable<string>): string[] {
  const ids = [...new Set(roomIds)].filter((x) => x);
  if (ids.length === 0) return [];
  const q = db.prepare('SELECT DISTINCT user FROM chat_members WHERE room_id = ?');
  const out = new Set<string>();
  for (const id of ids) for (const r of q.all(id) as { user: string }[]) out.add(r.user);
  return [...out];
}

/** The boards whose callers the bridge may copy to Discord, upper-cased as in user ids. */
export function discordMirrorBoards(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM boards WHERE discord_mirror = 1 ORDER BY id').all() as { id: string }[]).map((r) => r.id.toUpperCase());
}
