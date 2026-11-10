/**
 * The achievements wire contract: the shapes every client compiles against.
 * Clients vendor a generated mirror (scripts/gen-achievement-types.ts);
 * ACHIEVEMENTS_CONTRACT_VERSION tells a client whether its mirror is old
 * enough to matter. Echoed on every response as X-Achievements-Contract.
 *
 * This file is FROZEN AHEAD OF THE CODE on purpose. It describes endpoints
 * that do not exist yet; every later task is checked AGAINST it rather than
 * the file being edited to match whatever got written. SP2 (the web BBS
 * reporter) and SP4 (the 68K client) compile against this and nothing else.
 *
 * The prose reference is docs/ACHIEVEMENTS-API.md, and
 * tests/achievements/contract.test.ts fails if the two drift: every status
 * code and every field name the document names must exist here.
 *
 * No imports, ever. The mirror is a single vendored file with no module
 * graph behind it, which is what makes a C89-adjacent client able to read
 * it and a TypeScript one able to copy it.
 */

export const ACHIEVEMENTS_CONTRACT_VERSION = '1';

/** The literal that opens every plain-text response's header line. */
export const ACHIEVEMENTS_TEXT_FORMAT = 'ACHIEVE';
/** The header line's format version. Appending a field never bumps it. */
export const ACHIEVEMENTS_TEXT_VERSION = '1';

export type Tier = 'bronze' | 'silver' | 'gold' | 'platinum';
export type RarityBucket = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

/**
 * Rules are DATA. There is no per-achievement code anywhere on the server,
 * and a client never evaluates one - it reports facts and is told what
 * unlocked.
 */
export type Rule =
  | { op: 'count';    type: string; key?: string; n: number }
  | { op: 'first';    type: string; key?: string }
  | { op: 'sum';      type: string; field: 'value'; n: number }
  | { op: 'distinct'; type: string; dim: 'key' | 'board'; n: number; group?: 'key' }
  | { op: 'streak';   type: string; unit: 'day'; n: number }
  | { op: 'within';   type: string; n: number; window_s: number }
  | { op: 'all';      ids: string[] }
  | { op: 'granted' };                       // server-granted only (D11)

export interface AchievementDef {
  id: string; name: string; description: string; family: string;
  tier: Tier; points: number; hidden: boolean; rule: Rule;
}

export interface CatalogAchievement extends AchievementDef {
  rarityPctTenths: number;                   // 81 = 8.1% (integers for C89)
  rarityBucket: RarityBucket;
  updatedAt: string;                         // ISO 8601, UTC
}

export interface CatalogResponse {
  contractVersion: string; revision: string; since: string | null;
  achievements: CatalogAchievement[];
}

export interface EventIn {
  ref: string; email: string; type: string; at: string;
  value?: number; key?: string | null; door?: string | null; client?: string | null;
}

export interface UnlockOut {
  id: string; name: string; tier: Tier; points: number;
  hidden: boolean; rarityPctTenths: number; at: string;
}

export interface ProgressOut { id: string; have: number; need: number }

/**
 * Why an individual event was dropped (D3). A batch is drained from an
 * outbox that mixes players and event types, so one bad row must not reject
 * ninety-nine good ones - and the sender has to be told WHICH row to delete.
 */
export const REJECT_REASONS = [
  'unknown_event_type',
  'not_linked',
  'unknown_player',
  'unverified_player',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface RejectedEvent { ref: string; reason: RejectReason }

export interface EventsRequest { events: EventIn[] }

export interface EventsResponse {
  accepted: number; duplicates: number;
  rejected: RejectedEvent[];                 // TERMINAL - never retried (D3)
  notLinked: string[];                       // emails whose board link is missing
  unlocks: UnlockOut[]; progress: ProgressOut[];
}

export interface PlayerProfile {
  handle: string; verified: boolean; private: boolean;
  points: number; linkedBoards: string[];
  unlocks: UnlockOut[]; progress: ProgressOut[];
  linkCode?: string; linkCodeExpiresAt?: string;  // only on verify / rotate
}

export interface LeaderboardRow { rank: number; handle: string; points: number; unlocks: number }
export interface LeaderboardResponse {
  scope: string; period: 'all' | 'season'; season: string | null;
  revision: string; rows: LeaderboardRow[];
}

export interface ApiError { error: string; detail?: string; retryAfter?: number }

// ---------------------------------------------------------------------------
// Requests and responses the endpoint list needs and the shapes above do not
// yet name. Everything below is additive to the frozen core: SP2 and SP4 code
// against these, so leaving them to be invented per task would have been the
// same as not freezing the contract at all.
// ---------------------------------------------------------------------------

/** POST /players. The handle is the ONLY identifier any listing ever shows. */
export interface RegisterRequest { email: string; handle: string }
/** POST /players/resend. */
export interface ResendRequest { email: string }
/** POST /players/verify. */
export interface VerifyRequest { email: string; code: string }

/**
 * The answer to anything that queues mail. Always 202, and always the same
 * body whether or not the address is known - the response never reveals
 * whether an email is registered.
 */
export interface QueuedResponse { queued: true }

/** POST /links and POST /links/rotate carry the code; DELETE /links does not. */
export interface LinkRequest { email: string; code: string }
export interface UnlinkRequest { email: string }

/**
 * A link code is single-use: a successful link issues the NEXT one in the
 * same response, so a player linking three boards types three codes.
 */
export interface LinkResponse {
  linked: boolean; boards: string[];
  linkCode?: string; linkCodeExpiresAt?: string;
}

export interface RotateLinkResponse { linkCode: string; linkCodeExpiresAt: string }

/** PATCH /players/<email>. Only the player's own flags, only from a linked board. */
export interface PlayerPatchRequest { private?: boolean; handle?: string }

/** PUT /catalog/doors/<door>. The digest is the door manifest's own. */
export interface DoorCatalogRequest { digest: string; achievements: AchievementDef[] }
export interface DoorCatalogResponse { added: number; unchanged: number; total: number }

/** GET /health, on the achievements surface itself. */
export interface AchievementsHealth {
  status: string; contractVersion: string; revision: string;
  players: number; boards: number; pendingMail: number; season: string | null;
}

/**
 * What the DOOR-REPO health object gains. `enabled: false` and nothing else
 * when the surface is off, so the container healthcheck cannot start failing
 * on a server that never wanted achievements.
 */
export interface AchievementsHealthSummary {
  enabled: boolean; contractVersion?: string; players?: number; pendingMail?: number;
}

/** Curation, not a board-facing API: gated by the admin token, not a board key. */
export interface BoardSummary {
  id: string; name: string; contact: string | null;
  createdAt: string; suspendedAt: string | null;
  /** Relay board (Discord bridge): its chat session may post `as` its own users. */
  chatRelay: boolean;
  /** The board's sysop opted its callers into the Discord mirror (/discord on). */
  discordMirror: boolean;
}
export interface BoardCreateRequest { id: string; name: string; contact?: string | null }
/** The plaintext key is returned ONCE, at creation and at rotation. */
export interface BoardKeyResponse { id: string; key: string }

/**
 * The plain-text variants' columns, in order. Append-only: a new field goes
 * on the END and the header's version number does not move, because a
 * conforming parser reads by position and ignores what it does not know.
 */
export const CATALOG_TXT_FIELDS = [
  'id', 'family', 'tier', 'points', 'hidden',
  'name', 'description', 'op', 'rarity_tenths', 'bucket',
] as const;
export const LEADERBOARD_TXT_FIELDS = ['rank', 'handle', 'points', 'unlocks'] as const;

export const LEADERBOARD_PERIODS = ['all', 'season'] as const;
export type LeaderboardPeriod = (typeof LEADERBOARD_PERIODS)[number];

/**
 * Every error string this surface can put in `ApiError.error`. A client may
 * switch on these exhaustively; a code is never removed, only added.
 */
export const ERROR_CODES = [
  // 400 - the request itself
  'bad_request',
  'batch_empty',
  'batch_too_large',
  'event_missing_field',
  'event_field_too_long',
  'meta_type_rejected',
  'bad_email',
  'bad_handle',
  'bad_code',
  'code_expired',
  'code_burned',
  'bad_door',
  'bad_namespace',
  'bad_rule',
  'bad_definition',
  'too_many',
  'bad_scope',
  // 401 / 403
  'unauthenticated',
  'board_suspended',
  'not_linked',
  'unverified_player',
  // 409
  'handle_taken',
  'definition_changed',
  'board_exists',
  // 429
  'rate_limited',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Every HTTP status this surface answers with. */
export const STATUS_CODES = [200, 202, 304, 400, 401, 403, 404, 409, 429, 503] as const;
export type StatusCode = (typeof STATUS_CODES)[number];

/**
 * Every path under /achievements/v1, as documented. `<...>` marks a path
 * segment the caller fills in.
 */
export const ENDPOINTS = [
  'POST /players',
  'POST /players/verify',
  'POST /players/resend',
  'POST /links',
  'DELETE /links',
  'POST /links/rotate',
  'POST /events',
  'GET /catalog',
  'GET /catalog.txt',
  'PUT /catalog/doors/<door>',
  'GET /leaderboard',
  'GET /leaderboard.txt',
  'GET /players/<email>',
  'PATCH /players/<email>',
  'GET /health',
] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

/** The curation routes, gated by an admin token rather than a board key. */
export const ADMIN_ENDPOINTS = [
  'GET /admin/boards',
  'POST /admin/boards',
  'POST /admin/boards/<id>/rotate',
  'POST /admin/boards/<id>/suspend',
  'POST /admin/boards/<id>/resume',
  'POST /admin/boards/<id>/relay',
  'POST /admin/boards/<id>/unrelay',
] as const;
export type AdminEndpoint = (typeof ADMIN_ENDPOINTS)[number];
