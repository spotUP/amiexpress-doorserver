/**
 * The #updates room: what each doorserver deploy changed in Partyline.
 *
 * The deploy workflow knows the commits (the image has no git), works out the
 * subjects new since the last posted sha (scripts/partyline-changelog.sh) and
 * hands them to scripts/partyline-changelog.ts, which calls this. One message
 * per subject, no truncation. The room is created here when it is missing, the
 * same row createRoom in src/chat/store.ts writes.
 */
import type Database from 'better-sqlite3';
import { nowSec } from '../chat/config';
import { emitEvent } from '../chat/events';
import { newId } from '../chat/sessions';
import { indexFts } from '../chat/store';

export const UPDATES_ROOM = '#updates';
export const UPDATES_USER = 'changelog@DOORSERVER';
const UPDATES_TOPIC = 'What each deploy changed in Partyline';

function ensureUpdatesRoom(db: Database.Database): string {
  const key = UPDATES_ROOM.toLowerCase();
  const row = db.prepare('SELECT id FROM chat_rooms WHERE name_key = ? AND deleted_at IS NULL').get(key) as { id: string } | undefined;
  if (row) return row.id;
  const id = newId('room');
  db.prepare('INSERT INTO chat_rooms (id, name, name_key, owner_board, owner_user, topic, visibility, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, UPDATES_ROOM, key, 'doorserver', UPDATES_USER, UPDATES_TOPIC, 'public', 'text', nowSec()
  );
  emitEvent(db, { type: 'room_created', roomId: id, user: UPDATES_USER, text: UPDATES_ROOM });
  return id;
}

/** Post each subject to #updates (creating it if needed); returns the count posted. `to` keys the client ids so a re-run is a no-op. */
export function postUpdates(db: Database.Database, subjects: string[], to: string): number {
  const lines = subjects.map((s) => s.trim()).filter((s) => s !== '');
  if (lines.length === 0) return 0;
  return db.transaction(() => {
    const roomId = ensureUpdatesRoom(db);
    let posted = 0;
    lines.forEach((content, i) => {
      const cid = `deploy-${to.slice(0, 12)}-${i}`;
      if (db.prepare('SELECT 1 FROM chat_messages WHERE room_id = ? AND user = ? AND client_id = ?').get(roomId, UPDATES_USER, cid)) return;
      const id = newId('m');
      db.prepare('INSERT INTO chat_messages (id, seq, room_id, user, content, client_id, reply_to, thread_id, created_at) VALUES (?, 0, ?, ?, ?, ?, NULL, NULL, ?)').run(
        id, roomId, UPDATES_USER, content, cid, nowSec()
      );
      indexFts(db, id);
      const seq = emitEvent(db, { type: 'message', roomId, label: roomId, user: UPDATES_USER, ref: id, text: content });
      db.prepare('UPDATE chat_messages SET seq = ? WHERE id = ?').run(seq, id);
      posted++;
    });
    return posted;
  })();
}
