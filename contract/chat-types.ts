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
  ROOMS: ['id', 'name', 'topic', 'visibility', 'members', 'owner'],
  MEMBERS: ['user', 'sysop', 'op', 'roleColor', 'roleName'],
  HISTORY: ['seq', 'id', 'user', 'at', 'replyTo', 'threadId', 'roleColor', 'text'],
  EVENTS: ['seq', 'type', 'room', 'user', 'ref', 'at', 'roleColor', 'text', 'replyTo'],
  REACTIONS: ['emoji', 'count', 'mine'],
  WHO: ['user', 'room', 'sysop', 'roleColor', 'idleSeconds'],
  DM: ['threadId', 'peer', 'lastAt', 'unread'],
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
  'room_created',
  'room_deleted',
  'kicked',
  'banned',
  'muted',
  'unmuted',
  'op',
  'deop',
  'dm',
  'role',
  'motd',
] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

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
] as const;
export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

/** Field and request limits, one object. The server's defaults; docs quote these numbers. */
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
} as const;

export interface ChatApiError {
  error: ChatErrorCode | 'unauthenticated' | 'board_suspended' | 'internal_error';
  detail?: string;
  retryAfter?: number;
}

export type ChatVisibility = 'public' | 'private';

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
}
export interface CreateRoomRequest {
  name: string;
  topic?: string;
  visibility?: ChatVisibility;
}
export interface CreateRoomReply {
  id: string;
  name: string;
  visibility: ChatVisibility;
}
export interface JoinReply {
  id: string;
  name: string;
  topic: string;
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
  dataUrl: string;
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
  'GET /dm/:threadId/history.txt',
  'GET /events.txt',
  'POST /rooms/:id/kick',
  'POST /rooms/:id/ban',
  'POST /rooms/:id/unban',
  'POST /rooms/:id/mute',
  'POST /rooms/:id/unmute',
  'POST /rooms/:id/op',
  'POST /rooms/:id/deop',
  'PUT /rooms/:id/topic',
  'PUT /rooms/:id/visibility',
  'DELETE /rooms/:id',
  'POST /rooms/:id/clear',
  'GET /motd',
  'PUT /motd',
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
  'PUT /emoji/:name',
  'DELETE /emoji/:name',
] as const;
export type ChatEndpoint = (typeof CHAT_ENDPOINTS)[number];
