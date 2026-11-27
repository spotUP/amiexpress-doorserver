/**
 * PLP/1 login: HELLO parsing, version pick, HMAC challenge-response.
 *
 * AUTH = hex(HMAC-SHA256(plpKey, nonce + board + handle)), where
 * plpKey = hex(HMAC-SHA256(board secret, "PLP/1 board key")) (plpKeyOf).
 * The hub stores plpKey (boards.plp_key), never the secret, so the board
 * secret never travels and a leaked row cannot call the HTTP surfaces.
 *
 * A HELLO without `board` is a direct client logging into its Partyline
 * account: `handle` is the account handle and AUTH carries the password.
 */
import * as crypto from 'crypto';
import type Database from 'better-sqlite3';
import { PLP_MAJOR, PLP_MINOR } from '../../contract/partyline-types';
import type { PlpHello, PlpRefusal } from '../../contract/partyline-types';
import { BOARD_ID, plpKeyOf } from '../achievements/boards';
import { validHandle } from '../chat/sessions';
import { loginAccount } from '../chat/accounts';
import { SurfaceError } from '../achievements/errors';
import { parseKv } from './frames';

export { plpKeyOf };

const int = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
};
const flag = (v: string | undefined): boolean => v === '1';
const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** `on,default,partyline`; anything else (an older board sends nothing) is undefined. */
export function parseResponsive(v: string | undefined): PlpHello['responsive'] {
  const m = /^(on|off),(default|on|off),([^,]*)$/.exec(v ?? '');
  return m ? { board: m[1] as 'on' | 'off', choice: m[2] as 'default' | 'on' | 'off', door: m[3] } : undefined;
}

/** Unknown keys are ignored; missing ones take defaults. Board and handle are checked in verifyAuth. */
export function parseHello(payload: Buffer): PlpHello {
  const kv = parseKv(payload);
  return {
    proto: kv.get('proto') ?? '',
    client: (kv.get('client') ?? '').slice(0, 64),
    board: kv.get('board') ?? '',
    handle: kv.get('handle') ?? '',
    access: int(kv.get('access'), 0),
    sysop: flag(kv.get('sysop')),
    node: int(kv.get('node'), 0),
    cols: Math.min(int(kv.get('cols'), 80) || 80, 255),
    rows: Math.min(int(kv.get('rows'), 25) || 25, 255),
    charset: oneOf(kv.get('charset'), ['latin1', 'utf8'] as const, 'latin1'),
    kitty: flag(kv.get('kitty')),
    wide: flag(kv.get('wide')),
    responsive: parseResponsive(kv.get('responsive')),
    chatOnly: flag(kv.get('chatonly')),
    mouse: flag(kv.get('mouse')),
    media: flag(kv.get('media')),
    upload: oneOf(kv.get('upload'), ['none', 'zmodem', 'web', 'aew'] as const, 'none'),
    console: flag(kv.get('console')),
    conn: oneOf(kv.get('conn'), ['telnet', 'web', 'ssh'] as const, 'telnet'),
    modem: int(kv.get('modem'), 0),
    resume: kv.get('resume') ?? '',
    realname: kv.get('realname')?.slice(0, 128) || undefined,
    location: kv.get('location')?.slice(0, 128) || undefined,
    email: kv.get('email')?.slice(0, 128) || undefined,
  };
}

/**
 * The minor both ends speak, or null when the client's major is not ours
 * (it gets the old-client refusal screen). A newer minor is served at ours.
 */
export function pickVersion(proto: string): number | null {
  const m = /^(\d+)\.(\d+)$/.exec(proto);
  if (!m || Number(m[1]) !== PLP_MAJOR) return null;
  return Math.min(Number(m[2]), PLP_MINOR);
}

export function newNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** What a client computes; exported for the test client and the TS relay. */
export function authMac(plpKey: string, nonce: string, board: string, handle: string): string {
  return crypto.createHmac('sha256', plpKey).update(nonce + board + handle).digest('hex');
}

export type AuthResult =
  | { ok: true; boardId: string; boardName: string }
  | { ok: false; reason: PlpRefusal };

/**
 * One SELECT, one HMAC. Unknown board, missing plp_key, bad handle and bad MAC
 * all answer `unauthenticated` alike, as /chat/v1's 401 does. A suspended
 * board is told so (403 board_suspended there).
 */
export function verifyAuth(db: Database.Database, hello: PlpHello, nonce: string, mac: Buffer): AuthResult {
  if (hello.board === '') {
    // shortcut: the password travels as sent, so it is only private on a TLS listener; move to a challenge (SRP) if plain PLP stays in use.
    try {
      loginAccount(db, hello.handle, mac.toString('utf8'));
      return { ok: true, boardId: '', boardName: '' };
    } catch (err) {
      if (err instanceof SurfaceError && err.status === 429) throw err;
      return { ok: false, reason: 'unauthenticated' };
    }
  }
  if (!BOARD_ID.test(hello.board) || !validHandle(hello.handle)) return { ok: false, reason: 'unauthenticated' };
  const row = db.prepare('SELECT id, name, suspended_at, plp_key FROM boards WHERE id = ?').get(hello.board) as
    | { id: string; name: string; suspended_at: number | null; plp_key: string | null }
    | undefined;
  if (!row || !row.plp_key) return { ok: false, reason: 'unauthenticated' };
  const expected = Buffer.from(authMac(row.plp_key, nonce, hello.board, hello.handle), 'latin1');
  const given = Buffer.from(mac.toString('latin1').trim().toLowerCase(), 'latin1');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'unauthenticated' };
  if (row.suspended_at !== null) return { ok: false, reason: 'board_suspended' };
  return { ok: true, boardId: row.id, boardName: row.name };
}
