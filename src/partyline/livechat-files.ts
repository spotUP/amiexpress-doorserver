/**
 * LIVECHAT door events for shared files, picture upload and the /draw canvas, answered from the hub
 * store (src/chat/files.ts, store.ts canvas). Kept apart from livechat-host.ts so the handler map there
 * only merges `handlers` and forwards store events to `onEvent`. Reply shapes follow
 * chat-session-bridge.ts on the board.
 *
 * Uploads: the hub never receives file bytes over the Partyline socket. It sends `T upload <room>
 * <maxBytes> <types> <mode>`; the relay gets the picture from the caller and stores it through the
 * chat HTTP API as the caller's session (the finished upload raises file_shared, which reaches the
 * door as file:shared), then answers `U ok <fileId>` or `U fail <reason>`.
 */
import * as fs from 'fs';
import type Database from 'better-sqlite3';
import { CHAT_LIMITS } from '../../contract/chat-types';
import { SurfaceError } from '../achievements/errors';
import type { ChatCtx } from '../chat/sessions';
import { listFiles, openPreview } from '../chat/files';
import { applyCanvasOps, getCanvas } from '../chat/store';

type Payload = Record<string, unknown>;

export interface FilesHost {
  store: <T>(write: boolean, fn: (db: Database.Database, ctx: ChatCtx) => T) => T;
  reply: (ev: string, data: Payload) => void;
  str: (d: Payload, ...keys: string[]) => string;
  short: (user: string) => string;
  room: () => { id: string; name: string } | null;
  /** chatFilesDir; null = file sharing off on this hub. */
  filesDir: string | null;
  /** The hello's `upload=` value. */
  uploadMode: 'none' | 'zmodem' | 'web' | 'aew';
  /** Send a `T` frame to the relay; absent when the session cannot. */
  ctrl?: (text: string) => void;
}

export const UPLOAD_NOT_HERE = 'Picture upload is not available from this client.';
const PICTURE_MAX_BYTES = 2 * 1024 * 1024;
/** The board's wait for the caller's file (PICTURE_REQUEST_TIMEOUT_MS). */
const UPLOAD_WAIT_MS = 5 * 60 * 1000;
const PREVIEW_REASON: Record<number, string> = { 403: 'not_member', 415: 'not_image', 503: 'files_disabled' };
const DRAW_REFUSALS = [403, 413, 422, 429];

export function filesAndDrawing(h: FilesHost): {
  handlers: Record<string, (d: Payload) => void>;
  /** A `U` frame payload: `ok <fileId>` or `fail <reason>`. */
  onUploadResult: (payload: string) => void;
  /** A visible store event for the caller's room; true when it was a file or canvas event. */
  onEvent: (e: { type: string; room_id: string | null; user: string; ref: string | null; text: string | null }) => boolean;
} {
  let waitingSince = 0;
  const refuse = (error: string): void => h.reply('room:error', { error });
  const roomOf = (d: Payload): string => h.str(d, 'roomId') || h.room()?.id || '';
  const needRoom = (d: Payload): string => { const id = roomOf(d); if (!id) throw new SurfaceError('bad_request', 400, 'not in a room'); return id; };

  const handlers: Record<string, (d: Payload) => void> = {
    // The door's file manager lists names in a directory; the hub keeps one flat list per room.
    'file:list': (d) => {
      const id = roomOf(d);
      let names: string[] = [];
      if (id) {
        try { names = h.store(false, (db, ctx) => listFiles(db, ctx, id, h.filesDir !== null)).map((f) => f.name); }
        catch (e) { if (!(e instanceof SurfaceError)) throw e; }
      }
      h.reply('file:list', { path: h.str(d, 'path') || '/uploads', files: names, directories: [] });
    },
    // A path on the board's disk means nothing to the hub; pictures go through /upload.
    'file:share': () => refuse('The hub cannot share a board file. Use /upload to share a picture.'),
    'file:preview': (d) => {
      const fileId = h.str(d, 'fileId');
      const fmt = d.fmt === 'rgb' ? 'rgb' : 'png';
      try {
        const pv = h.store(false, (db, ctx) => openPreview(db, h.filesDir, ctx, fileId, fmt, d.cols, d.rows));
        const [c, r] = pv.cells.split('x').map(Number);
        h.reply('file:preview', { fileId, fmt, cols: c, rows: r, data: fs.readFileSync(pv.path).toString('base64') });
      } catch (e) {
        const reason = e instanceof SurfaceError ? PREVIEW_REASON[e.status] : undefined;
        if (!reason) throw e;
        h.reply('file:preview', { fileId, fmt, error: reason });
      }
    },
    'file:upload': () => {
      const room = h.room();
      if (!room) return refuse('Join a chat room first.');
      if (h.uploadMode === 'none' || !h.ctrl) return refuse(UPLOAD_NOT_HERE);
      if (!h.filesDir) return refuse('File sharing is not enabled on this hub.');
      if (waitingSince && Date.now() - waitingSince < UPLOAD_WAIT_MS) return refuse('A picture upload is already waiting.');
      waitingSince = Date.now();
      h.ctrl(`upload ${room.id} ${Math.min(PICTURE_MAX_BYTES, CHAT_LIMITS.fileMaxBytes)} image ${h.uploadMode}`);
    },
    'draw:get': (d) => {
      const roomId = needRoom(d);
      const snap = h.store(false, (db, ctx) => getCanvas(db, ctx, roomId, { from: d.from, count: d.count, maxBytes: d.maxBytes }));
      h.reply('draw:snapshot', { roomId, rev: snap.rev, rows: snap.rows.map(([y, cells]) => ({ y, cells })) });
    },
    'draw:ops': (d) => {
      const roomId = needRoom(d);
      try {
        // The new revision comes back as the canvas event (own echo); nothing to reply on success.
        h.store(true, (db, ctx) => applyCanvasOps(db, ctx, roomId, { base: d.base, ops: String(d.ops ?? '') }));
      } catch (e) {
        if (e instanceof SurfaceError && DRAW_REFUSALS.includes(e.status)) h.reply('draw:error', { roomId, status: e.status, error: e.message });
        else throw e;
      }
    },
  };

  return {
    handlers,
    onUploadResult(payload) {
      const m = /^(ok|fail)\s*(.*)$/.exec(payload.trim());
      if (!m) return;
      waitingSince = 0;
      if (m[1] === 'fail') refuse(m[2] || 'Picture upload failed.');
    },
    onEvent(e) {
      if (e.type === 'canvas') h.reply('draw:ops', { roomId: e.room_id ?? '', rev: Number(e.ref) || 0, user: h.short(e.user), ops: e.text ?? '' });
      else if (e.type === 'file_shared') {
        const [filename = '', size = '0', kind = ''] = (e.text ?? '').split('|');
        h.reply('file:shared', { id: e.ref ?? '', roomId: e.room_id ?? '', username: h.short(e.user), filename, size: Number(size) || 0, kind });
      } else return false;
      return true;
    },
  };
}
