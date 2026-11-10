/**
 * Files shared in a chat room. Callers upload in chunks (begin, chunk, finish)
 * and members download. The hub has no virus scanner, so blobs are never
 * placed in a served directory: they live in CHAT_FILES_DIR as <blob_id>.bin
 * (ready) or <id>.part (uploading) and are only ever streamed by the router
 * as application/octet-stream attachments.
 *
 * Every function takes the open database handle and `dir` (null when
 * CHAT_FILES_DIR is not configured: every call then answers files_disabled).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { CHAT_LIMITS } from '../../contract/chat-types';
import { SurfaceError } from '../achievements/errors';
import { charge, refund } from '../achievements/ratelimit';
import type { Charge } from '../achievements/ratelimit';
import { rebuildBasename, sniffFileKind } from '../submissions';
import { nowSec } from './config';
import { emitEvent } from './events';
import { getRoom, isMember, requireMod } from './permissions';
import { displayLabels } from './render';
import type { ChatCtx } from './sessions';
import { newId } from './sessions';
import { clientId, requireMemberOf, requireNotMuted, requireSession, requireVoice, str } from './store';
import type { Body } from './store';

const DAY = 86400;
const PURGE_DELETED_AFTER = 30 * DAY;
const MAX_NAME = 30;

/** Test sentinel: how many times `chunk` ran. */
export const fileStats = { chunkCalls: 0 };

export interface FileRow {
  id: string;
  room_id: string;
  board_id: string;
  uploader: string;
  name: string;
  orig_name: string;
  size: number;
  received: number;
  sha256: string | null;
  kind: string | null;
  status: 'uploading' | 'ready' | 'deleted';
  client_id: string;
  blob_id: string | null;
  relay: number;
  img_w: number | null;
  img_h: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  deleted_at: number | null;
  deleted_by: string | null;
  deleted_why: string | null;
}

function needDir(dir: string | null): string {
  if (!dir) throw new SurfaceError('files_disabled', 503, 'file sharing is not enabled on this hub');
  return dir;
}

const partPath = (dir: string, id: string): string => path.join(dir, `${id}.part`);
const binPath = (dir: string, blobId: string): string => path.join(dir, `${blobId}.bin`);

function unlinkQuiet(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O', å: 'a', Å: 'A' };

/**
 * The name a file is stored and listed under. Rebuilt from the submitted one,
 * never sanitised: last path component, accents folded, spaces to `_`, only
 * [A-Za-z0-9._-] kept, no leading dot, at most 30 characters keeping the
 * extension, `file.bin` when nothing is left.
 */
export function rebuildFileName(submitted: string): string {
  const folded = submitted
    .replace(/[ßæÆøØåÅ]/g, (c) => FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_');
  let base = rebuildBasename(folded, /[^A-Za-z0-9._-]/g, /[\\/:]/).replace(/^\.+/, '');
  if (!base) return 'file.bin';
  if (base.length > MAX_NAME) {
    const ext = path.extname(base);
    const keepExt = ext.length > 0 && ext.length <= 10 ? ext : '';
    base = base.slice(0, MAX_NAME - keepExt.length) + keepExt;
  }
  return base;
}

function uniqueName(db: Database.Database, roomId: string, name: string): string {
  const taken = (n: string): boolean =>
    db.prepare("SELECT 1 FROM chat_files WHERE room_id = ? AND name = ? COLLATE NOCASE AND status <> 'deleted'").get(roomId, n) !== undefined;
  if (!taken(name)) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i += 1) {
    const suffix = `_${i}`;
    const cand = stem.slice(0, MAX_NAME - ext.length - suffix.length) + suffix + ext;
    if (!taken(cand)) return cand;
  }
  throw new SurfaceError('conflict', 409, 'too many files with that name');
}

function quotaCharges(ctx: ChatCtx, size: number): Charge[] {
  const board: Charge = { key: `chat-file:board:${ctx.boardId}`, limit: { max: CHAT_LIMITS.fileBytesPerBoardPerDay, windowSeconds: DAY }, cost: size };
  if (ctx.relayOf) return [board];
  return [{ key: `chat-file:user:${ctx.user.toLowerCase()}`, limit: { max: CHAT_LIMITS.fileBytesPerUserPerDay, windowSeconds: DAY }, cost: size }, board];
}

function refundRow(row: FileRow, remaining: number): void {
  if (remaining <= 0) return;
  const cs: Charge[] = [{ key: `chat-file:board:${row.board_id}`, limit: { max: 0, windowSeconds: DAY }, cost: remaining }];
  if (!row.relay) cs.push({ key: `chat-file:user:${row.uploader.toLowerCase()}`, limit: { max: 0, windowSeconds: DAY }, cost: remaining });
  refund(cs);
}

function getFile(db: Database.Database, id: string): FileRow {
  const row = db.prepare('SELECT * FROM chat_files WHERE id = ?').get(id) as FileRow | undefined;
  if (!row) throw new SurfaceError('not_found', 404, 'no such file');
  return row;
}

function ownUpload(db: Database.Database, ctx: ChatCtx, id: string): FileRow {
  const row = getFile(db, id);
  if (row.status === 'deleted') throw new SurfaceError('file_gone', 404, 'that file is gone');
  if (row.uploader.toLowerCase() !== ctx.user.toLowerCase()) throw new SurfaceError('forbidden', 403, 'that upload is not yours');
  return row;
}

// ---- upload ----

export interface BeginReply {
  id: string;
  chunkMax: number;
  received: number;
  name: string;
}

export function beginUpload(db: Database.Database, dir: string | null, ctx: ChatCtx, roomId: string, b: Body): BeginReply {
  const d = needDir(dir);
  requireSession(ctx);
  const room = getRoom(db, roomId);
  requireMemberOf(db, room.id, ctx);
  requireNotMuted(db, room.id, ctx.user);
  requireVoice(db, room, ctx);
  const cid = clientId(b);
  const orig = str(b, 'name', 255);
  const size = b.size;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) throw new SurfaceError('bad_request', 400, 'size must be a positive integer');
  if (size > CHAT_LIMITS.fileMaxBytes) throw new SurfaceError('too_large', 413, `files are limited to ${CHAT_LIMITS.fileMaxBytes} bytes`);

  const again = db
    .prepare("SELECT * FROM chat_files WHERE room_id = ? AND uploader = ? AND client_id = ? AND status <> 'deleted'")
    .get(room.id, ctx.user, cid) as FileRow | undefined;
  if (again) return { id: again.id, chunkMax: CHAT_LIMITS.fileChunkMax, received: again.received, name: again.name };

  if (db.prepare("SELECT 1 FROM chat_files WHERE room_id = ? AND uploader = ? AND status = 'uploading'").get(room.id, ctx.user)) {
    throw new SurfaceError('conflict', 409, 'finish or cancel your current upload in this room first');
  }
  const used = (db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM chat_files WHERE status IN ('uploading','ready')").get() as { n: number }).n;
  if (used + size > CHAT_LIMITS.hubFileBytesMax) throw new SurfaceError('quota', 507, 'the hub file store is full');

  try {
    charge(quotaCharges(ctx, size));
  } catch (err) {
    if (err instanceof SurfaceError && err.code === 'rate_limited') {
      throw new SurfaceError('quota', 429, 'daily upload quota used up', err.retryAfter);
    }
    throw err;
  }

  const id = newId('f');
  const now = nowSec();
  const name = uniqueName(db, room.id, rebuildFileName(orig));
  try {
    fs.writeFileSync(partPath(d, id), Buffer.alloc(0));
  } catch (err) {
    refund(quotaCharges(ctx, size));
    throw new SurfaceError('quota', 507, `cannot store the file: ${(err as Error).message}`);
  }
  db.prepare(
    `INSERT INTO chat_files (id, room_id, board_id, uploader, name, orig_name, size, received, status, client_id, relay, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'uploading', ?, ?, ?, ?, ?)`
  ).run(id, room.id, ctx.boardId, ctx.user, name, orig, size, cid, ctx.relayOf ? 1 : 0, now, now, now + CHAT_LIMITS.fileUploadIdleSeconds);
  return { id, chunkMax: CHAT_LIMITS.fileChunkMax, received: 0, name };
}

export type ChunkResult = { ok: true; received: number } | { ok: false; conflict: true; received: number } | { ok: false; failed: true };

export function uploadChunk(db: Database.Database, dir: string | null, ctx: ChatCtx, id: string, offset: unknown, data: Buffer): ChunkResult {
  fileStats.chunkCalls += 1;
  const d = needDir(dir);
  requireSession(ctx);
  const row = ownUpload(db, ctx, id);
  if (row.status !== 'uploading') throw new SurfaceError('conflict', 409, 'that upload is already finished');
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new SurfaceError('bad_request', 400, 'offset must be a non-negative integer');
  if (!Buffer.isBuffer(data) || data.length === 0) throw new SurfaceError('bad_request', 400, 'the chunk body is empty');
  if (data.length > CHAT_LIMITS.fileChunkMax) throw new SurfaceError('too_large', 413, 'chunk is too large');
  if (offset !== row.received) return { ok: false, conflict: true, received: row.received };
  if (row.received + data.length > row.size) throw new SurfaceError('too_large', 413, 'chunk runs past the declared size');
  try {
    const fd = fs.openSync(partPath(d, id), 'r+');
    try {
      fs.writeSync(fd, data, 0, data.length, offset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    cancelRow(db, d, row, 'uploader');
    return { ok: false, failed: true };
  }
  const received = row.received + data.length;
  const now = nowSec();
  db.prepare('UPDATE chat_files SET received = ?, updated_at = ?, expires_at = ? WHERE id = ?').run(received, now, now + CHAT_LIMITS.fileUploadIdleSeconds, id);
  return { ok: true, received };
}

/** Drop an unfinished upload: the row, its .part and the quota it charged. */
function cancelRow(db: Database.Database, dir: string, row: FileRow, _why: string): void {
  unlinkQuiet(partPath(dir, row.id));
  db.prepare('DELETE FROM chat_files WHERE id = ?').run(row.id);
  refundRow(row, row.size);
}

function hashAndHead(file: string): { sha256: string; head: Buffer } {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(65536);
  let head = Buffer.alloc(0);
  try {
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      if (pos === 0) head = Buffer.from(buf.subarray(0, Math.min(n, 512)));
      h.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: h.digest('hex'), head };
}

export interface FinishReply {
  id: string;
  sha256: string;
  kind: string;
  name: string;
  size: number;
}

export function finishUpload(db: Database.Database, dir: string | null, ctx: ChatCtx, id: string): FinishReply {
  const d = needDir(dir);
  requireSession(ctx);
  const row = ownUpload(db, ctx, id);
  if (row.status === 'ready') return { id, sha256: row.sha256 ?? '', kind: row.kind ?? 'binary', name: row.name, size: row.size };
  if (row.received !== row.size) throw new SurfaceError('conflict', 409, `only ${row.received} of ${row.size} bytes received`);
  const part = partPath(d, id);
  const { sha256, head } = hashAndHead(part);
  const kind = sniffFileKind(head);
  const same = db
    .prepare("SELECT blob_id FROM chat_files WHERE room_id = ? AND sha256 = ? AND status = 'ready' AND blob_id IS NOT NULL LIMIT 1")
    .get(row.room_id, sha256) as { blob_id: string } | undefined;
  let blobId = id;
  if (same && fs.existsSync(binPath(d, same.blob_id))) {
    blobId = same.blob_id;
    unlinkQuiet(part);
  } else {
    fs.renameSync(part, binPath(d, id));
  }
  const now = nowSec();
  db.prepare("UPDATE chat_files SET status = 'ready', sha256 = ?, kind = ?, blob_id = ?, updated_at = ?, expires_at = ? WHERE id = ?").run(
    sha256, kind, blobId, now, now + CHAT_LIMITS.fileRetentionDays * DAY, id
  );
  emitEvent(db, { type: 'file_shared', roomId: row.room_id, user: row.uploader, ref: id, text: `${row.name}|${row.size}|${kind}` });
  trimRoom(db, d, row.room_id);
  return { id, sha256, kind, name: row.name, size: row.size };
}

function trimRoom(db: Database.Database, dir: string, roomId: string): void {
  const extra = db
    .prepare("SELECT * FROM chat_files WHERE room_id = ? AND status = 'ready' ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?")
    .all(roomId, CHAT_LIMITS.filesPerRoomKept) as FileRow[];
  for (const r of extra) removeReady(db, dir, r, 'system', 'expired', true);
}

// ---- delete ----

function removeReady(db: Database.Database, dir: string, row: FileRow, by: string, why: string, announce: boolean): void {
  db.prepare("UPDATE chat_files SET status = 'deleted', deleted_at = ?, deleted_by = ?, deleted_why = ? WHERE id = ?").run(nowSec(), by, why, row.id);
  const blob = row.blob_id ?? row.id;
  const still = db.prepare("SELECT 1 FROM chat_files WHERE blob_id = ? AND status = 'ready' AND id <> ?").get(blob, row.id);
  if (!still) unlinkQuiet(binPath(dir, blob));
  if (announce) emitEvent(db, { type: 'file_deleted', roomId: row.room_id, user: by, ref: row.id, text: `${row.name}|${why}` });
}

export function deleteFile(db: Database.Database, dir: string | null, ctx: ChatCtx, id: string): void {
  const d = needDir(dir);
  requireSession(ctx);
  const row = getFile(db, id);
  if (row.status === 'deleted') throw new SurfaceError('file_gone', 404, 'that file is gone');
  const own = row.uploader.toLowerCase() === ctx.user.toLowerCase();
  let why = 'uploader';
  if (!own) {
    if (ctx.admin) why = 'sysop';
    else {
      requireMod(db, getRoom(db, row.room_id), ctx, 'kick', row.uploader);
      why = ctx.sysop ? 'sysop' : 'op';
    }
  }
  if (row.status === 'uploading') {
    cancelRow(db, d, row, why);
    return;
  }
  removeReady(db, d, row, ctx.user || 'admin', why, true);
}

/** Delete every file of a room (clearRoom announces, deleteRoom does not). */
export function removeRoomFiles(db: Database.Database, dir: string | null, roomId: string, by: string, announce: boolean): void {
  if (!dir) return;
  const rows = db.prepare("SELECT * FROM chat_files WHERE room_id = ? AND status <> 'deleted'").all(roomId) as FileRow[];
  for (const r of rows) {
    if (r.status === 'uploading') cancelRow(db, dir, r, 'room-cleared');
    else removeReady(db, dir, r, by, 'room-cleared', announce);
  }
}

// ---- read ----

export interface FileListRow extends FileRow {
  label: string;
}

export function listFiles(db: Database.Database, ctx: ChatCtx, roomId: string, dirConfigured: boolean): FileListRow[] {
  if (!dirConfigured) throw new SurfaceError('files_disabled', 503, 'file sharing is not enabled on this hub');
  const room = getRoom(db, roomId);
  if (!ctx.admin) requireMemberOf(db, room.id, ctx);
  const rows = db
    .prepare("SELECT * FROM chat_files WHERE room_id = ? AND status = 'ready' ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(room.id, CHAT_LIMITS.filesPerRoomKept) as FileRow[];
  const labels = displayLabels(rows.map((r) => r.uploader));
  return rows.map((r) => ({ ...r, label: labels.get(r.uploader) ?? r.uploader }));
}

export interface Download {
  path: string;
  size: number;
  name: string;
}

export function openDownload(db: Database.Database, dir: string | null, ctx: ChatCtx, id: string): Download {
  const d = needDir(dir);
  const row = getFile(db, id);
  if (!ctx.admin && !isMember(db, row.room_id, ctx.relayOf ?? ctx.user)) throw new SurfaceError('not_member', 403, 'join the room first');
  if (row.status !== 'ready') throw new SurfaceError('file_gone', 404, 'that file is gone');
  const p = binPath(d, row.blob_id ?? row.id);
  if (!fs.existsSync(p)) throw new SurfaceError('file_gone', 404, 'that file is gone');
  return { path: p, size: row.size, name: row.name };
}

// ---- sweeper ----

export function sweepFiles(db: Database.Database, dir: string | null): void {
  if (!dir) return;
  const now = nowSec();
  const stale = db.prepare("SELECT * FROM chat_files WHERE status = 'uploading' AND ? - updated_at > ?").all(now, CHAT_LIMITS.fileUploadIdleSeconds) as FileRow[];
  for (const r of stale) cancelRow(db, dir, r, 'idle');
  const old = db.prepare("SELECT * FROM chat_files WHERE status = 'ready' AND expires_at <= ?").all(now) as FileRow[];
  for (const r of old) removeReady(db, dir, r, 'system', 'expired', true);
  db.prepare("DELETE FROM chat_files WHERE status = 'deleted' AND deleted_at < ?").run(now - PURGE_DELETED_AFTER);
}
