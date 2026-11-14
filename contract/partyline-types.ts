/**
 * PLP/1, the Partyline wire between a board's thin client and the hub.
 * docs/PARTYLINE-PROTOCOL.md is the prose; this file is what both ends compile against.
 *
 * Frame, both directions: type (1 byte) | length (u16 big-endian) | payload.
 */

export const PLP_MAJOR = 1;
/** Highest minor this hub serves; every minor of PLP_MAJOR from 0 up is served. */
export const PLP_MINOR = 0;
export const PLP_MAX_PAYLOAD = 4096;
export const PLP_HEADER_BYTES = 3;

/** Client to hub. */
export const PLP_CLIENT = {
  HELLO: 'H',
  AUTH: 'A',
  INPUT: 'K',
  RESIZE: 'R',
  ACK: 'C',
  PING: 'P',
  UPLOAD: 'U',
  BYE: 'Q',
} as const;

/** Hub to client. */
export const PLP_HUB = {
  CHALLENGE: 'N',
  WELCOME: 'W',
  OUTPUT: 'D',
  GRAPHICS: 'G',
  SOUND: 'S',
  MEDIA: 'M',
  CTRL: 'T',
  PONG: 'O',
  EXIT: 'X',
} as const;

export type PlpClientType = (typeof PLP_CLIENT)[keyof typeof PLP_CLIENT];
export type PlpHubType = (typeof PLP_HUB)[keyof typeof PLP_HUB];

export interface PlpFrame {
  /** One ASCII character. Unknown types are ignored by both ends. */
  type: string;
  payload: Buffer;
}

/** BYE reasons. */
export type PlpByeReason = 'carrier' | 'timeout' | 'sysop' | 'user';

/**
 * The parsed HELLO: `key=value` lines. Unknown keys are ignored. `handle`
 * comes from the board session, never typed by the caller.
 */
export interface PlpHello {
  proto: string;
  client: string;
  board: string;
  handle: string;
  access: number;
  sysop: boolean;
  node: number;
  cols: number;
  rows: number;
  charset: 'latin1' | 'utf8';
  kitty: boolean;
  mouse: boolean;
  media: boolean;
  upload: 'none' | 'zmodem' | 'web' | 'aew';
  console: boolean;
  modem: number;
  /** Empty for a fresh login. */
  resume: string;
}

/** The WELCOME payload, sent as `key=value` lines. */
export interface PlpWelcome {
  /** `1.<minor>`: the highest minor both ends speak. */
  proto: string;
  /** Comma-separated capability names enabled for this session. */
  features: string;
  /** The hub's session id (log correlation, never a credential). */
  session: string;
  /** Present in the next HELLO as `resume=` to pick this session up after a disconnect. */
  resume: string;
}

/** Refusal reasons a hub writes in `X` after a refusal screen. */
export type PlpRefusal = 'old_client' | 'bad_hello' | 'unauthenticated' | 'board_suspended' | 'rate_limited' | 'draining' | 'login_timeout';

export const PLP_LIMITS = {
  /** HELLO and AUTH must both arrive within this many ms of connecting. */
  loginTimeoutMs: 10_000,
  /** The hub flushes a session's screen at most this often. */
  flushIntervalMs: 30,
  /** Default hub port, env PARTYLINE_PORT. TLS and plain share it (first byte 0x16 = TLS). */
  defaultPort: 6400,
} as const;
