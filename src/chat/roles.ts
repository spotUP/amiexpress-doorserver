/**
 * Roles: named colours plus a few permissions, per board.
 *
 * A role belongs to the board that made it and applies to that board's users
 * only. A user's colour is that of their highest-position role; their
 * permissions are the union of all their roles.
 */
import type Database from 'better-sqlite3';
import { CHAT_LIMITS } from '../../contract/chat-types';
import type { ChatRolePerms, RoleInput, RoleRow } from '../../contract/chat-types';
import { SurfaceError } from '../achievements/errors';
import { emitEvent } from './events';
import { newId, splitUser, validHandle } from './sessions';

const NO_PERMS: ChatRolePerms = { kick: false, ban: false, mute: false, topic: false, createPrivate: false };
const PERM_KEYS = Object.keys(NO_PERMS) as (keyof ChatRolePerms)[];

interface RoleDbRow {
  id: string;
  name: string;
  color_hex: string;
  color_ansi: number;
  position: number;
  perms: string;
}

function toRow(r: RoleDbRow): RoleRow {
  let parsed: Partial<ChatRolePerms> = {};
  try {
    parsed = JSON.parse(r.perms) as Partial<ChatRolePerms>;
  } catch {
    parsed = {};
  }
  const perms = { ...NO_PERMS };
  for (const k of PERM_KEYS) perms[k] = parsed[k] === true;
  return { id: r.id, name: r.name, colorHex: r.color_hex, colorAnsi: r.color_ansi, position: r.position, perms };
}

export function parseRoleInput(body: unknown): Required<Omit<RoleInput, 'perms'>> & { perms: ChatRolePerms } {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length === 0 || name.length > CHAT_LIMITS.roleNameMax || /[|\r\n]/.test(name)) {
    throw new SurfaceError('bad_request', 400, `name must be 1 to ${CHAT_LIMITS.roleNameMax} characters`);
  }
  if (typeof b.colorHex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.colorHex)) {
    throw new SurfaceError('bad_request', 400, 'colorHex must be #RRGGBB');
  }
  if (typeof b.colorAnsi !== 'number' || !Number.isInteger(b.colorAnsi) || b.colorAnsi < 0 || b.colorAnsi > 15) {
    throw new SurfaceError('bad_request', 400, 'colorAnsi must be an integer 0 to 15');
  }
  const position = b.position === undefined ? 0 : b.position;
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position > 1000) {
    throw new SurfaceError('bad_request', 400, 'position must be an integer 0 to 1000');
  }
  const given = (b.perms ?? {}) as Record<string, unknown>;
  const perms = { ...NO_PERMS };
  for (const k of PERM_KEYS) perms[k] = given[k] === true;
  return { name, colorHex: b.colorHex.toLowerCase(), colorAnsi: b.colorAnsi, position, perms };
}

export function listRoles(db: Database.Database, boardId: string): RoleRow[] {
  const rows = db
    .prepare('SELECT id, name, color_hex, color_ansi, position, perms FROM chat_roles WHERE board_id = ? ORDER BY position DESC, name')
    .all(boardId) as RoleDbRow[];
  return rows.map(toRow);
}

export function createRole(db: Database.Database, boardId: string, body: unknown): RoleRow {
  const r = parseRoleInput(body);
  const id = newId('r');
  db.prepare('INSERT INTO chat_roles (id, board_id, name, color_hex, color_ansi, position, perms) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, boardId, r.name, r.colorHex, r.colorAnsi, r.position, JSON.stringify(r.perms)
  );
  return { id, name: r.name, colorHex: r.colorHex, colorAnsi: r.colorAnsi, position: r.position, perms: r.perms };
}

function roleExists(db: Database.Database, boardId: string, id: string): boolean {
  return db.prepare('SELECT 1 FROM chat_roles WHERE id = ? AND board_id = ?').get(id, boardId) !== undefined;
}

function assignees(db: Database.Database, roleId: string): string[] {
  return (db.prepare('SELECT handle FROM chat_role_assignments WHERE role_id = ?').all(roleId) as { handle: string }[]).map((r) => r.handle);
}

export function updateRole(db: Database.Database, boardId: string, id: string, body: unknown): RoleRow {
  if (!roleExists(db, boardId, id)) throw new SurfaceError('not_found', 404, 'no such role');
  const r = parseRoleInput(body);
  db.prepare('UPDATE chat_roles SET name = ?, color_hex = ?, color_ansi = ?, position = ?, perms = ? WHERE id = ?').run(
    r.name, r.colorHex, r.colorAnsi, r.position, JSON.stringify(r.perms), id
  );
  for (const h of assignees(db, id)) emitRoleEvents(db, boardId, h);
  return { id, name: r.name, colorHex: r.colorHex, colorAnsi: r.colorAnsi, position: r.position, perms: r.perms };
}

export function deleteRole(db: Database.Database, boardId: string, id: string): void {
  if (!roleExists(db, boardId, id)) throw new SurfaceError('not_found', 404, 'no such role');
  const who = assignees(db, id);
  db.prepare('DELETE FROM chat_role_assignments WHERE role_id = ?').run(id);
  db.prepare('DELETE FROM chat_roles WHERE id = ?').run(id);
  for (const h of who) emitRoleEvents(db, boardId, h);
}

export function listAssignments(db: Database.Database, boardId: string): { handle: string; roleId: string }[] {
  const rows = db
    .prepare('SELECT handle, role_id FROM chat_role_assignments WHERE board_id = ? ORDER BY handle, role_id')
    .all(boardId) as { handle: string; role_id: string }[];
  return rows.map((r) => ({ handle: r.handle, roleId: r.role_id }));
}

export function setAssignments(db: Database.Database, boardId: string, handle: string, roleIds: unknown): void {
  if (!validHandle(handle)) throw new SurfaceError('bad_request', 400, 'not a handle');
  if (!Array.isArray(roleIds) || roleIds.some((x) => typeof x !== 'string')) {
    throw new SurfaceError('bad_request', 400, 'roleIds must be an array of role ids');
  }
  const ids = [...new Set(roleIds as string[])];
  for (const id of ids) if (!roleExists(db, boardId, id)) throw new SurfaceError('not_found', 404, `no such role ${id}`);
  db.prepare('DELETE FROM chat_role_assignments WHERE board_id = ? AND handle = ?').run(boardId, handle);
  for (const id of ids) db.prepare('INSERT INTO chat_role_assignments (role_id, board_id, handle) VALUES (?, ?, ?)').run(id, boardId, handle);
  emitRoleEvents(db, boardId, handle);
}

export interface UserRole {
  name: string;
  colorHex: string;
  colorAnsi: number;
}

/** The highest role of a user on their own board, or null. */
export function roleOf(db: Database.Database, user: string): UserRole | null {
  const parts = splitUser(user);
  if (!parts) return null;
  const r = db
    .prepare(
      `SELECT r.name, r.color_hex, r.color_ansi FROM chat_role_assignments a
         JOIN chat_roles r ON r.id = a.role_id
        WHERE a.board_id = ? AND a.handle = ? ORDER BY r.position DESC, r.name LIMIT 1`
    )
    .get(parts.board, parts.handle) as { name: string; color_hex: string; color_ansi: number } | undefined;
  return r ? { name: r.name, colorHex: r.color_hex, colorAnsi: r.color_ansi } : null;
}

/** The union of a user's role permissions on their own board. */
export function permsOf(db: Database.Database, boardId: string, handle: string): ChatRolePerms {
  const rows = db
    .prepare(
      `SELECT r.perms FROM chat_role_assignments a JOIN chat_roles r ON r.id = a.role_id
        WHERE a.board_id = ? AND a.handle = ?`
    )
    .all(boardId, handle) as { perms: string }[];
  const out = { ...NO_PERMS };
  for (const row of rows) {
    const p = toRow({ id: '', name: '', color_hex: '', color_ansi: 0, position: 0, perms: row.perms }).perms;
    for (const k of PERM_KEYS) out[k] = out[k] || p[k];
  }
  return out;
}

/** Tell every room the user sits in (or just the user) that the role changed. */
export function emitRoleEvents(db: Database.Database, boardId: string, handle: string): void {
  const user = `${handle}@${boardId.toUpperCase()}`;
  const role = roleOf(db, user);
  const text = role ? `${role.name}|${role.colorHex}|${role.colorAnsi}` : '';
  const rooms = db.prepare('SELECT DISTINCT room_id FROM chat_members WHERE user = ?').all(user) as { room_id: string }[];
  if (rooms.length === 0) emitEvent(db, { type: 'role', user, text });
  for (const r of rooms) emitEvent(db, { type: 'role', roomId: r.room_id, user, text });
}
