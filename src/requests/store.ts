/**
 * The requests store: every SQL statement, one exported function per
 * operation.
 *
 * Identity is (board_id from the key, handle_key from the body), never an
 * email - a 68K door cannot learn the caller's address, so this surface never
 * identifies an author by one. handle_key is lower(trim(handle)); the raw
 * handle is kept for display.
 *
 * Every state transition runs inside a transaction, so a state check and the
 * write it guards cannot interleave with another caller's: "a second caller
 * cannot claim it in between" is a property of the transaction, not of the
 * order two requests happen to arrive.
 */
import type Database from 'better-sqlite3';
import { SurfaceError } from '../achievements/errors';
import { requestHandleKey } from '../achievements/ratelimit';
import { REQUEST_CAPS } from '../../contract/request-types';
import type {
  ActionResponse,
  ClaimResponse,
  ListResponse,
  PostResponse,
  RequestDetail,
  RequestKind,
  RequestRow,
  RequestScope,
  RequestState,
  VoteResponse,
} from '../../contract/request-types';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** The row as it sits in SQLite. */
interface DbRow {
  id: number;
  kind: RequestKind;
  title: string;
  notes: string;
  board_id: string;
  handle: string;
  handle_key: string;
  state: RequestState;
  claim_board_id: string | null;
  claim_handle: string | null;
  claim_handle_key: string | null;
  claimed_at: number | null;
  done_note: string | null;
  done_at: number | null;
  votes: number;
  created_at: number;
  updated_at: number;
}

const ROW_COLUMNS =
  'id, kind, title, notes, board_id, handle, handle_key, state, claim_board_id, claim_handle, claim_handle_key, claimed_at, done_note, done_at, votes, created_at, updated_at';

function iso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

function toRow(r: DbRow): RequestRow {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    votes: r.votes,
    board: r.board_id,
    handle: r.handle,
    title: r.title,
    claimHandle: r.claim_handle,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

function toDetail(r: DbRow): RequestDetail {
  return {
    ...toRow(r),
    notes: r.notes,
    claimBoard: r.claim_board_id,
    doneNote: r.done_note,
    claimedAt: iso(r.claimed_at),
    doneAt: iso(r.done_at),
  };
}

export interface ListQuery {
  kind: RequestKind | null;
  /** null means "any state". */
  state: RequestState | null;
  scope: RequestScope;
  /** For scope=mine: the handle whose requests to show. Ignored otherwise. */
  handleKey: string | null;
  limit: number;
  offset: number;
}

/**
 * Parse and clamp a listing query. The board is NEVER read from the query - a
 * board key cannot name another board, so scope=board and scope=mine both use
 * the key's own board id, passed separately by the router.
 */
export function parseListQuery(q: Record<string, unknown>): ListQuery {
  const kind = q.kind === 'release' || q.kind === 'art' ? q.kind : null;
  let state: RequestState | null = 'open';
  if (q.state === 'any') state = null;
  else if (q.state === 'open' || q.state === 'claimed' || q.state === 'done' || q.state === 'withdrawn') state = q.state;
  const scope: RequestScope = q.scope === 'board' || q.scope === 'mine' ? q.scope : 'global';
  const handleKey = requestHandleKey(q.handle);
  let limit = DEFAULT_LIMIT;
  if (typeof q.limit === 'string' && /^\d+$/.test(q.limit)) limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit)));
  let offset = 0;
  if (typeof q.offset === 'string' && /^\d+$/.test(q.offset)) offset = Math.max(0, Number(q.offset));
  return { kind, state, scope, handleKey, limit, offset };
}

/**
 * A listing plus its own fingerprint, r<rows>-t<newest updated_at>, computed
 * over exactly the rows returned - so the same query twice gives the same
 * revision and the plain-text variant is byte-stable.
 */
export function listRequests(db: Database.Database, q: ListQuery, keyBoard: string): ListResponse & { revision: string } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.kind !== null) {
    where.push('kind = ?');
    args.push(q.kind);
  }
  if (q.state !== null) {
    where.push('state = ?');
    args.push(q.state);
  }
  if (q.scope === 'board') {
    where.push('board_id = ?');
    args.push(keyBoard);
  }
  if (q.scope === 'mine') {
    // "Mine AND claimed": rows this caller authored on this board, OR rows
    // this caller claimed - so the mine view can offer Done on a claim and
    // Withdraw on an authored request. A handle is required; without one the
    // view is empty rather than the whole world.
    if (q.handleKey === null) {
      where.push('1 = 0');
    } else {
      where.push('((board_id = ? AND handle_key = ?) OR (claim_board_id = ? AND claim_handle_key = ?))');
      args.push(keyBoard, q.handleKey, keyBoard, q.handleKey);
    }
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM requests ${clause}
        ORDER BY votes DESC, updated_at DESC, id ASC
        LIMIT ? OFFSET ?`
    )
    .all(...args, q.limit, q.offset) as DbRow[];
  const out = rows.map(toRow);
  const newestAt = rows.reduce((m, r) => Math.max(m, r.updated_at), 0);
  return {
    contractVersion: '1',
    revision: `r${out.length}-t${newestAt}`,
    rows: out,
  };
}

export function getRequest(db: Database.Database, id: number): RequestDetail | null {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM requests WHERE id = ?`).get(id) as DbRow | undefined;
  return row ? toDetail(row) : null;
}

function loadRow(db: Database.Database, id: number): DbRow {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM requests WHERE id = ?`).get(id) as DbRow | undefined;
  if (!row) throw new SurfaceError('not_found', 404, `no request #${id}`);
  return row;
}

/** Post a new request. Caps are refusals, never truncations. */
export function postRequest(
  db: Database.Database,
  input: { kind: unknown; title: unknown; notes: unknown; boardId: string; handle: unknown },
  now: number
): PostResponse {
  if (input.kind !== 'release' && input.kind !== 'art') {
    throw new SurfaceError('bad_kind', 400, "kind is 'release' or 'art'");
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length === 0 || title.length > REQUEST_CAPS.title) {
    throw new SurfaceError('bad_title', 400, `title is 1 to ${REQUEST_CAPS.title} characters`);
  }
  const handle = typeof input.handle === 'string' ? input.handle.trim() : '';
  const handleKey = requestHandleKey(handle);
  if (handle.length === 0 || handle.length > REQUEST_CAPS.handle || handleKey === null) {
    throw new SurfaceError('bad_handle', 400, `handle is 1 to ${REQUEST_CAPS.handle} characters`);
  }
  const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
  if (notes.length > REQUEST_CAPS.notes) {
    throw new SurfaceError('bad_request', 400, `notes is at most ${REQUEST_CAPS.notes} characters`);
  }
  const res = db
    .prepare(
      `INSERT INTO requests (kind, title, notes, board_id, handle, handle_key, state, votes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`
    )
    .run(input.kind, title, notes, input.boardId, handle, handleKey, now, now);
  return { id: Number(res.lastInsertRowid), state: 'open', at: iso(now) as string };
}

/** Vote once. A repeat by the same identity does not move the count. */
export function voteRequest(db: Database.Database, id: number, boardId: string, handleKey: string, now: number): VoteResponse {
  return db.transaction(() => {
    const row = loadRow(db, id);
    if (row.state === 'done' || row.state === 'withdrawn') {
      throw new SurfaceError('wrong_state', 409, 'this request is closed and takes no more votes');
    }
    const ins = db
      .prepare('INSERT OR IGNORE INTO request_votes (request_id, board_id, handle_key, at) VALUES (?, ?, ?, ?)')
      .run(id, boardId, handleKey, now);
    const voted = ins.changes > 0;
    if (voted) {
      db.prepare('UPDATE requests SET votes = votes + 1, updated_at = ? WHERE id = ?').run(now, id);
    }
    const votes = (db.prepare('SELECT votes FROM requests WHERE id = ?').get(id) as { votes: number }).votes;
    return { id, votes, voted };
  })();
}

/** Claim an open request. Anyone on a non-suspended board may claim. */
export function claimRequest(
  db: Database.Database,
  id: number,
  boardId: string,
  handle: string,
  handleKey: string,
  now: number
): ClaimResponse {
  return db.transaction(() => {
    const row = loadRow(db, id);
    if (row.state === 'claimed') throw new SurfaceError('already_claimed', 409, 'someone already claimed it');
    if (row.state !== 'open') throw new SurfaceError('wrong_state', 409, 'this request is closed');
    db.prepare(
      `UPDATE requests SET state = 'claimed', claim_board_id = ?, claim_handle = ?, claim_handle_key = ?, claimed_at = ?, updated_at = ? WHERE id = ?`
    ).run(boardId, handle, handleKey, now, now, id);
    return { id, state: 'claimed' as const, claimHandle: handle };
  })();
}

/** The claimer hands it back to the open pool. */
export function releaseRequest(db: Database.Database, id: number, boardId: string, handleKey: string, now: number): ActionResponse {
  return db.transaction(() => {
    const row = loadRow(db, id);
    if (row.state !== 'claimed') throw new SurfaceError('wrong_state', 409, 'only a claimed request can be released');
    if (row.claim_board_id !== boardId || row.claim_handle_key !== handleKey) {
      throw new SurfaceError('not_yours', 403, 'only the claimer may release it');
    }
    db.prepare(
      `UPDATE requests SET state = 'open', claim_board_id = NULL, claim_handle = NULL, claim_handle_key = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?`
    ).run(now, id);
    return { id, state: 'open' as const };
  })();
}

/** The claimer marks it delivered. */
export function doneRequest(
  db: Database.Database,
  id: number,
  boardId: string,
  handleKey: string,
  note: unknown,
  now: number
): ActionResponse {
  const doneNote = typeof note === 'string' ? note.trim() : '';
  if (doneNote.length > REQUEST_CAPS.doneNote) {
    throw new SurfaceError('bad_request', 400, `note is at most ${REQUEST_CAPS.doneNote} characters`);
  }
  return db.transaction(() => {
    const row = loadRow(db, id);
    if (row.state !== 'claimed') throw new SurfaceError('wrong_state', 409, 'only a claimed request can be marked done');
    if (row.claim_board_id !== boardId || row.claim_handle_key !== handleKey) {
      throw new SurfaceError('not_yours', 403, 'only the claimer may mark it done');
    }
    db.prepare(`UPDATE requests SET state = 'done', done_note = ?, done_at = ?, updated_at = ? WHERE id = ?`).run(
      doneNote === '' ? null : doneNote,
      now,
      now,
      id
    );
    return { id, state: 'done' as const };
  })();
}

/** The author pulls their own request. */
export function withdrawRequest(db: Database.Database, id: number, boardId: string, handleKey: string, now: number): ActionResponse {
  return db.transaction(() => {
    const row = loadRow(db, id);
    if (row.board_id !== boardId || row.handle_key !== handleKey) {
      throw new SurfaceError('not_yours', 403, 'only the author may withdraw it');
    }
    if (row.state === 'done' || row.state === 'withdrawn') {
      throw new SurfaceError('wrong_state', 409, 'this request is already closed');
    }
    db.prepare(`UPDATE requests SET state = 'withdrawn', updated_at = ? WHERE id = ?`).run(now, id);
    return { id, state: 'withdrawn' as const };
  })();
}

/** Curation: hard delete. Returns whether a row was removed. */
export function deleteRequest(db: Database.Database, id: number): boolean {
  return db.prepare('DELETE FROM requests WHERE id = ?').run(id).changes > 0;
}

/**
 * A cheap surface-wide fingerprint for the X-Requests-Revision header:
 * r<total rows>-t<newest updated_at across all>. Two indexed aggregates, the
 * same shape a listing's own revision uses, so a client can tell "something
 * changed" without reading a listing.
 */
export function requestsRevision(db: Database.Database): string {
  const row = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS t FROM requests').get() as {
    n: number;
    t: number;
  };
  return `r${row.n}-t${row.t}`;
}

export interface RequestCounts {
  open: number;
  claimed: number;
  done: number;
  boards: number;
}

export function requestCounts(db: Database.Database): RequestCounts {
  const byState = (state: RequestState): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM requests WHERE state = ?').get(state) as { n: number }).n;
  return {
    open: byState('open'),
    claimed: byState('claimed'),
    done: byState('done'),
    boards: (db.prepare('SELECT COUNT(*) AS n FROM boards').get() as { n: number }).n,
  };
}
