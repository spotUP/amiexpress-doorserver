/**
 * POST /events - the write path.
 *
 * One request is one transaction (the router wraps it), so a batch that
 * fails halfway leaves nothing half-applied. Inside it, in this order:
 *
 * 1. Batch-level validation. A fault of the REQUEST refuses the whole
 *    batch with a 400 and stores nothing: not `{events:[...]}`, empty, over
 *    100, a missing required field, an over-long ref or type, or any
 *    `meta.*` type - that last one is an attack signal, not a typo (D3).
 * 2. Per-event resolution. Unknown address, unverified player, or no link
 *    for THIS board: the event is `rejected` with a reason and the rest of
 *    the batch goes on. Every rejection is terminal for the sender. When
 *    EVERY event is `not_linked` the answer is a whole-batch 403 instead -
 *    the single-player case the 68K door always sends.
 * 3. The type check, against achievement_types: a type no achievement
 *    names can move nothing and is rejected per event. `stat.snapshot` is
 *    known when its KEY is.
 * 4. The clamp. More than 15 minutes ahead of the server's clock or more
 *    than 30 days behind it, `at` becomes the receive time and the row says
 *    so. Nothing anywhere reads the raw value.
 * 5. Insert under (board_id, ref). A duplicate is counted and folds
 *    nothing; the primary key is the whole idempotency story.
 * 6. Fold (counters.ts), or for a snapshot, max() into `snapshots`.
 * 7. One audit row for the request.
 *
 * No rule runs here. AC-10 evaluates behind this same endpoint; this
 * module's answer always carries empty `unlocks` and `progress`.
 */
import type Database from 'better-sqlite3';
import { SurfaceError } from './errors';
import { auditBoard } from './boards';
import { insertEvent, recordEvent, recordSnapshot } from './counters';
import { isLinked } from './links';
import { findPlayerByEmail } from './players';
import type { PlayerRow } from './players';
import type { EventsResponse, RejectedEvent, RejectReason } from '../../contract/achievement-types';

export const MAX_BATCH = 100;
export const MAX_REF_LENGTH = 128;
export const MAX_TYPE_LENGTH = 64;
/** The clamp: this far ahead of the server's clock, or this far behind it. */
export const FUTURE_SLACK_SECONDS = 15 * 60;
export const PAST_SLACK_SECONDS = 30 * 24 * 3600;

export const SNAPSHOT_TYPE = 'stat.snapshot';

interface ParsedEvent {
  ref: string;
  email: string;
  type: string;
  /** Epoch seconds as the board stamped it; clamped later. */
  at: number;
  value: number;
  key: string | null;
  door: string | null;
  client: string | null;
}

const REQUIRED = ['ref', 'email', 'type', 'at'] as const;

function optionalString(raw: Record<string, unknown>, field: string, index: number): string | null {
  const v = raw[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    throw new SurfaceError('bad_request', 400, `events[${index}].${field} must be a string`);
  }
  return v;
}

/** The batch, validated as a whole. Throws the batch-level 400s. */
export function parseBatch(body: unknown): ParsedEvent[] {
  const events = (body as { events?: unknown } | null)?.events;
  if (body === null || typeof body !== 'object' || !Array.isArray(events)) {
    throw new SurfaceError('bad_request', 400, 'the body is {"events":[...]}');
  }
  if (events.length === 0) throw new SurfaceError('batch_empty', 400, 'a batch has at least one event');
  if (events.length > MAX_BATCH) {
    throw new SurfaceError('batch_too_large', 400, `a batch has at most ${MAX_BATCH} events`);
  }

  return events.map((raw, index): ParsedEvent => {
    if (raw === null || typeof raw !== 'object') {
      throw new SurfaceError('event_missing_field', 400, `events[${index}] is not an object`);
    }
    const r = raw as Record<string, unknown>;
    for (const field of REQUIRED) {
      if (typeof r[field] !== 'string' || (r[field] as string).length === 0) {
        throw new SurfaceError('event_missing_field', 400, `events[${index}].${field} is required`);
      }
    }
    const ref = r.ref as string;
    const type = r.type as string;
    if (ref.length > MAX_REF_LENGTH || type.length > MAX_TYPE_LENGTH) {
      throw new SurfaceError(
        'event_field_too_long',
        400,
        `events[${index}]: ref is at most ${MAX_REF_LENGTH} characters and type at most ${MAX_TYPE_LENGTH}`
      );
    }
    if (/^meta\./.test(type)) {
      throw new SurfaceError('meta_type_rejected', 400, `events[${index}]: ${type} is the server's own event type`);
    }
    const atMs = Date.parse(r.at as string);
    if (Number.isNaN(atMs)) {
      throw new SurfaceError('bad_request', 400, `events[${index}].at is not an ISO 8601 timestamp`);
    }
    let value = 1;
    if (r.value !== undefined && r.value !== null) {
      if (typeof r.value !== 'number' || !Number.isFinite(r.value)) {
        throw new SurfaceError('bad_request', 400, `events[${index}].value must be a finite number`);
      }
      value = r.value;
    }
    return {
      ref,
      email: r.email as string,
      type,
      at: Math.floor(atMs / 1000),
      value,
      key: optionalString(r, 'key', index),
      door: optionalString(r, 'door', index),
      client: optionalString(r, 'client', index),
    };
  });
}

/** Every type some achievement names - the only types worth storing. */
export function knownTypes(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare('SELECT DISTINCT type FROM achievement_types').all() as { type: string }[]).map((r) => r.type)
  );
}

export interface Folded {
  playerIds: number[];
  types: string[];
}

/**
 * Store a batch for the key's board. Returns the response body; throws the
 * batch-level refusals. Must run inside a transaction.
 *
 * `folded` is filled with the players and types the batch actually moved,
 * which is exactly the question the rule engine (AC-10) asks next.
 */
export function storeEvents(
  db: Database.Database,
  boardId: string,
  body: unknown,
  receivedAt: number,
  folded: Folded = { playerIds: [], types: [] }
): EventsResponse {
  const events = parseBatch(body);
  const known = knownTypes(db);

  const rejected: RejectedEvent[] = [];
  const notLinked = new Set<string>();
  const players = new Map<string, PlayerRow | null>();
  const touchedPlayers = new Set<number>();
  const touchedTypes = new Set<string>();
  let accepted = 0;
  let duplicates = 0;

  const reject = (ref: string, reason: RejectReason): void => {
    rejected.push({ ref, reason });
  };

  for (const e of events) {
    const emailKey = e.email.trim().toLowerCase();
    if (!players.has(emailKey)) players.set(emailKey, findPlayerByEmail(db, e.email));
    const player = players.get(emailKey) ?? null;

    if (!player) {
      reject(e.ref, 'unknown_player');
      continue;
    }
    if (player.verified_at === null) {
      reject(e.ref, 'unverified_player');
      continue;
    }
    if (!isLinked(db, boardId, player.id)) {
      reject(e.ref, 'not_linked');
      notLinked.add(e.email);
      continue;
    }

    const isSnapshot = e.type === SNAPSHOT_TYPE;
    const counted = isSnapshot ? e.key : e.type;
    if (counted === null || !known.has(counted)) {
      reject(e.ref, 'unknown_event_type');
      continue;
    }

    let at = e.at;
    let clamped = false;
    if (at > receivedAt + FUTURE_SLACK_SECONDS || at < receivedAt - PAST_SLACK_SECONDS) {
      at = receivedAt;
      clamped = true;
    }

    const stored = {
      boardId,
      ref: e.ref,
      playerId: player.id,
      type: e.type,
      key: e.key,
      value: e.value,
      at,
      receivedAt,
      clamped,
      door: e.door,
      client: e.client,
    };

    let inserted: boolean;
    if (isSnapshot) {
      // The row is still written, so a resent snapshot ref is a duplicate
      // like any other; what it feeds is `snapshots`, never a counter.
      inserted = insertEvent(db, stored);
      if (inserted) recordSnapshot(db, player.id, counted, e.value, receivedAt);
    } else {
      inserted = recordEvent(db, stored);
    }

    if (inserted) {
      accepted += 1;
      touchedPlayers.add(player.id);
      touchedTypes.add(counted);
    } else {
      duplicates += 1;
    }
  }

  if (rejected.length === events.length && rejected.every((r) => r.reason === 'not_linked')) {
    throw new SurfaceError('not_linked', 403, 'no event in this batch is for a player who linked this board');
  }

  auditBoard(db, boardId, 'events', accepted, receivedAt);
  folded.playerIds.push(...touchedPlayers);
  folded.types.push(...touchedTypes);

  return {
    accepted,
    duplicates,
    rejected,
    notLinked: [...notLinked],
    unlocks: [],
    progress: [],
  };
}
