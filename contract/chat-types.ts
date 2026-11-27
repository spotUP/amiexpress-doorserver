/**
 * The federated live-chat wire contract: the shapes every client compiles
 * against (the BBS adapter, the web door, and later the 68K door through
 * sdk/c/include/ae_chat.h). CHAT_CONTRACT_VERSION is echoed on every
 * response as X-Chat-Contract.
 *
 * A SIBLING of contract/request-types.ts and shaped like it: frozen ahead of
 * the code, docs/CHAT-API.md is the prose twin, and
 * tests/chat-contract-mirror.test.ts fails when the two drift.
 *
 * No imports, ever: a C89-adjacent client must be able to read this file.
 */

export const CHAT_CONTRACT_VERSION = '1';

/** The version that follows the format literal on every .txt header line. */
export const CHAT_TEXT_VERSION = '1';

/**
 * Every plain-text format's header literal and the number of `|` fields in
 * each of its rows. Append-only: a new field goes on the END and the version
 * never moves.
 */
export const CHAT_TEXT_FORMATS = {
  ROOMS: ['id', 'name', 'topic', 'visibility', 'members', 'owner', 'kind'],
  MEMBERS: ['user', 'sysop', 'op', 'roleColor', 'roleName', 'status', 'statusText', 'label', 'active', 'lastActive'],
  HISTORY: ['seq', 'id', 'user', 'at', 'replyTo', 'threadId', 'roleColor', 'text', 'label'],
  EVENTS: ['seq', 'type', 'room', 'user', 'ref', 'at', 'roleColor', 'text', 'replyTo', 'label'],
  REACTIONS: ['emoji', 'count', 'mine'],
  WHO: ['user', 'room', 'sysop', 'roleColor', 'idleSeconds', 'status', 'statusText', 'label'],
  /** The boards whose callers the Discord bridge may copy (discord_mirror on), upper-cased. */
  DISCORD: ['board'],
  /** The Discord channel links the bridge must run: link id, hub room, channel id, requesting board. */
  DISCORD_LINKS: ['id', 'room', 'channelId', 'board'],
  DM: ['threadId', 'peer', 'lastAt', 'unread'],
  PROFILE: ['user', 'nick', 'board', 'status', 'statusText', 'firstSeen', 'lastSeen', 'idleSeconds', 'online', 'sharedRooms'],
  IGNORES: ['user', 'at'],
  /** The caller's persistent rooms; `lastRead` is a message seq, `unread` the top-level messages after it. */
  MEMBERSHIPS: ['roomId', 'name', 'lastRead', 'unread'],
  /** One canvas row: `y` 0-23, `cells` in the canvas wire encoding (docs/CHAT-API.md). */
  CANVAS: ['y', 'cells'],
  /** One ready file of a room, newest first; `at` is the epoch second it was shared, `label` the uploader's board label, `kind` the sniffed type, `imgW`/`imgH` the pixel size of a picture (0 when not a picture). */
  FILES: ['id', 'name', 'size', 'uploader', 'at', 'label', 'kind', 'imgW', 'imgH'],
  /** Notes on one user, oldest first: a sysop or hub admin reads every note, anyone else only their own. */
  NOTES: ['id', 'target', 'author', 'at', 'text'],
} as const;
export type ChatTextFormat = keyof typeof CHAT_TEXT_FORMATS;

/** Event types that can appear in the `type` column of events.txt. */
export const CHAT_EVENT_TYPES = [
  'message',
  'edit',
  'delete',
  'react',
  'unreact',
  'joined',
  'left',
  'topic',
  'room_motd',
  'room_created',
  'room_deleted',
  'room_renamed',
  'kicked',
  'banned',
  'muted',
  'unmuted',
  'op',
  'deop',
  /** A message was pinned (text '1') or unpinned (text '0'); ref = the message id. */
  'pin',
  /** A /mode change; text = the applied modes, e.g. `+i +o alice@BOARD`. */
  'mode',
  /** A member's whole input buffer while typing; text empty = stopped. Trimmed to 200 characters. */
  'typing',
  /** A voice-room call roster change; ref = joined|left|state, text = two digits: muted, camera on (e.g. `01`). */
  'voice',
  /** One WebRTC offer/answer/ICE signal between two members of a call; label = room id, ref = kind, text = base64 of the data. Seen only by sender and target. */
  'voice_signal',
  'dm',
  'role',
  'motd',
  'presence',
  'board_joined',
  /** Board-local BBS activity (ref = the BBS event type); see BBS_EVENT_TYPES. */
  'bbs',
  /** A board's sysop switched the Discord mirror; ref = the board id upper-cased, text = '1' on / '0' off. Seen by every session. */
  'discord_mirror',
  /** A Discord channel link changed state; ref = the link id, text = `linked`, `failed`, or `removed` (admin unlinked). Seen by every session so the bridge refreshes at once. */
  'discord_link',
  /** One edit of an art room's shared canvas; ref = the new revision, text = the ops (canvas wire encoding). Never relayed to Discord. */
  'canvas',
  /** A file finished uploading to a room; ref = the file id, text = `name|size|kind`. */
  'file_shared',
  /** A shared file went away; ref = the file id, text = `name|why` (uploader, op, sysop, expired or room-cleared). */
  'file_deleted',
  /** A board's custom emoji set changed (put or delete); ref = the emoji name. Every session sees it. */
  'emoji',
] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

/** The BBS event types a board may relay through POST /bbs-events: the web backend's bbsEventEmitter set. */
export const BBS_EVENT_TYPES = ['user_login', 'user_logout', 'upload', 'download', 'door_activity', 'custom_door_event', 'command', 'system_notice'] as const;
export type BbsEventType = (typeof BBS_EVENT_TYPES)[number];

/** The `data` keys a relayed BBS event keeps; they travel urlencoded in the event's text field. */
export const BBS_EVENT_DATA_KEYS = ['location', 'duration', 'fileName', 'fileSize', 'conferenceName', 'action', 'doorName', 'eventType', 'message', 'isPersonalBest'] as const;

/** Every error string a chat reply can put in `ChatApiError.error`. Never removed, only added. */
export const CHAT_ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'session_expired',
  'forbidden',
  'banned',
  'muted',
  'not_member',
  'invite_required',
  'not_found',
  'too_long',
  'conflict',
  'rate_limited',
  /** The room is moderated (+m) and the caller has neither voice (+v) nor op (+o). */
  'moderated',
  /** The request carried `as` but the board is not a relay board (boards.chat_relay). */
  'not_relay',
  /** A file is larger than fileMaxBytes (also the answer to a chunk over fileChunkMax). */
  'too_large',
  /** A file quota (per user or board per day, or the hub's disk ceiling) is used up. */
  'quota',
  /** The file was deleted or expired. */
  'file_gone',
  /** The hub has no CHAT_FILES_DIR: the file surface answers 503. */
  'files_disabled',
  /** A preview was asked for a file that is not a decodable picture (415). */
  'not_image',
  /** Global accounts: the handle is held by another account (409). Pick a new handle. */
  'handle_taken',
  /** Global accounts: the email is held by another account (409). */
  'email_taken',
  /** Global accounts: the password-reset code is wrong, spent or expired (400). */
  'bad_code',
] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

/** Field and request limits, one object. The server's defaults; docs quote these numbers. */
/**
 * The federation's landing room. Room lists put it first, so every client
 * that auto-joins the first listed room (LIVECHAT68 does) lands here, no
 * matter which other rooms sort before it by name.
 */
export const CHAT_DEFAULT_ROOM_KEY = 'lobby';

/** The board id the Discord bridge registers as; its users are `name@DISCORD`. */
export const CHAT_DISCORD_BOARD = 'discord';
/** Appended to the text of a Discord-origin message in the .txt rows (D7). */
export const CHAT_DISCORD_MARKER = ' [Discord]';

export const CHAT_LIMITS = {
  contentMax: 500,
  handleMax: 32,
  roomNameMax: 32,
  topicMax: 120,
  clientIdMax: 64,
  emojiMaxBytes: 32,
  roleNameMax: 24,
  historyDefault: 20,
  historyMax: 100,
  eventsPerPoll: 200,
  pollMaxWaitSeconds: 25,
  pollDefaultWaitSeconds: 20,
  sessionTtlSeconds: 90,
  activeWindowSeconds: 600,
  messagesPerSession: 20,
  messagesPerSessionWindowSeconds: 10,
  messagesPerBoardPerMinute: 300,
  sessionsPerBoard: 30,
  roomCreationsPerBoardPerHour: 6,
  heldPollsPerBoard: 64,
  eventsKept: 50000,
  statusTextMax: 120,
  ignoresPerUser: 200,
  /** Canvas posts per session per window. */
  canvasPostsPerSession: 40,
  canvasWindowMs: 10000,
  /** Longest ops string of one canvas post, in bytes. */
  canvasOpsMax: 512,
  /** Most cells (repeats counted) one canvas post may write. */
  canvasCellsMax: 1920,
  /** A text reply stops before it passes this many bytes (68K reply buffers are 8192). */
  replyMaxBytes: 7680,
  /** Largest shared file, in bytes (2 MB). */
  fileMaxBytes: 2097152,
  /** Largest shared video (mp4, webm, mov by magic bytes), in bytes (50 MB); every other file stays at fileMaxBytes. */
  videoMaxBytes: 52428800,
  /** Largest chunk of one PUT /files/:id/chunk, in bytes. */
  fileChunkMax: 32768,
  /** Ready files kept per room; the oldest expire first. */
  filesPerRoomKept: 200,
  /** Upload bytes one user may start per day (60 MB: one full-size video plus pictures). */
  fileBytesPerUserPerDay: 62914560,
  /** Upload bytes one board may start per day (300 MB). */
  fileBytesPerBoardPerDay: 314572800,
  /** Days a ready file is kept. */
  fileRetentionDays: 14,
  /** An unfinished upload with no chunk for this long is dropped. */
  fileUploadIdleSeconds: 600,
  /** Hard ceiling on bytes held by the hub (5 GB); begin refuses with `quota` past it. */
  hubFileBytesMax: 5368709120,
} as const;

export interface ChatApiError {
  error: ChatErrorCode | 'unauthenticated' | 'board_suspended' | 'internal_error';
  detail?: string;
  retryAfter?: number;
}

export type ChatVisibility = 'public' | 'private';

/**
 * What a room is for, chosen when it is created. `text` is plain chat,
 * `voice` a voice channel, `art` a shared drawing room. Stored on the room,
 * so no client has to infer it from the name.
 */
export const CHAT_ROOM_KINDS = ['text', 'voice', 'art'] as const;
export type ChatRoomKind = (typeof CHAT_ROOM_KINDS)[number];

/** Per-role permission flags. They ADD to room-op permission, on the role's own board. */
export interface ChatRolePerms {
  kick: boolean;
  ban: boolean;
  mute: boolean;
  topic: boolean;
  createPrivate: boolean;
}

/**
 * POST /sessions.
 *
 * `Authorization: Board <id>.<secret>`: the body names the board's own user as `bbs_user`.
 * A linked user gets a SessionReply as its account; an unlinked one gets a
 * NeedsAccountReply and NO session (the user then registers or links, below).
 * A board token alone never opens a session as an existing account.
 *
 * `Authorization: Account <token>`: the body may be empty; the session is the account's.
 */
export interface SessionRequest {
  /** The board's username for this caller (case-folded by the hub). Board key only. */
  bbs_user?: string;
  /** What the board knows about the user, echoed back in NeedsAccountReply to prefill the form. */
  prefill?: AccountPrefill;
  sysop?: boolean;
  client?: string;
  /** The board's own bot (never a caller): every client shows it as `[BOT] <handle>` and the handle is reserved. */
  bot?: boolean;
  /** Bot sessions only (`bot: true`): the bot's handle. A user session takes its handle from the account. */
  handle?: string;
}
export interface SessionReply {
  sid: string;
  /** The account handle. No `@BOARD` suffix. */
  user: string;
  expiresIn: number;
  /** Seconds a member counts as active after typing or sending (members' `active` uses the same window). */
  activeWindow: number;
}

/** A Partyline account: one identity on the hub, shared by every board and client. */
export interface Account {
  id: number;
  /** Globally unique, case-insensitive. 1-32 characters, no whitespace, `|` or `@`. */
  handle: string;
  realname: string;
  location: string;
  /** True when the account has an email (self-service password reset works). The address itself is never returned. */
  hasEmail: boolean;
  bot: boolean;
  globalAdmin: boolean;
  /** Unix seconds. */
  createdAt: number;
}

/** What a board (or any client) offers as form defaults. Never trusted as identity. */
export interface AccountPrefill {
  handle?: string;
  realname?: string;
  location?: string;
  email?: string;
}

/** POST /sessions from a board whose `bbs_user` has no account link: 200, no session. */
export interface NeedsAccountReply {
  needs_account: true;
  prefill: AccountPrefill;
  /** Whether `prefill.handle` is a valid handle no account holds. */
  handle_free: boolean;
}
export type BoardSessionReply = SessionReply | NeedsAccountReply;

/** POST /accounts/register (no key). 409 `handle_taken` / `email_taken`. Password: 8-128 characters. */
export interface AccountRegisterRequest {
  handle: string;
  password: string;
  email?: string;
  realname?: string;
  location?: string;
}
/** `token` goes in `Authorization: Account <token>`. It dies when the password changes. */
export interface AccountAuthReply {
  account: Account;
  token: string;
}
/** POST /accounts/login (no key). 401 `unauthorized` on a wrong handle or password (same answer for both). */
export interface AccountLoginRequest {
  handle: string;
  password: string;
}
/** POST /accounts/password-reset/request (no key). Always 204: the reply never says whether the email is known. */
export interface PasswordResetRequest {
  email: string;
}
/** POST /accounts/password-reset/confirm (no key). 204; 400 `bad_code`. */
export interface PasswordResetConfirmRequest {
  email: string;
  code: string;
  password: string;
}
/** POST /accounts/:id/password. Global admin only (a global-admin Account token, or the hub's X-Admin-Token). 204. */
export interface AdminPasswordRequest {
  password: string;
}
/**
 * POST /accounts/register-via-board (Board key). Creates the account, links
 * (board, bbs_user) to it, claims the old `bbs_user@BOARD` rows and opens a session.
 */
export interface RegisterViaBoardRequest extends AccountRegisterRequest {
  bbs_user: string;
  sysop?: boolean;
  client?: string;
}
/**
 * POST /accounts/link-via-board (Board key). Verifies the ACCOUNT's password
 * (401 `unauthorized` when wrong), links, claims and opens a session.
 */
export interface LinkViaBoardRequest extends AccountLoginRequest {
  bbs_user: string;
  sysop?: boolean;
  client?: string;
}
/** The reply to both -via-board calls. */
export interface BoardAccountReply extends SessionReply {
  account: Account;
}

export interface RoomRow {
  id: string;
  name: string;
  topic: string;
  visibility: ChatVisibility;
  members: number;
  owner: string;
  kind: ChatRoomKind;
}
export interface CreateRoomRequest {
  name: string;
  topic?: string;
  visibility?: ChatVisibility;
  kind?: ChatRoomKind;
}
export interface CreateRoomReply {
  id: string;
  name: string;
  visibility: ChatVisibility;
  kind: ChatRoomKind;
}
export interface JoinReply {
  id: string;
  name: string;
  topic: string;
  /** The room's message of the day; empty when none is set. */
  motd: string;
  members: number;
  ops: string[];
  since: number;
  /** The caller's read marker in this room (a message seq); a first join starts at the room's newest message. */
  lastRead: number;
}

export interface PostMessageRequest {
  content: string;
  clientId: string;
  replyTo?: string;
  threadId?: string;
}
export interface PostMessageReply {
  id: string;
  seq: number;
  at: number;
}
export interface EditMessageRequest {
  content: string;
}
/**
 * Relay boards only (boards.chat_relay, set by the server admin): post, edit,
 * delete, react, unreact, thread posts, direct messages (POST /dm/:peer,
 * POST /dm-group) and GET /dm/:threadId/history.txt (query) may carry `as` (body, or query on
 * DELETE and GET) to act as `as@<own board>`. Any other board gets 403 not_relay.
 */
export interface RelayActing {
  as?: string;
}
export interface DiscordMirrorRequest {
  on: boolean;
}
export interface DiscordMirrorReply {
  on: boolean;
}
export interface EditMessageReply {
  id: string;
  seq: number;
}
export interface ReactRequest {
  emoji: string;
}
export interface ReactReply {
  count: number;
}
export interface ThreadPostRequest {
  content: string;
  clientId: string;
}

export interface DmPostRequest extends RelayActing {
  content: string;
  clientId: string;
}
export interface DmPostReply {
  id: string;
  seq: number;
  threadId: string;
}

export interface ModUserRequest {
  user: string;
  reason?: string;
  minutes?: number;
}
export interface TopicRequest {
  topic: string;
}
export interface VisibilityRequest {
  visibility: ChatVisibility;
}
export interface InviteRequest {
  user: string;
}
export interface MotdRequest {
  text: string;
}

export interface RoleRow {
  id: string;
  name: string;
  colorHex: string;
  colorAnsi: number;
  position: number;
  perms: ChatRolePerms;
}
export interface RoleInput {
  name: string;
  colorHex: string;
  colorAnsi: number;
  position?: number;
  perms?: Partial<ChatRolePerms>;
}
export interface RoleAssignment {
  handle: string;
  roleId: string;
}
export interface RoleAssignmentRequest {
  roleIds: string[];
}

export interface PinRow {
  messageId: string;
  user: string;
  content: string;
  pinnedBy: string;
  at: number;
  /** When the pinned message was posted (unix seconds); `at` is when it was pinned. */
  messageAt: number;
}
export interface SearchHit {
  id: string;
  /** The message's room seq, so a client can load history around a hit it has not paged in. */
  seq: number;
  room: string;
  user: string;
  at: number;
  content: string;
}
export interface EmojiRow {
  boardId: string;
  name: string;
  /** Image shape; '' for a text emoji. */
  dataUrl: string;
  /** Text shape: what a web caller sees; '' for an image emoji. */
  display: string;
  /** Text shape: what a telnet or SSH caller sees; '' for an image emoji. */
  ascii: string;
}

/** Every endpoint under /chat/v1, as "METHOD /path". docs/CHAT-API.md lists exactly these. */
export const CHAT_ENDPOINTS = [
  'GET /health',
  'POST /sessions',
  'POST /accounts/register',
  'POST /accounts/login',
  'POST /accounts/password-reset/request',
  'POST /accounts/password-reset/confirm',
  'POST /accounts/:id/password',
  'POST /accounts/register-via-board',
  'POST /accounts/link-via-board',
  'DELETE /sessions/current',
  'GET /rooms.txt',
  'GET /rooms',
  'POST /rooms',
  'POST /rooms/:id/join',
  'POST /rooms/:id/leave',
  'GET /rooms/:id/members.txt',
  'GET /rooms/:id/history.txt',
  'GET /memberships.txt',
  'PUT /rooms/:id/read',
  'POST /rooms/:id/unread',
  'PUT /rooms/:id/name',
  'POST /rooms/:id/messages',
  'PUT /messages/:id',
  'DELETE /messages/:id',
  'POST /messages/:id/react',
  'DELETE /messages/:id/react/:emoji',
  'GET /messages/:id/reactions.txt',
  'POST /messages/:id/thread',
  'GET /threads/:id.txt',
  'GET /who.txt',
  'POST /rooms/:id/invites',
  'DELETE /rooms/:id/invites/:user',
  'GET /dm.txt',
  'POST /dm/:peer',
  'POST /dm-group',
  'GET /dm/:threadId/history.txt',
  'GET /dm/:threadId/participants.txt',
  'GET /events.txt',
  'POST /rooms/:id/kick',
  'POST /rooms/:id/ban',
  'POST /rooms/:id/unban',
  'POST /rooms/:id/mute',
  'POST /rooms/:id/unmute',
  'POST /rooms/:id/op',
  'POST /rooms/:id/mode',
  'POST /rooms/:id/typing',
  'GET /rooms/:id/voice',
  'POST /rooms/:id/voice/join',
  'POST /rooms/:id/voice/leave',
  'PUT /rooms/:id/voice',
  'POST /rooms/:id/voice/signal',
  'PUT /rooms/:id/voice/audio',
  'GET /rooms/:id/canvas.txt',
  'POST /rooms/:id/canvas',
  'POST /rooms/:id/deop',
  'PUT /rooms/:id/topic',
  'PUT /rooms/:id/motd',
  'PUT /rooms/:id/visibility',
  'DELETE /rooms/:id',
  'POST /rooms/:id/archive',
  'POST /rooms/:id/clear',
  'GET /motd',
  'PUT /motd',
  'GET /discord',
  'PUT /discord',
  'GET /discord/boards.txt',
  'GET /discord/invite',
  'POST /discord/join',
  'GET /discord/join',
  'PUT /discord/app',
  'POST /discord/links/:id/error',
  'GET /discord/links.txt',
  'GET /roles',
  'POST /roles',
  'PUT /roles/:id',
  'DELETE /roles/:id',
  'GET /roles/assignments',
  'PUT /roles/assignments/:handle',
  'GET /rooms/:id/pins',
  'POST /rooms/:id/pins',
  'DELETE /rooms/:id/pins/:messageId',
  'GET /search',
  'POST /users/:user/notes',
  'GET /users/:user/notes',
  'GET /users/:user/notes.txt',
  'GET /users/:user/history',
  'GET /users/:user/history.txt',
  'GET /emoji',
  'GET /emoji.txt',
  'POST /bbs-events',
  'PUT /emoji/:name',
  'DELETE /emoji/:name',
  'PUT /presence',
  'DELETE /presence',
  'GET /users/:user/profile.txt',
  'GET /ignores.txt',
  'POST /ignores',
  'DELETE /ignores/:user',
  'POST /rooms/:id/files',
  'PUT /files/:id/chunk',
  'POST /files/:id/finish',
  'DELETE /files/:id',
  'GET /rooms/:id/files.txt',
  'GET /rooms/:id/files',
  'GET /files/:id',
  'GET /files/:id/preview.png',
  'GET /files/:id/preview.rgb',
  'GET /admin/files',
  'DELETE /admin/files/:id',
] as const;
export type ChatEndpoint = (typeof CHAT_ENDPOINTS)[number];
