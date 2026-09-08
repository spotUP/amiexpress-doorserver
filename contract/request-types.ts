/**
 * The global-requests wire contract: the shapes every client compiles
 * against. Clients vendor a generated mirror (scripts/gen-request-types.ts);
 * REQUESTS_CONTRACT_VERSION tells a client whether its mirror is old enough
 * to matter. Echoed on every response as X-Requests-Contract.
 *
 * A SIBLING of contract/achievement-types.ts, not an extension of it. A
 * request is not an achievement: a caller asks the scene for a release to be
 * uploaded or a piece of ASCII art to be made, others vote and claim it, the
 * claimer marks it done. The two surfaces share only the board key and the
 * database file; the shapes are their own.
 *
 * FROZEN AHEAD OF THE CODE, like the achievements contract: every later
 * file is checked AGAINST this rather than this being edited to match
 * whatever got written. docs/REQUESTS-API.md is the prose twin and
 * tests/requests/contract.test.ts fails if the two drift.
 *
 * No imports, ever. The mirror is a single vendored file with no module
 * graph behind it, which is what makes a C89-adjacent client able to read it
 * and a TypeScript one able to copy it.
 */

export const REQUESTS_CONTRACT_VERSION = '1';

/** The literal that opens every plain-text response's header line. */
export const REQUESTS_TEXT_FORMAT = 'REQUEST';
/** The header line's format version. Appending a field never bumps it. */
export const REQUESTS_TEXT_VERSION = '1';

/** What is being asked for. Plain words a C89 client tests with strcmp. */
export type RequestKind = 'release' | 'art';
export const REQUEST_KINDS = ['release', 'art'] as const;

/**
 * open   -> a caller posted it, nobody is working on it
 * claimed -> someone took it and is working on it
 * done   -> the claimer delivered it; takes no more votes, cannot be reclaimed
 * withdrawn -> the author pulled it; same terminal posture as done
 */
export type RequestState = 'open' | 'claimed' | 'done' | 'withdrawn';
export const REQUEST_STATES = ['open', 'claimed', 'done', 'withdrawn'] as const;

/**
 * The field caps, server-side and mirrored in the door's input widths. A
 * value longer than its cap is REFUSED, never silently truncated - a
 * truncated title is a different request from the one the caller typed.
 */
export const REQUEST_CAPS = {
  title: 60,
  notes: 200,
  handle: 24,
  doneNote: 80,
} as const;

/** One row of a listing. The identity is (board, handle), never an email. */
export interface RequestRow {
  id: number;
  kind: RequestKind;
  state: RequestState;
  votes: number;
  board: string;
  handle: string;
  title: string;
  claimHandle: string | null;
  createdAt: string; // ISO 8601, UTC
  updatedAt: string; // ISO 8601, UTC
}

export interface RequestDetail extends RequestRow {
  notes: string;
  claimBoard: string | null;
  doneNote: string | null;
  claimedAt: string | null;
  doneAt: string | null;
}

export interface ListResponse {
  contractVersion: string;
  revision: string;
  rows: RequestRow[];
}

/** POST /requests. The handle is the caller's board handle, never typed. */
export interface PostRequest {
  kind: RequestKind;
  title: string;
  notes?: string;
  handle: string;
}
export interface PostResponse {
  id: number;
  state: 'open';
  at: string;
}

/** POST /requests/<id>/vote. A repeat vote by the same identity is a no-op. */
export interface VoteRequest {
  handle: string;
}
export interface VoteResponse {
  id: number;
  votes: number;
  voted: boolean;
}

/** POST /requests/<id>/claim. */
export interface ClaimRequest {
  handle: string;
}
export interface ClaimResponse {
  id: number;
  state: RequestState;
  claimHandle: string;
}

/** POST /requests/<id>/release, /done, /withdraw. `note` is done-only. */
export interface ActionRequest {
  handle: string;
  note?: string;
}
export interface ActionResponse {
  id: number;
  state: RequestState;
}

/** GET /health, on the requests surface itself. */
export interface RequestsHealth {
  status: string;
  contractVersion: string;
  open: number;
  claimed: number;
  done: number;
  boards: number;
}

export interface ApiError {
  error: string;
  detail?: string;
  retryAfter?: number;
}

/**
 * The plain-text list variant's columns, in order. Append-only: a new field
 * goes on the END and the header's version number does not move, because a
 * conforming parser reads by position and ignores what it does not know.
 */
export const LIST_TXT_FIELDS = [
  'id',
  'kind',
  'state',
  'votes',
  'board',
  'handle',
  'title',
  'claim_handle',
  'created',
  'updated',
] as const;

/** scope=global lists everyone's; board lists this board's; mine, this caller's. */
export const REQUEST_SCOPES = ['global', 'board', 'mine'] as const;
export type RequestScope = (typeof REQUEST_SCOPES)[number];

/**
 * Every error string this surface can put in `ApiError.error`. A client may
 * switch on these exhaustively; a code is never removed, only added.
 */
export const REQUEST_ERROR_CODES = [
  // 400 - the request itself
  'bad_request',
  'bad_kind',
  'bad_title',
  'bad_handle',
  // 401 / 403
  'unauthenticated',
  'board_suspended',
  // 403 - the caller is not who this action needs
  'not_yours',
  // 404
  'not_found',
  // 409 - the request is not in a state this action allows
  'already_claimed',
  'wrong_state',
  // 429
  'rate_limited',
] as const;
export type RequestErrorCode = (typeof REQUEST_ERROR_CODES)[number];

/** Every HTTP status this surface answers with. */
export const REQUEST_STATUS_CODES = [200, 400, 401, 403, 404, 409, 429] as const;
export type RequestStatusCode = (typeof REQUEST_STATUS_CODES)[number];

/**
 * Every path under /requests/v1, as documented. `<...>` marks a path segment
 * the caller fills in.
 */
export const REQUEST_ENDPOINTS = [
  'GET /health',
  'GET /list',
  'GET /list.txt',
  'GET /requests/<id>',
  'GET /requests/<id>.txt',
  'POST /requests',
  'POST /requests/<id>/vote',
  'POST /requests/<id>/claim',
  'POST /requests/<id>/release',
  'POST /requests/<id>/done',
  'POST /requests/<id>/withdraw',
] as const;
export type RequestEndpoint = (typeof REQUEST_ENDPOINTS)[number];

/** The curation route, gated by an admin token rather than a board key. */
export const REQUEST_ADMIN_ENDPOINTS = ['DELETE /admin/requests/<id>'] as const;
export type RequestAdminEndpoint = (typeof REQUEST_ADMIN_ENDPOINTS)[number];
