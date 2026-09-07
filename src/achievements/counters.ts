/**
 * The event ledger and the counters folded from it.
 *
 * Every accepted event is written ONCE, into `events`, under the primary key
 * (board_id, ref) - a resent ref is a duplicate by construction, and a
 * duplicate folds nothing. What IS folded, for every newly inserted event:
 *
 * - `counters` for (type, '') and, when the event has a key, (type, key):
 *   count, sum, first and last timestamp. count / sum / first read these.
 * - `counter_dims` for dim 'key' (when the event has a key) and dim 'board',
 *   each written twice - grp '' and grp <key> - so an ungrouped and a
 *   key-grouped `distinct` rule both read a row that exists.
 * - `counter_days` for the UTC day of the (clamped) timestamp. streak reads it.
 *
 * Born in AC-8, one task earlier than the plan lists it, because the first
 * server-internal event (`meta.link`) needs the same fold `POST /events` will
 * use, and two folds would be the first thing to drift. AC-9 adds the
 * snapshot path and the clamp; nothing here knows about either.
 */
import type Database from 'better-sqlite3';

export interface StoredEvent {
  boardId: string;
  ref: string;
  playerId: number;
  type: string;
  key: string | null;
  value: number;
  /** Epoch seconds, already clamped by the caller. */
  at: number;
  receivedAt: number;
  clamped: boolean;
  door?: string | null;
  client?: string | null;
}

/** 'YYYY-MM-DD' in UTC, the calendar a streak is counted on. */
export function utcDay(atSeconds: number): string {
  return new Date(atSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Insert, or notice the duplicate. Returns true when the row is new. The
 * primary key is the whole idempotency rule; there is no lookup to forget.
 */
export function insertEvent(db: Database.Database, e: StoredEvent): boolean {
  const info = db
    .prepare(
      `INSERT INTO events (board_id, ref, player_id, type, key, value, at, received_at, clamped, door, client)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(board_id, ref) DO NOTHING`
    )
    .run(
      e.boardId,
      e.ref,
      e.playerId,
      e.type,
      e.key,
      e.value,
      e.at,
      e.receivedAt,
      e.clamped ? 1 : 0,
      e.door ?? null,
      e.client ?? null
    );
  return info.changes > 0;
}

/** Fold one NEWLY INSERTED event into the three counter tables. */
export function foldEvent(db: Database.Database, e: StoredEvent): void {
  const counter = db.prepare(
    `INSERT INTO counters (player_id, type, key, n, sum_value, first_at, last_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(player_id, type, key) DO UPDATE SET
       n = n + 1,
       sum_value = sum_value + excluded.sum_value,
       first_at = MIN(first_at, excluded.first_at),
       last_at = MAX(last_at, excluded.last_at)`
  );
  counter.run(e.playerId, e.type, '', e.value, e.at, e.at);
  if (e.key !== null && e.key !== '') {
    counter.run(e.playerId, e.type, e.key, e.value, e.at, e.at);
  }

  const dim = db.prepare(
    `INSERT INTO counter_dims (player_id, type, dim, grp, dim_value, first_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(player_id, type, dim, grp, dim_value) DO NOTHING`
  );
  const grp = e.key ?? '';
  for (const [d, value] of [
    ['key', e.key],
    ['board', e.boardId],
  ] as const) {
    if (value === null || value === '') continue;
    dim.run(e.playerId, e.type, d, '', value, e.at);
    if (grp !== '') dim.run(e.playerId, e.type, d, grp, value, e.at);
  }

  db.prepare(
    `INSERT INTO counter_days (player_id, type, day) VALUES (?, ?, ?)
     ON CONFLICT(player_id, type, day) DO NOTHING`
  ).run(e.playerId, e.type, utcDay(e.at));
}

/** Insert and fold in one call. Returns true when the event was new. */
export function recordEvent(db: Database.Database, e: StoredEvent): boolean {
  if (!insertEvent(db, e)) return false;
  foldEvent(db, e);
  return true;
}

/**
 * stat.snapshot: an absolute counter out of a board's user record, stored
 * as max(existing, value). A LOWER snapshot after a higher one changes
 * nothing at all; `count` rules read max(counters.n, snapshot) (D10).
 */
export function recordSnapshot(
  db: Database.Database,
  playerId: number,
  name: string,
  value: number,
  now: number
): void {
  db.prepare(
    `INSERT INTO snapshots (player_id, name, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(player_id, name) DO UPDATE SET
       value = MAX(value, excluded.value),
       updated_at = CASE WHEN excluded.value > value THEN excluded.updated_at ELSE updated_at END`
  ).run(playerId, name, value, now);
}
