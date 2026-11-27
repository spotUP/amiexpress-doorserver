/**
 * Partyline accounts: the one identity every client logs in with.
 *
 * An account is a row of the achievements `players` table (migration 25), so
 * a caller has one id for chat and achievements. The user key on the wire is
 * the bare account handle; `handle@BOARD` is only the old per-board identity,
 * rekeyed to the account when its BBS user registers or links (claimLegacyUser).
 *
 * Invariants: a board key alone never logs into an existing account; a board
 * reaches an account only through its own (board_id, bbs_user) link, and a
 * link to an existing account is made with that account's password, once.
 */
import * as crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { Account, AccountPrefill } from '../../contract/chat-types';
import { hashPassword, verifyPassword } from '../auth';
import { SurfaceError } from '../achievements/errors';
import { queueMail } from '../achievements/mail';
import { MAX_CODE_ATTEMPTS, emailKey, isEmail, newCode } from '../achievements/players';
import { charge, chargeMail } from '../achievements/ratelimit';
import type { ChatConfig } from './config';
import { nowSec } from './config';
import { userOf, validHandle } from './sessions';
import { dmThreadId } from './store';
import { legacyRoleKey } from './roles';

export const RESET_CODE_TTL_SECONDS = 30 * 60;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

export interface AccountRow {
  id: number;
  handle: string;
  email: string;
  realname: string;
  location: string;
  bot: number;
  pw_hash: string;
  created_at: number;
}

const COLS = 'id, handle, email, realname, location, bot, pw_hash, created_at';

export function isGlobalAdmin(cfg: ChatConfig, handle: string): boolean {
  return (cfg.globalAdmins ?? []).includes(handle.toLowerCase());
}

export function toAccount(cfg: ChatConfig, r: AccountRow): Account {
  return {
    id: r.id,
    handle: r.handle,
    realname: r.realname,
    location: r.location,
    hasEmail: r.email !== '',
    bot: r.bot === 1,
    globalAdmin: isGlobalAdmin(cfg, r.handle),
    createdAt: r.created_at,
  };
}

export function accountByHandle(db: Database.Database, handle: string): AccountRow | null {
  return (db.prepare(`SELECT ${COLS} FROM players WHERE handle = ? COLLATE NOCASE`).get(handle) as AccountRow | undefined) ?? null;
}

export function accountById(db: Database.Database, id: number): AccountRow | null {
  return (db.prepare(`SELECT ${COLS} FROM players WHERE id = ?`).get(id) as AccountRow | undefined) ?? null;
}

function requirePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new SurfaceError('bad_request', 400, `password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`);
  }
  return password;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Whether a prefilled handle could be registered as it stands. */
export function handleFree(db: Database.Database, handle: unknown): boolean {
  return validHandle(handle) && accountByHandle(db, handle) === null;
}

export function cleanPrefill(v: unknown): AccountPrefill {
  const p = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: AccountPrefill = {};
  for (const k of ['handle', 'realname', 'location', 'email'] as const) {
    const s = text(p[k], 254);
    if (s) out[k] = s;
  }
  return out;
}

/** Create an account. D2: the first to register a handle keeps it (409 handle_taken). */
export function registerAccount(
  db: Database.Database,
  body: { handle?: unknown; password?: unknown; email?: unknown; realname?: unknown; location?: unknown },
  opts: { bot?: boolean } = {}
): AccountRow {
  if (!validHandle(body.handle)) {
    throw new SurfaceError('bad_request', 400, 'handle must be 1 to 32 characters with no whitespace, | or @');
  }
  const pwHash = opts.bot ? '' : hashPassword(requirePassword(body.password));
  const email = text(body.email, 254);
  if (email && !isEmail(email)) throw new SurfaceError('bad_request', 400, 'that is not an email address this server can use');
  if (accountByHandle(db, body.handle)) throw new SurfaceError('handle_taken', 409, 'that handle is taken; pick another');
  // shortcut: players.email_key is NOT NULL UNIQUE (the achievements identity), so an account
  // without email gets a random placeholder key; rebuild the table if email-less accounts ever need a real NULL.
  const key = email ? emailKey(email) : `~${crypto.randomBytes(12).toString('hex')}`;
  if (email && db.prepare('SELECT 1 FROM players WHERE email_key = ?').get(key)) {
    throw new SurfaceError('email_taken', 409, 'that email already has an account; reset its password instead');
  }
  const info = db
    .prepare('INSERT INTO players (email_key, email, handle, created_at, pw_hash, realname, location, bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(key, email, body.handle, nowSec(), pwHash, text(body.realname, 64), text(body.location, 64), opts.bot ? 1 : 0);
  return accountById(db, Number(info.lastInsertRowid)) as AccountRow;
}

/** Handle + password. Unknown handle, a bot, a password-less player and a wrong password all answer alike. */
export function loginAccount(db: Database.Database, handle: unknown, password: unknown): AccountRow {
  const key = typeof handle === 'string' ? handle.toLowerCase().slice(0, 32) : '';
  charge([{ key: `acct:login:${key}`, limit: { max: 10, windowSeconds: 300 } }]);
  const row = typeof handle === 'string' ? accountByHandle(db, handle) : null;
  if (!row || row.bot === 1 || row.pw_hash === '' || typeof password !== 'string' || !verifyPassword(password, row.pw_hash)) {
    throw new SurfaceError('unauthorized', 401, 'wrong handle or password');
  }
  return row;
}

const tokenHash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

/** D10: a token lives this long after its last use; a password change revokes them all (setPassword). */
export const TOKEN_TTL_SECONDS = 30 * 24 * 3600;
// A use within this long of the last renewal does not write again (a polling client would write per request).
const TOKEN_RENEW_GRANULARITY_SECONDS = 60;

export function issueToken(db: Database.Database, accountId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = nowSec();
  db.prepare('DELETE FROM account_tokens WHERE account_id = ? AND expires_at <= ?').run(accountId, now);
  db.prepare('INSERT INTO account_tokens (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), accountId, now, now + TOKEN_TTL_SECONDS);
  return token;
}

/** The one token check: an unknown or expired token is null; a good one is renewed to now + TTL. */
export function accountByToken(db: Database.Database, token: string): AccountRow | null {
  const now = nowSec();
  const h = tokenHash(token);
  const t = db.prepare('SELECT account_id, expires_at FROM account_tokens WHERE token_hash = ?').get(h) as { account_id: number; expires_at: number } | undefined;
  if (!t || t.expires_at <= now) return null;
  if (t.expires_at < now + TOKEN_TTL_SECONDS - TOKEN_RENEW_GRANULARITY_SECONDS) {
    db.prepare('UPDATE account_tokens SET expires_at = ? WHERE token_hash = ?').run(now + TOKEN_TTL_SECONDS, h);
  }
  return accountById(db, t.account_id);
}

/** Store a new password and end every token and reset code of the account. */
export function setPassword(db: Database.Database, accountId: number, password: unknown): void {
  const hash = hashPassword(requirePassword(password));
  if (db.prepare('UPDATE players SET pw_hash = ? WHERE id = ? AND bot = 0').run(hash, accountId).changes !== 1) {
    throw new SurfaceError('not_found', 404, 'no such account');
  }
  db.prepare('DELETE FROM account_tokens WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM account_reset_codes WHERE account_id = ?').run(accountId);
}

/** Mail a reset code when the address has an account; the caller answers 204 either way. */
export function requestPasswordReset(db: Database.Database, email: unknown): void {
  if (typeof email !== 'string' || !isEmail(email)) return;
  const row = db.prepare('SELECT id, email FROM players WHERE email_key = ? AND bot = 0').get(emailKey(email)) as { id: number; email: string } | undefined;
  if (!row) return;
  chargeMail(row.email);
  const code = newCode();
  db.prepare(
    `INSERT INTO account_reset_codes (account_id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
     ON CONFLICT(account_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`
  ).run(row.id, hashPassword(code), nowSec() + RESET_CODE_TTL_SECONDS);
  queueMail(
    db,
    row.email,
    'Your Partyline password reset code',
    [
      'Someone asked to reset the password of the Partyline account with this',
      'address. The code is:',
      '',
      code,
      '',
      `It is good for ${RESET_CODE_TTL_SECONDS / 60} minutes and can be used once.`,
      'If this was not you, ignore this mail; the password stays as it is.',
      '',
    ].join('\n')
  );
}

/** Spend the mailed code and set the password. Every failure is the same 400 bad_code. */
export function confirmPasswordReset(db: Database.Database, email: unknown, code: unknown, password: unknown): void {
  const bad = new SurfaceError('bad_code', 400, 'that code is wrong or has expired; request a new one');
  requirePassword(password);
  if (typeof email !== 'string' || typeof code !== 'string') throw bad;
  const row = db
    .prepare(
      `SELECT c.account_id, c.code_hash, c.expires_at, c.attempts FROM account_reset_codes c
         JOIN players p ON p.id = c.account_id WHERE p.email_key = ?`
    )
    .get(emailKey(email)) as { account_id: number; code_hash: string; expires_at: number; attempts: number } | undefined;
  if (!row || row.expires_at < nowSec() || row.attempts >= MAX_CODE_ATTEMPTS) throw bad;
  if (!verifyPassword(code.trim().toUpperCase(), row.code_hash)) {
    // Committed by the caller before the refusal is sent (the router does not wrap this in a transaction).
    db.prepare('UPDATE account_reset_codes SET attempts = attempts + 1 WHERE account_id = ?').run(row.account_id);
    throw bad;
  }
  setPassword(db, row.account_id, password);
}

// ---- board links ----

const linkKey = (bbsUser: string): string => bbsUser.trim().toLowerCase();

export function validBbsUser(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 64;
}

export function linkedAccount(db: Database.Database, boardId: string, bbsUser: string): AccountRow | null {
  const l = db.prepare('SELECT account_id FROM account_links WHERE board_id = ? AND bbs_user = ?').get(boardId, linkKey(bbsUser)) as
    | { account_id: number }
    | undefined;
  return l ? accountById(db, l.account_id) : null;
}

/**
 * Tie (board, bbs_user) to an account and claim the BBS user's old `bbs_user@BOARD` rows.
 * The caller has already proven the account: it was just created, or its password was given.
 */
export function linkAccount(db: Database.Database, boardId: string, bbsUser: string, account: AccountRow): void {
  if (linkedAccount(db, boardId, bbsUser)) throw new SurfaceError('conflict', 409, 'this BBS user is already linked to an account');
  db.prepare('INSERT INTO account_links (board_id, bbs_user, account_id, linked_at) VALUES (?, ?, ?, ?)').run(boardId, linkKey(bbsUser), account.id, nowSec());
  // A BBS name with a space was never a chat identity, so it has no rows to claim.
  if (validHandle(bbsUser.trim())) claimLegacyUser(db, userOf(boardId, bbsUser.trim()), account.handle);
}

/**
 * The account a board runs as its bot (invariant 5). The first `bot: true` session creates it, with
 * no password and this board's link; no other board and no non-bot session reaches it.
 */
export function botAccount(db: Database.Database, boardId: string, handle: string): AccountRow {
  const linked = linkedAccount(db, boardId, handle);
  if (linked) {
    if (linked.bot !== 1) throw new SurfaceError('conflict', 409, 'that handle is linked to a person, not a bot');
    return linked;
  }
  if (validHandle(handle) && accountByHandle(db, handle)) throw new SurfaceError('conflict', 409, 'that handle belongs to another account');
  const bot = registerAccount(db, { handle }, { bot: true });
  linkAccount(db, boardId, handle, bot);
  db.prepare('INSERT OR IGNORE INTO chat_bots (user, created_at) VALUES (?, ?)').run(bot.handle, nowSec());
  return bot;
}

// ---- claim / rekey (D5) ----

/**
 * Every column that holds a user key, from the built schema (sqlite_master) and from reading
 * migrations.ts; tests/chat-accounts.test.ts fails when a new user column is not listed here.
 * `key`: the other columns of the unique key the user column is part of (a clash is deduped).
 * `ts`: the column that says which of two clashing rows is newer.
 */
export const USER_COLUMNS: readonly { table: string; col: string; key?: string[]; ts?: string }[] = [
  { table: 'chat_bans', col: 'user', key: ['room_id'], ts: 'at' },
  { table: 'chat_bans', col: 'by_user' },
  { table: 'chat_bots', col: 'user', key: [] },
  { table: 'chat_dm_members', col: 'user', key: ['thread_id'] },
  { table: 'chat_dm_messages', col: 'dm_a' },
  { table: 'chat_dm_messages', col: 'dm_b' },
  { table: 'chat_dm_messages', col: 'sender' },
  { table: 'chat_events', col: 'user' },
  { table: 'chat_events', col: 'ref' },
  { table: 'chat_events', col: 'dm_a' },
  { table: 'chat_events', col: 'dm_b' },
  { table: 'chat_files', col: 'uploader' },
  { table: 'chat_files', col: 'deleted_by' },
  { table: 'chat_ignores', col: 'owner', key: ['target'] },
  { table: 'chat_ignores', col: 'target', key: ['owner'] },
  { table: 'chat_invites', col: 'user', key: ['room_id'] },
  { table: 'chat_members', col: 'user' },
  { table: 'chat_memberships', col: 'user', key: ['room_id'], ts: 'last_active' },
  { table: 'chat_messages', col: 'user' },
  { table: 'chat_mutes', col: 'user', key: ['room_id'], ts: 'at' },
  { table: 'chat_mutes', col: 'by_user' },
  { table: 'chat_pins', col: 'pinned_by' },
  { table: 'chat_prefs', col: 'user', key: [], ts: 'updated_at' },
  { table: 'chat_presence', col: 'user', key: [], ts: 'updated_at' },
  { table: 'chat_reactions', col: 'user', key: ['message_id', 'emoji'] },
  { table: 'chat_room_ops', col: 'user', key: ['room_id'] },
  { table: 'chat_room_voices', col: 'user', key: ['room_id'] },
  { table: 'chat_rooms', col: 'owner_user' },
  { table: 'chat_sessions', col: 'user' },
  { table: 'chat_user_notes', col: 'target' },
  { table: 'chat_user_notes', col: 'author' },
  { table: 'discord_links', col: 'requested_by' },
];

/**
 * Rekey every row of the old identity (`handle@BOARD`) to the account handle. Runs inside the
 * caller's transaction. Where both identities hold a row under one unique key the newest stays
 * (`ts`), else the account's own. Returns the number of rows rekeyed.
 */
export function claimLegacyUser(db: Database.Database, oldUser: string, newUser: string): number {
  if (oldUser.toLowerCase() === newUser.toLowerCase()) return 0;
  let moved = 0;
  for (const c of USER_COLUMNS) {
    const args = { old: oldUser, new: newUser };
    if (c.key) {
      const sameKey = c.key.map((k) => `n.${k} = o.${k}`).concat('1').join(' AND ');
      const mine = `lower(n.${c.col}) = lower(@new)`;
      const theirs = `lower(o.${c.col}) = lower(@old)`;
      // The account's row loses to a newer old row; what then still clashes is the old row that lost.
      if (c.ts) db.prepare(`DELETE FROM ${c.table} AS n WHERE ${mine} AND EXISTS (SELECT 1 FROM ${c.table} o WHERE ${theirs} AND ${sameKey} AND o.${c.ts} > n.${c.ts})`).run(args);
      db.prepare(`DELETE FROM ${c.table} AS o WHERE ${theirs} AND EXISTS (SELECT 1 FROM ${c.table} n WHERE ${mine} AND ${sameKey})`).run(args);
    }
    // OR IGNORE: chat_messages and chat_dm_messages are unique on (author, client_id); a clashing row keeps its old key.
    moved += db.prepare(`UPDATE OR IGNORE ${c.table} SET ${c.col} = @new WHERE lower(${c.col}) = lower(@old)`).run(args).changes;
  }
  const at = oldUser.lastIndexOf('@');
  const oldHandle = oldUser.slice(0, at);
  const board = oldUser.slice(at + 1).toLowerCase();
  // Roles are worn per board under the session handle, which is now the account handle. Drop roles on
  // clash (sysop 2026-11-27): on the account's first arrival here through another BBS user, the plain key
  // (board, newUser) still holds the board's unrelated legacy newUser; park it under that user's own key.
  const links = db.prepare('SELECT COUNT(*) AS n FROM account_links l JOIN players p ON p.id = l.account_id WHERE l.board_id = ? AND p.handle = ? COLLATE NOCASE').get(board, newUser) as { n: number };
  if (links.n <= 1 && oldHandle.toLowerCase() !== newUser.toLowerCase()) {
    db.prepare('UPDATE OR IGNORE chat_role_assignments SET handle = @park WHERE board_id = @b AND lower(handle) = lower(@new)').run({ b: board, new: newUser, park: `${newUser}@${board.toUpperCase()}` });
  }
  const old = legacyRoleKey(db, board, oldHandle);
  // The same key on both sides (legacy bob linking account bob): the rows are already his; the dedupe below would delete them.
  if (old.toLowerCase() !== newUser.toLowerCase()) {
    db.prepare('DELETE FROM chat_role_assignments WHERE board_id = @b AND lower(handle) = lower(@old) AND role_id IN (SELECT role_id FROM chat_role_assignments WHERE lower(handle) = lower(@new))').run({ b: board, old, new: newUser });
    moved += db.prepare('UPDATE OR IGNORE chat_role_assignments SET handle = @new WHERE board_id = @b AND lower(handle) = lower(@old)').run({ b: board, old, new: newUser }).changes;
  }
  db.prepare('UPDATE chat_sessions SET handle = @new WHERE lower(user) = lower(@new) AND lower(handle) = lower(@old) AND board_id = @b').run({ b: board, old: oldHandle, new: newUser });
  rethreadDms(db, newUser);
  return moved;
}

/** A 1:1 thread id is a hash of its two user keys (dmThreadId): recompute it for the renamed user's threads. */
function rethreadDms(db: Database.Database, user: string): void {
  const pairs = db
    .prepare("SELECT DISTINCT thread_id, dm_a, dm_b FROM chat_dm_messages WHERE (lower(dm_a) = lower(@u) OR lower(dm_b) = lower(@u)) AND dm_a <> '' AND dm_b <> ''")
    .all({ u: user }) as { thread_id: string; dm_a: string; dm_b: string }[];
  for (const p of pairs) {
    const fresh = dmThreadId(p.dm_a, p.dm_b);
    if (fresh === p.thread_id) continue;
    const args = { old: p.thread_id, new: fresh };
    db.prepare('UPDATE chat_dm_messages SET thread_id = @new WHERE thread_id = @old').run(args);
    db.prepare('UPDATE OR IGNORE chat_dm_members SET thread_id = @new WHERE thread_id = @old').run(args);
    db.prepare('DELETE FROM chat_dm_members WHERE thread_id = @old').run(args);
    db.prepare('UPDATE chat_files SET dm_thread = @new WHERE dm_thread = @old').run(args);
    db.prepare('UPDATE chat_events SET label = @new WHERE label = @old').run(args);
  }
}
