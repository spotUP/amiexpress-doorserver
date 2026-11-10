/**
 * Who may do what in a room. One place, so a rule is never written twice.
 *
 * - The server admin may do anything.
 * - The room owner and a room op may moderate their room.
 * - A board sysop may moderate users of their own board in any room.
 * - A role grants kick, ban, mute or topic to users of its board.
 * - Only the owner (or admin, or the sysop of the owner's board) changes
 *   ops, visibility, deletes or clears the room.
 */
import type Database from 'better-sqlite3';
import type { ChatRolePerms } from '../../contract/chat-types';
import { SurfaceError } from '../achievements/errors';
import { permsOf } from './roles';
import { splitUser } from './sessions';
import type { ChatCtx } from './sessions';

export interface RoomRec {
  id: string;
  name: string;
  owner_board: string;
  owner_user: string;
  topic: string;
  motd: string;
  visibility: 'public' | 'private';
  moderated: number;
}

export function getRoom(db: Database.Database, id: string): RoomRec {
  const r = db
    .prepare('SELECT id, name, owner_board, owner_user, topic, motd, visibility, moderated FROM chat_rooms WHERE id = ? AND deleted_at IS NULL')
    .get(id) as RoomRec | undefined;
  if (!r) throw new SurfaceError('not_found', 404, 'no such room');
  return r;
}

export function isOp(db: Database.Database, roomId: string, user: string): boolean {
  return db.prepare('SELECT 1 FROM chat_room_ops WHERE room_id = ? AND user = ?').get(roomId, user) !== undefined;
}

export function isMember(db: Database.Database, roomId: string, user: string): boolean {
  return db.prepare('SELECT 1 FROM chat_members WHERE room_id = ? AND user = ?').get(roomId, user) !== undefined;
}

export function isOwnerLevel(room: RoomRec, ctx: ChatCtx): boolean {
  return ctx.admin || room.owner_user.toLowerCase() === ctx.user.toLowerCase() || (ctx.sysop && ctx.boardId === room.owner_board);
}

export function isRoomStaff(db: Database.Database, room: RoomRec, ctx: ChatCtx): boolean {
  return isOwnerLevel(room, ctx) || isOp(db, room.id, ctx.user);
}

export function requireOwner(room: RoomRec, ctx: ChatCtx): void {
  if (!isOwnerLevel(room, ctx)) throw new SurfaceError('forbidden', 403, 'only the room owner may do that');
}

/** May `ctx` apply `perm` to `target` in this room? */
export function requireMod(
  db: Database.Database,
  room: RoomRec,
  ctx: ChatCtx,
  perm: keyof ChatRolePerms,
  target?: string
): void {
  const t = target ? splitUser(target) : null;
  if (target && !t) throw new SurfaceError('bad_request', 400, 'user must be handle@BOARD');
  if (target && room.owner_user.toLowerCase() === target.toLowerCase() && !ctx.admin) {
    throw new SurfaceError('forbidden', 403, 'the room owner cannot be moderated');
  }
  if (isRoomStaff(db, room, ctx)) return;
  if (ctx.sysop && (!t || t.board === ctx.boardId)) return;
  // A role is worn on its own board only: it never reaches users of another board.
  if (ctx.boardId && (!t || t.board === ctx.boardId) && permsOf(db, ctx.boardId, ctx.handle)[perm]) return;
  throw new SurfaceError('forbidden', 403, 'you may not do that in this room');
}

export function requireSysop(ctx: ChatCtx): void {
  if (!ctx.admin && !ctx.sysop) throw new SurfaceError('forbidden', 403, 'sysop only');
}
