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
  MEMBERS: ['user', 'sysop', 'op', 'roleColor', 'roleName', 'status', 'statusText', 'label'],
  HISTORY: ['seq', 'id', 'user', 'at', 'replyTo', 'threadId', 'roleColor', 'text', 'label'],
  EVENTS: ['seq', 'type', 'room', 'user', 'ref', 'at', 'roleColor', 'text', 'replyTo', 'label'],
  REACTIONS: ['emoji', 'count', 'mine'],
  WHO: ['user', 'room', 'sysop', 'roleColor', 'idleSeconds', 'status', 'statusText', 'label'],
  /** The boards whose callers the Discord bridge may copy (discord_mirror on), upper-cased. */
  DISCORD: ['board'],
  DM: ['threadId', 'peer', 'lastAt', 'unread'],
  PROFILE: ['user', 'nick', 'board', 'status', 'statusText', 'firstSeen', 'lastSeen', 'idleSeconds', 'online', 'sharedRooms'],
  IGNORES: ['user', 'at'],
  /** One canvas row: `y` 0-23, `cells` in the canvas wire encoding (docs/CHAT-API.md). */
  CANVAS: ['y', 'cells'],
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
  'kicked',
  'banned',
  'muted',
  'unmuted',
  'op',
  'deop',
  /** A /mode change; text = the applied modes, e.g. `+i +o alice@BOARD`. */
  'mode',
  /** A member's whole input buffer while typing; text empty = stopped. Trimmed to 200 characters. */
  'typing',
  'dm',
  'role',
  'motd',
  'presence',
  'board_joined',
  /** Board-local BBS activity (ref = the BBS event type); see BBS_EVENT_TYPES. */
  'bbs',
  /** A board's sysop switched the Discord mirror; ref = the board id upper-cased, text = '1' on / '0' off. Seen by every session. */
  'discord_mirror',
  /** One edit of an art room's shared canvas; ref = the new revision, text = the ops (canvas wire encoding). Never relayed to Discord. */
  'canvas',
] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

/** The BBS event types a board may relay through POST /bbs-events: the web backend's bbsEventEmitter set. */
export const BBS_EVENT_TYPES = ['user_login', 'user_logout', 'upload', 'download', 'door_activity', 'custom_door_event', 'command'] as const;
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
  historyMax: 50,
  eventsPerPoll: 200,
  pollMaxWaitSeconds: 25,
  pollDefaultWaitSeconds: 20,
  sessionTtlSeconds: 90,
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

export interface SessionRequest {
  handle: string;
  sysop?: boolean;
  client?: string;
}
export interface SessionReply {
  sid: string;
  user: string;
  expiresIn: number;
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
 * delete, react, unreact and thread posts may carry `as` (body, or query on
 * DELETE) to act as `as@<own board>`. Any other board gets 403 not_relay.
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

export interface DmPostRequest {
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
  'DELETE /sessions/current',
  'GET /rooms.txt',
  'GET /rooms',
  'POST /rooms',
  'POST /rooms/:id/join',
  'POST /rooms/:id/leave',
  'GET /rooms/:id/members.txt',
  'GET /rooms/:id/history.txt',
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
  'GET /events.txt',
  'POST /rooms/:id/kick',
  'POST /rooms/:id/ban',
  'POST /rooms/:id/unban',
  'POST /rooms/:id/mute',
  'POST /rooms/:id/unmute',
  'POST /rooms/:id/op',
  'POST /rooms/:id/mode',
  'POST /rooms/:id/typing',
  'GET /rooms/:id/canvas.txt',
  'POST /rooms/:id/canvas',
  'POST /rooms/:id/deop',
  'PUT /rooms/:id/topic',
  'PUT /rooms/:id/motd',
  'PUT /rooms/:id/visibility',
  'DELETE /rooms/:id',
  'POST /rooms/:id/clear',
  'GET /motd',
  'PUT /motd',
  'GET /discord',
  'PUT /discord',
  'GET /discord/boards.txt',
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
] as const;
export type ChatEndpoint = (typeof CHAT_ENDPOINTS)[number];
