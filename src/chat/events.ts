/**
 * The event log and the held-poll registry.
 *
 * Every state change appends one row to chat_events inside the transaction
 * that made it; `seq` is the cursor a client stores. A long poll is two short
 * database calls with a plain promise between them: nothing in this module
 * keeps a database handle across an await.
 */
import type Database from 'better-sqlite3';
import { CHAT_LIMITS } from '../../contract/chat-types';
import type { ChatEventType } from '../../contract/chat-types';
import { SurfaceError } from '../achievements/errors';
import { nowSec } from './config';

export interface EventRec {
  seq: number;
  type: ChatEventType;
  room_id: string | null;
  label: string;
  user: string;
  ref: string;
  at: number;
  text: string;
  /** The message a `message` or `edit` event answers, '' otherwise. */
  reply_to: string;
}

export interface NewEvent {
  type: ChatEventType;
  roomId?: string | null;
  /** The text of the `room` column when it is not the room id (thread, dm). */
  label?: string;
  user: string;
  ref?: string;
  text?: string;
  dmA?: string;
  dmB?: string;
  /** Set for board-local events: only sessions of this board see them. */
  boardId?: string;
}

export function emitEvent(db: Database.Database, e: NewEvent): number {
  // A typing event is a state ("this user's buffer is now X"), not history: keep only the
  // latest per user and room, so typing noise never fills the replay window (eventsPerPoll).
  if (e.type === 'typing') db.prepare("DELETE FROM chat_events WHERE type = 'typing' AND user = ? AND room_id IS ?").run(e.user, e.roomId ?? null);
  const res = db
    .prepare(
      `INSERT INTO chat_events (type, room_id, label, user, ref, at, text, dm_a, dm_b, board_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.type, e.roomId ?? null, e.label ?? e.roomId ?? '', e.user, e.ref ?? '', nowSec(), e.text ?? '', e.dmA ?? null, e.dmB ?? null, e.boardId ?? null);
  scheduleWake();
  return Number(res.lastInsertRowid);
}

export function headSeq(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM chat_events').get() as { head: number };
  return row.head;
}

/**
 * What a session may see: its joined rooms, its direct messages, events about
 * its user, the lifecycle of public rooms, the message of the day, board_joined,
 * and the `bbs` events of its own board (never another board's, even for the same user name).
 * A relay board (boards.chat_relay) also gets every `dm` that has a participant `x@<its board>`,
 * because it speaks for those users (`as`) and no session of its own is that participant.
 */
export function fetchVisibleEvents(db: Database.Database, sid: string, user: string, since: number, board: string): EventRec[] {
  return db
    .prepare(
      `SELECT e.seq, e.type, e.room_id, e.label, e.user, e.ref, e.at, e.text,
              COALESCE(m.reply_to, '') AS reply_to
         FROM chat_events e
         LEFT JOIN chat_messages m ON e.type IN ('message','edit') AND m.id = e.ref
        WHERE e.seq > @since AND (
              (e.type = 'bbs' AND e.board_id = @board)
           OR (e.type <> 'bbs' AND (
              e.type IN ('motd','board_joined','discord_mirror')
           OR e.room_id IN (SELECT room_id FROM chat_members WHERE sid = @sid)
           OR (e.dm_a IS NOT NULL AND (e.dm_a = @user OR e.dm_b = @user))
           OR (e.type = 'dm' AND e.dm_a IS NULL AND e.label IN (SELECT thread_id FROM chat_dm_members WHERE user = @user))
           OR (e.type = 'dm' AND EXISTS (SELECT 1 FROM boards WHERE id = @board AND chat_relay = 1) AND (
                 lower(substr(e.dm_a, -length(@suffix))) = @suffix OR lower(substr(e.dm_b, -length(@suffix))) = @suffix
              OR (e.dm_a IS NULL AND e.label IN (SELECT thread_id FROM chat_dm_members WHERE lower(substr(user, -length(@suffix))) = @suffix))))
           OR e.user = @user
           OR (e.type IN ('room_created','room_deleted','topic')
               AND e.room_id IN (SELECT id FROM chat_rooms WHERE visibility = 'public'))
        )))
        ORDER BY e.seq LIMIT @limit`
    )
    .all({ since, sid, user, board, suffix: `@${board.toLowerCase()}`, limit: CHAT_LIMITS.eventsPerPoll }) as EventRec[];
}

/** Keep the newest `keep` events. */
export function pruneEvents(db: Database.Database, keep: number): number {
  const res = db.prepare('DELETE FROM chat_events WHERE seq <= (SELECT COALESCE(MAX(seq), 0) FROM chat_events) - ?').run(keep);
  return res.changes;
}

// ---- held polls ----

interface Waiter {
  sid: string;
  board: string;
  /** replace is true when a newer poll for the same session displaces this one. */
  release: (replace: boolean) => void;
}

const waiters = new Map<string, Waiter>();
let wakePending = false;

export function heldPollCount(): number {
  return waiters.size;
}

export function wakeAll(): void {
  for (const w of [...waiters.values()]) w.release(false);
}

/** Wake after the current synchronous work has committed. Coalesced. */
function scheduleWake(): void {
  if (wakePending) return;
  wakePending = true;
  setImmediate(() => {
    wakePending = false;
    wakeAll();
  });
}

export interface WaitOptions {
  sid: string;
  board: string;
  waitMs: number;
  maxHeldPerBoard: number;
  signal: AbortSignal;
  /** One short database call; returns the rows visible now. */
  fetch: () => EventRec[];
}

/**
 * Fetch; if nothing is there, hold WITHOUT a database handle until an event
 * is committed, the wait runs out, the caller disconnects, or a newer poll for
 * the same session replaces this one.
 */
export async function waitForEvents(o: WaitOptions): Promise<EventRec[]> {
  let rows = o.fetch();
  if (rows.length > 0 || o.waitMs <= 0) return rows;

  const previous = waiters.get(o.sid);
  if (previous) previous.release(true);
  let held = 0;
  for (const w of waiters.values()) if (w.board === o.board) held += 1;
  if (held >= o.maxHeldPerBoard) {
    throw new SurfaceError('rate_limited', 429, 'too many held polls for this board', 5);
  }

  const deadline = Date.now() + o.waitMs;
  while (rows.length === 0) {
    const left = deadline - Date.now();
    if (left <= 0 || o.signal.aborted) break;
    let displaced = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, left);
      const waiter: Waiter = {
        sid: o.sid,
        board: o.board,
        release: (replace) => {
          displaced = replace;
          done();
        },
      };
      function done(): void {
        clearTimeout(timer);
        o.signal.removeEventListener('abort', done);
        if (waiters.get(o.sid) === waiter) waiters.delete(o.sid);
        resolve();
      }
      o.signal.addEventListener('abort', done);
      waiters.set(o.sid, waiter);
    });
    if (o.signal.aborted) break;
    rows = o.fetch();
    if (displaced) break;
  }
  return rows;
}
