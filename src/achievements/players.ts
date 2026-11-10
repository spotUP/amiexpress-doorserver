/**
 * Players: register, verify, resend.
 *
 * The identity is `email_key = lower(trim(email))`, and it is the ONLY thing
 * that identifies a player across boards. The address itself is stored once
 * more, as given, purely so a mail envelope can be addressed - and it never
 * leaves this server: no response from this surface contains an email
 * address, on any route, and a test asserts that over every body the suite
 * produces.
 *
 * CODES. Six characters from a 31-symbol alphabet with 0, O, 1, I and L
 * left out, because a code is read off a screen and typed on a real Amiga
 * keyboard. 31^6 is 8.9e8, which is only safe with an attempt cap, so five
 * wrong tries burn the code. They are stored as hashPassword() and checked
 * with verifyPassword() (src/auth.ts) - the SAME scrypt the board keys use,
 * not a second KDF - and the lookup is by email, so there is never more than
 * one hash to compute per attempt. That ~50 ms is also the guessing limiter
 * of last resort, underneath AC-17's real one.
 *
 * WHAT IS NOT HERE. Nothing sends mail. registerPlayer() and resendCode()
 * return the code they issued and the address to send it to; the route
 * queues it and the drain posts it (mail.ts). A code that could only be
 * delivered by an SMTP handshake on the request path would be lost every
 * time the mail server hiccuped.
 */
import * as crypto from 'crypto';
import type Database from 'better-sqlite3';
import { hashPassword, verifyPassword } from '../auth';
import { SurfaceError } from './errors';
import { rarityOf } from './rarity';
import type { PlayerProfile, Tier, UnlockOut } from '../../contract/achievement-types';

/**
 * 31 symbols: no 0/O, no 1/I/L. The exclusions are not stylistic - the code
 * is transcribed from a screen by a human at a terminal.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/** How long a verification code lives, and how long a link code lives. */
export const VERIFY_CODE_TTL_SECONDS = 30 * 60;
export const LINK_CODE_TTL_SECONDS = 15 * 60;

/** Wrong tries before the code is dead. 31^6 is only safe with a cap. */
export const MAX_CODE_ATTEMPTS = 5;

/** 3 to 16 characters, starting with a letter or a digit. */
export const HANDLE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{2,15}$/;

/** RFC 5321's limit. Anything longer is not an address, it is a payload. */
export const MAX_EMAIL_LENGTH = 254;

export type CodeKind = 'verify' | 'link';

export interface PlayerRow {
  id: number;
  email_key: string;
  email: string;
  handle: string;
  verified_at: number | null;
  private: number;
}

/** A code, and the address it has to reach. The caller queues the mail. */
export interface IssuedCode {
  code: string;
  to: string;
  expiresAt: number;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * randomInt, not randomBytes % 31: 256 is not a multiple of 31, so the
 * modulo would make the first eight symbols of the alphabet slightly more
 * likely than the rest. crypto.randomInt rejects and re-draws instead.
 */
export function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

/** The identity. Everything else about a player hangs off this string. */
export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Shallow on purpose. One `@`, a dot in the domain, and a length limit; the
 * emailed code is the real proof that an address exists and can be read, and
 * deep validation is the mail server's job. A stricter regex here would
 * reject valid addresses nobody could then argue with.
 */
export function isEmail(email: string): boolean {
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return false;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false;
  const domain = trimmed.slice(at + 1);
  const dot = domain.indexOf('.');
  if (dot <= 0 || dot === domain.length - 1) return false;
  return !/\s/.test(trimmed);
}

function requireEmail(email: string): string {
  if (!isEmail(email)) {
    throw new SurfaceError('bad_email', 400, 'that is not an email address this server can use');
  }
  return emailKey(email);
}

function requireHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!HANDLE.test(trimmed)) {
    throw new SurfaceError(
      'bad_handle',
      400,
      'a handle is 3 to 16 characters, starting with a letter or a digit'
    );
  }
  return trimmed;
}

export function findPlayerByEmail(db: Database.Database, email: string): PlayerRow | null {
  const row = db
    .prepare(
      'SELECT id, email_key, email, handle, verified_at, private FROM players WHERE email_key = ?'
    )
    .get(emailKey(email)) as PlayerRow | undefined;
  return row ?? null;
}

/** COLLATE NOCASE, matching the unique index the schema puts on handle. */
export function handleOwner(db: Database.Database, handle: string): number | null {
  const row = db
    .prepare('SELECT id FROM players WHERE handle = ? COLLATE NOCASE')
    .get(handle) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Put a fresh code in place, replacing whatever was there.
 *
 * The PRIMARY KEY is (player_id, kind), so there is at most ONE live code of
 * each kind per player and a REPLACE is the whole of "resend" and the whole
 * of "rotate" - two names for one operation. Replacing also resets
 * `attempts`, which is what stops a burned code from making the address
 * permanently unusable: the way out of five wrong guesses is a new code.
 */
export function issueCode(
  db: Database.Database,
  playerId: number,
  kind: CodeKind,
  now: number = nowSeconds()
): { code: string; expiresAt: number } {
  const code = newCode();
  const ttl = kind === 'verify' ? VERIFY_CODE_TTL_SECONDS : LINK_CODE_TTL_SECONDS;
  const expiresAt = now + ttl;
  db.prepare(
    `INSERT INTO player_codes (player_id, kind, code_hash, expires_at, attempts, used_at, created_at)
     VALUES (?, ?, ?, ?, 0, NULL, ?)
     ON CONFLICT(player_id, kind) DO UPDATE SET
       code_hash = excluded.code_hash,
       expires_at = excluded.expires_at,
       attempts = 0,
       used_at = NULL,
       created_at = excluded.created_at`
  ).run(playerId, kind, hashPassword(code), expiresAt, now);
  return { code, expiresAt };
}

/**
 * Register, or re-register.
 *
 * A second registration of an existing email creates NO second player: it
 * queues a fresh code to the same address and changes nothing else. In
 * particular it cannot RENAME the player - a different handle is accepted
 * and ignored, because anyone who knows the address could otherwise rename
 * someone. A verified player renames through PATCH /players/<email> from a
 * board they have linked.
 *
 * The handle-uniqueness check therefore runs only when a player is about to
 * be CREATED. For an existing address the handle is validated for shape and
 * then dropped, so re-registering with a handle somebody else holds is a
 * 202 like any other re-registration rather than a 409 about a name the
 * caller was never going to get.
 */
export function registerPlayer(
  db: Database.Database,
  email: string,
  handle: string,
  now: number = nowSeconds()
): IssuedCode {
  const key = requireEmail(email);
  const wanted = requireHandle(handle);

  const existing = findPlayerByEmail(db, key);
  if (existing) {
    const { code, expiresAt } = issueCode(db, existing.id, 'verify', now);
    return { code, to: existing.email, expiresAt };
  }

  if (handleOwner(db, wanted) !== null) {
    throw new SurfaceError('handle_taken', 409, 'that handle belongs to another player');
  }

  const info = db
    .prepare('INSERT INTO players (email_key, email, handle, created_at) VALUES (?, ?, ?, ?)')
    .run(key, email.trim(), wanted, now);
  const { code, expiresAt } = issueCode(db, Number(info.lastInsertRowid), 'verify', now);
  return { code, to: email.trim(), expiresAt };
}

/**
 * A fresh verification code for an address that already has a player, or
 * null when it does not.
 *
 * null is NOT an error: the route answers 202 either way, so the endpoint is
 * not a register of who has signed up. Only the caller who owns the mailbox
 * learns anything.
 */
export function resendCode(
  db: Database.Database,
  email: string,
  now: number = nowSeconds()
): IssuedCode | null {
  if (!isEmail(email)) {
    throw new SurfaceError('bad_email', 400, 'that is not an email address this server can use');
  }
  const player = findPlayerByEmail(db, email);
  if (!player) return null;
  const { code, expiresAt } = issueCode(db, player.id, 'verify', now);
  return { code, to: player.email, expiresAt };
}

interface CodeRow {
  code_hash: string;
  expires_at: number;
  attempts: number;
  used_at: number | null;
}

/**
 * Spend a code, or refuse it.
 *
 * An UNKNOWN email answers `bad_code`, exactly as a wrong code does: this
 * endpoint must not become a register of who has signed up. The three
 * refusals a caller CAN tell apart all require them to have had a real code
 * in the first place - it expired, or they burned it.
 *
 * The attempt counter is written before the throw. A refusal that forgot to
 * record itself would leave the cap at five for ever.
 */
export interface SpendOptions {
  /**
   * Accept a code past its expiry. Only POST /links/rotate wants this: the
   * expired code is the player's proof of identity there, and refusing it
   * would leave a player who was slow reaching the next board with no way
   * to get a code at all. Burned and spent codes are still refused.
   */
  allowExpired?: boolean;
}

export function spendCode(
  db: Database.Database,
  player: PlayerRow | null,
  kind: CodeKind,
  code: string,
  now: number = nowSeconds(),
  opts: SpendOptions = {}
): PlayerRow {
  const badCode = (): SurfaceError =>
    new SurfaceError('bad_code', 400, 'that code is not the one this address is waiting for');
  const burned = (): SurfaceError =>
    new SurfaceError('code_burned', 400, 'that code was refused five times; ask for a new one');

  if (!player) throw badCode();
  const row = db
    .prepare(
      'SELECT code_hash, expires_at, attempts, used_at FROM player_codes WHERE player_id = ? AND kind = ?'
    )
    .get(player.id, kind) as CodeRow | undefined;
  // Single use. A code that has been spent is indistinguishable from one
  // that was never issued, which is the same answer an unknown email gets.
  if (!row || row.used_at !== null) throw badCode();

  // Burned before expired: five wrong guesses is the terminal state, and a
  // caller who has burned a code needs a NEW one whether or not the old one
  // would still have been in date.
  if (row.attempts >= MAX_CODE_ATTEMPTS) throw burned();
  if (row.expires_at <= now && !opts.allowExpired) {
    throw new SurfaceError('code_expired', 400, 'that code has expired; ask for a new one');
  }

  if (!verifyPassword(code.trim().toUpperCase(), row.code_hash)) {
    const attempts = row.attempts + 1;
    db.prepare('UPDATE player_codes SET attempts = ? WHERE player_id = ? AND kind = ?').run(
      attempts,
      player.id,
      kind
    );
    throw attempts >= MAX_CODE_ATTEMPTS ? burned() : badCode();
  }

  db.prepare('UPDATE player_codes SET used_at = ? WHERE player_id = ? AND kind = ?').run(
    now,
    player.id,
    kind
  );
  return player;
}

interface UnlockRow {
  id: string;
  name: string;
  tier: Tier;
  points: number;
  hidden: number;
  rarity_tenths: number | null;
  at: number;
}

/**
 * The profile every player-facing response returns. Identified by HANDLE:
 * there is no email field on it, at any depth.
 *
 * `progress` is empty until the rule engine exists (AC-10 computes have/need
 * from the same counters it evaluates rules against). It is present and
 * typed rather than omitted, because SP2 and SP4 compile against the frozen
 * contract and a field that appears later is a field they cannot rely on.
 */
export function playerProfile(db: Database.Database, player: PlayerRow): PlayerProfile {
  const points = (
    db
      .prepare(
        `SELECT COALESCE(SUM(a.points), 0) AS n
           FROM unlocks u JOIN achievements a ON a.id = u.achievement_id
          WHERE u.player_id = ?`
      )
      .get(player.id) as { n: number }
  ).n;

  const linkedBoards = (
    db.prepare('SELECT board_id FROM links WHERE player_id = ? ORDER BY board_id').all(player.id) as {
      board_id: string;
    }[]
  ).map((r) => r.board_id);

  const unlocks: UnlockOut[] = (
    db
      .prepare(
        `SELECT a.id, a.name, a.tier, a.points, a.hidden, r.pct_tenths AS rarity_tenths, u.at
           FROM unlocks u
           JOIN achievements a ON a.id = u.achievement_id
           LEFT JOIN rarity r ON r.achievement_id = a.id
          WHERE u.player_id = ?
          ORDER BY u.at, a.id`
      )
      .all(player.id) as UnlockRow[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    tier: r.tier,
    points: r.points,
    hidden: r.hidden !== 0,
    rarityPctTenths: rarityOf(r.rarity_tenths).pctTenths,
    at: new Date(r.at * 1000).toISOString(),
  }));

  return {
    handle: player.handle,
    verified: player.verified_at !== null,
    private: player.private !== 0,
    points,
    linkedBoards,
    unlocks,
    progress: [],
  };
}

/**
 * Verify, and hand back the first link code in the same response.
 *
 * A player who has just proved they own the address is one step from being
 * useless: they are verified everywhere and linked nowhere. Issuing the link
 * code here means the door can walk them through both in one sitting,
 * without a second mail and without a second endpoint.
 */
export function verifyPlayer(
  db: Database.Database,
  email: string,
  code: string,
  now: number = nowSeconds()
): PlayerProfile {
  // spendCode refuses a null player with bad_code, so what it RETURNS is a
  // player whose code was correct - no cast, and no second lookup.
  const row = spendCode(db, findPlayerByEmail(db, email), 'verify', code, now);

  if (row.verified_at === null) {
    db.prepare('UPDATE players SET verified_at = ? WHERE id = ?').run(now, row.id);
    row.verified_at = now;
  }

  const link = issueCode(db, row.id, 'link', now);
  return {
    ...playerProfile(db, row),
    linkCode: link.code,
    linkCodeExpiresAt: new Date(link.expiresAt * 1000).toISOString(),
  };
}
