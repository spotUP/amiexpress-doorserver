/**
 * One refusal type for the whole achievements surface.
 *
 * It was born in boards.ts as `BoardError` and is renamed and moved here the
 * moment a SECOND module needs to refuse a request. Nothing about "an error
 * carrying one of the contract's own error codes and the status that goes
 * with it" was ever board-specific; only the name was. A parallel
 * PlayerError with the same three fields would have been two classes, two
 * branches in the router's error handler, and two places for a code to drift
 * out of ERROR_CODES.
 *
 * `code` is typed as the contract's own ErrorCode union, so a route cannot
 * invent a string a client has never heard of: adding one means adding it to
 * contract/achievement-types.ts and to docs/ACHIEVEMENTS-API.md, which the
 * drift test then checks against each other.
 */
import type { ErrorCode } from '../../contract/achievement-types';
import type { RequestErrorCode } from '../../contract/request-types';
import type { ChatErrorCode } from '../../contract/chat-types';

/**
 * The requests surface (src/requests/) throws the same SurfaceError with its
 * own code list. The class was always "an error carrying one of a contract's
 * error codes and the status that goes with it"; only the union of which
 * contract widens. A parallel RequestError would have been a second class and
 * a second branch in every router's error handler for no gain.
 */
export type SurfaceErrorCode = ErrorCode | RequestErrorCode | ChatErrorCode;

/**
 * The statuses a REFUSAL carries. A 5xx is deliberately not among them: it
 * is retryable by status alone and carries no error code a client reads
 * (ACHIEVEMENTS-API.md, section 6), so it is never thrown - it is what the
 * router answers when something unexpected reached it.
 */
export type RefusalStatus = 400 | 401 | 403 | 404 | 409 | 429;

export class SurfaceError extends Error {
  constructor(
    readonly code: SurfaceErrorCode,
    readonly status: RefusalStatus,
    message: string,
    /** Seconds, for a 429; the router sends it as Retry-After and in the body. */
    readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'SurfaceError';
  }
}
