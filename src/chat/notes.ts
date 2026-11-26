/**
 * Partyline user notes and per-user message history: the user menu's "Add Note"
 * and "View History". One hub store serves the telnet screen, web /chat and the
 * Amiga client, so a note written on one is read on the others.
 *
 * Who may do what copies the reference chat: any caller may add a note about any
 * user; the notes are the sysop's to read (in the reference they land in the
 * board's account editor), so a sysop or hub admin lists every note on a user and
 * anyone else lists only the notes they wrote. History is the user's own chat
 * messages (no system lines, no thread replies), newest 15 by default, in the
 * rooms the caller can see.
 */
import type Database from 'better-sqlite3';
import { CHAT_LIMITS } from '../../contract/chat-types';
import { SurfaceError } from '../achievements/errors';
import { nowSec } from './config';
import { requireSession } from './store';
import type { HistoryRec } from './store';
import type { ChatCtx } from './sessions';

export const NOTE_TEXT_MAX = 1000;
export const USER_HISTORY_DEFAULT = 15;

export interface NoteRec { id: number; target: string; author: string; at: number; text: string }

/** "bob" means bob on the caller's board; "bob@HOME" names the board. */
export function noteTarget(ctx: ChatCtx, raw: string): string {
  const t = raw.trim().replace(/^@/, '');
  // Sidebar names may hold a space ("Mr Bob"), so only the separator and control bytes are refused.
  if (!/^[^@|\x00-\x1f\x7f]{1,64}(@[A-Za-z0-9-]{1,32})?$/.test(t)) throw new SurfaceError('bad_request', 400, 'user is not a valid handle');
  return t.includes('@') || !ctx.boardId ? t : `${t}@${ctx.boardId}`;
}

export function addNote(db: Database.Database, ctx: ChatCtx, rawTarget: string, rawText: unknown): { id: number; at: number } {
  requireSession(ctx);
  const target = noteTarget(ctx, rawTarget);
  // A note is one line: control bytes and the text format's field separator do not survive the wire.
  const text = (typeof rawText === 'string' ? rawText : '').replace(/[\x00-\x1f\x7f|]+/g, ' ').trim().slice(0, NOTE_TEXT_MAX);
  if (!text) throw new SurfaceError('bad_request', 400, 'text is required');
  const at = nowSec();
  const r = db.prepare('INSERT INTO chat_user_notes (board_id, target, author, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.boardId, target, ctx.user || 'admin', text, at);
  return { id: Number(r.lastInsertRowid), at };
}

export function listNotes(db: Database.Database, ctx: ChatCtx, rawTarget: string): NoteRec[] {
  const target = noteTarget(ctx, rawTarget);
  const all = ctx.sysop || ctx.admin ? 1 : 0;
  return db.prepare(
    `SELECT id, target, author, created_at AS at, text FROM chat_user_notes
      WHERE lower(target) = lower(?) AND (? = 1 OR lower(author) = lower(?)) ORDER BY id ASC`
  ).all(target, all, ctx.user) as NoteRec[];
}

export function userHistory(db: Database.Database, ctx: ChatCtx, rawUser: string, q: { room?: unknown; limit?: unknown }): HistoryRec[] {
  // A handle alone matches that handle on every board, as search does; "bob@HOME" matches one.
  const user = rawUser.trim().replace(/^@/, '');
  if (!user) throw new SurfaceError('bad_request', 400, 'user is required');
  const n = Number(q.limit);
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, CHAT_LIMITS.historyMax) : USER_HISTORY_DEFAULT;
  const room = typeof q.room === 'string' ? q.room : '';
  const rows = db.prepare(
    `SELECT m.seq, m.id, m.user, m.created_at, m.reply_to, m.thread_id, m.content
       FROM chat_messages m JOIN chat_rooms r ON r.id = m.room_id
      WHERE m.deleted_at IS NULL AND m.thread_id IS NULL AND r.deleted_at IS NULL
        AND (? = '' OR m.room_id = ?)
        AND (lower(m.user) = lower(?) OR (instr(?, '@') = 0 AND lower(substr(m.user, 1, instr(m.user, '@') - 1)) = lower(?)))
        AND (r.visibility = 'public' OR ? = 1 OR EXISTS (SELECT 1 FROM chat_members c WHERE c.room_id = r.id AND c.user = ?))
      ORDER BY m.seq DESC LIMIT ?`
  ).all(room, room, user, user, user, ctx.admin ? 1 : 0, ctx.user, limit) as
    { seq: number; id: string; user: string; created_at: number; reply_to: string | null; thread_id: string | null; content: string }[];
  return rows.reverse().map((m) => ({ seq: m.seq, id: m.id, user: m.user, at: m.created_at, replyTo: m.reply_to ?? '', threadId: m.thread_id ?? '', text: m.content }));
}
