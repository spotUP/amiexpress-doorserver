/**
 * Boards: the only identity that may report an event.
 *
 * A board key is `Board <id>.<secret>` (D1). The id rides in the key because
 * verifyPassword (src/auth.ts) is a deliberate ~50 ms scrypt: with an opaque
 * key the server would have to hash the presented secret against every board
 * row on every request - O(boards) x 50 ms on the hottest write path in the
 * system. Naming the row makes it exactly one lookup and exactly one hash.
 * The board id is not a secret; it is already the prefix of every `ref` the
 * board sends.
 *
 * Even one hash per POST /events is 5 s of CPU per hundred flushes, so a
 * verified key is remembered for five minutes (D2). The row is STILL read on
 * every request - the cache saves the scrypt, never the SELECT - and the
 * entry is honoured only while that row's key hash is unchanged. A rotation
 * therefore bites on the very next request with nothing to flush and no
 * window to wait out.
 */
import * as crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { NextFunction, Request, Response } from 'express';
import { hashPassword, verifyPassword } from '../auth';
import { withAchievementsDb } from './db';
import { SurfaceError } from './errors';
import type { AchievementsConfig } from './config';

/** The same slug shape the ref prefix and the URL segment use. */
export const BOARD_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** 24 random bytes, base64url: no '.', so the key splits at its first one. */
const SECRET_BYTES = 24;

/** How long a verified key is trusted without a second scrypt (D2). */
const KEY_CACHE_TTL_MS = 5 * 60 * 1000;

export interface BoardRow {
  id: string;
  name: string;
  contact: string | null;
  key_hash: string;
  created_at: number;
  suspended_at: number | null;
  /** 1 = a relay board: its chat session may speak `as` its own users (Discord bridge). Admin-set. */
  chat_relay: number;
  /** 1 = the board's sysop opted its callers into the Discord mirror. */
  discord_mirror: number;
}

/** The board a request proved it is, attached by requireBoard. */
export interface BoardRequest extends Request {
  board?: { id: string; name: string; suspended: boolean };
}

function newSecret(): string {
  return crypto.randomBytes(SECRET_BYTES).toString('base64url');
}

function requireBoardId(id: string): void {
  if (!BOARD_ID.test(id)) {
    throw new SurfaceError(
      'bad_request',
      400,
      `board id "${id}" is not a lowercase slug of 2 to 32 characters`
    );
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mint a board. Returns the ONE-TIME plaintext key: only the scrypt hash of
 * its secret half is stored, so a leaked database yields no usable key.
 */
export function createBoard(
  db: Database.Database,
  id: string,
  name: string,
  contact: string | null
): { id: string; key: string } {
  requireBoardId(id);
  if (db.prepare('SELECT id FROM boards WHERE id = ?').get(id)) {
    // Checked before the hash, not after: a duplicate must not cost 50 ms,
    // and the stored hash of the EXISTING board is never touched.
    throw new SurfaceError('board_exists', 409, `board "${id}" already exists`);
  }
  const secret = newSecret();
  db.prepare(
    'INSERT INTO boards (id, name, contact, key_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, name, contact, hashPassword(secret), nowSeconds());
  return { id, key: `${id}.${secret}` };
}

/** Printable ASCII only: the name is shown in every chat log via board_joined. */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const NAME_MAX = 40;
const CONTACT_MAX = 80;
const SLUG_MAX = 32;
const SUFFIX_MAX = 99;

export interface BoardRegistration {
  name: string;
  sysop: string;
  /** What lands in boards.contact: "<sysop>" or "<sysop> <contact>". */
  contact: string;
}

function badRegistration(detail: string): SurfaceError {
  return new SurfaceError('bad_request', 400, detail);
}

/**
 * Validate a self-service registration body. Pure. name and sysop are 1-40
 * printable ASCII characters (no control characters, no high bytes), contact
 * is optional and at most 80 printable ASCII characters.
 */
export function validateRegistration(body: unknown): BoardRegistration {
  const b = (body ?? {}) as { name?: unknown; sysop?: unknown; contact?: unknown };
  const field = (label: string, v: unknown, max: number, required: boolean): string => {
    if (v === undefined || v === null || v === '') {
      if (required) throw badRegistration(`${label} is required`);
      return '';
    }
    if (typeof v !== 'string') throw badRegistration(`${label} must be a string`);
    const t = v.trim();
    if (t.length === 0 && required) throw badRegistration(`${label} is required`);
    if (t.length > max) throw badRegistration(`${label} is at most ${max} characters`);
    if (t.length > 0 && !PRINTABLE_ASCII.test(t)) {
      throw badRegistration(`${label} must be printable ASCII (no control characters)`);
    }
    return t;
  };
  const name = field('name', b.name, NAME_MAX, true);
  const sysop = field('sysop', b.sysop, NAME_MAX, true);
  const contact = field('contact', b.contact, CONTACT_MAX, false);
  return { name, sysop, contact: contact ? `${sysop} ${contact}` : sysop };
}

/** Lowercase, non [a-z0-9] -> '-', collapsed and trimmed, max 32; under 2 chars -> 'board'. */
export function deriveBoardSlug(name: string, maxLen: number = SLUG_MAX): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
  return slug.length < 2 ? 'board' : slug;
}

/** The base slug, then base-2 .. base-99, each kept within 32 characters. */
export function slugCandidates(name: string): string[] {
  const base = deriveBoardSlug(name);
  const out = [base];
  for (let n = 2; n <= SUFFIX_MAX; n += 1) {
    const suffix = `-${n}`;
    out.push(base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '') + suffix);
  }
  return out;
}

/** Mint a board for a validated registration, retrying the slug on collision. */
export function registerBoard(
  db: Database.Database,
  reg: BoardRegistration
): { id: string; key: string } {
  for (const id of slugCandidates(reg.name)) {
    try {
      const minted = createBoard(db, id, reg.name, reg.contact);
      auditBoard(db, minted.id, 'board:register', 1);
      return minted;
    } catch (e) {
      if (e instanceof SurfaceError && e.code === 'board_exists') continue;
      throw e;
    }
  }
  throw new SurfaceError('board_exists', 409, 'no free board id for that name');
}

/** A fresh secret for an existing board. The old key stops on the next request. */
export function rotateBoardKey(db: Database.Database, id: string): { id: string; key: string } {
  const secret = newSecret();
  const res = db.prepare('UPDATE boards SET key_hash = ? WHERE id = ?').run(hashPassword(secret), id);
  if (res.changes === 0) {
    throw new SurfaceError('bad_request', 400, `board "${id}" does not exist`);
  }
  return { id, key: `${id}.${secret}` };
}

export function setBoardSuspended(db: Database.Database, id: string, suspended: boolean): void {
  const res = db
    .prepare('UPDATE boards SET suspended_at = ? WHERE id = ?')
    .run(suspended ? nowSeconds() : null, id);
  if (res.changes === 0) {
    throw new SurfaceError('bad_request', 400, `board "${id}" does not exist`);
  }
}

export function setBoardRelay(db: Database.Database, id: string, relay: boolean): void {
  const res = db.prepare('UPDATE boards SET chat_relay = ? WHERE id = ?').run(relay ? 1 : 0, id);
  if (res.changes === 0) {
    throw new SurfaceError('bad_request', 400, `board "${id}" does not exist`);
  }
}

export function getBoard(db: Database.Database, id: string): BoardRow | null {
  const row = db
    .prepare('SELECT id, name, contact, key_hash, created_at, suspended_at, chat_relay, discord_mirror FROM boards WHERE id = ?')
    .get(id) as BoardRow | undefined;
  return row ?? null;
}

export function listBoards(db: Database.Database): BoardRow[] {
  return db
    .prepare(
      'SELECT id, name, contact, key_hash, created_at, suspended_at, chat_relay, discord_mirror FROM boards ORDER BY id'
    )
    .all() as BoardRow[];
}

/**
 * `<board-id> <action> <count>` on every accepted write (spec, Component 1).
 * One row per request, not one per event: the count is what makes a runaway
 * board visible without a row per message it ever reported.
 */
export function auditBoard(
  db: Database.Database,
  boardId: string | null,
  action: string,
  count: number,
  now: number = nowSeconds()
): void {
  db.prepare('INSERT INTO board_audit (board_id, action, count, at) VALUES (?, ?, ?, ?)').run(
    boardId,
    action,
    count,
    now
  );
}

interface VerifiedKey {
  boardId: string;
  /** The row's hash AT THE MOMENT of verification; a rotation changes it. */
  keyHash: string;
  verifiedAt: number;
}

/** sha256(presented key) -> what verifying it proved. Never the key itself. */
const verifiedKeys = new Map<string, VerifiedKey>();

/** How many scrypt verifications this process has run for board keys. */
let verifyCount = 0;

/** The cache is process-local state; a suite that counts hashes clears it. */
export function _clearBoardKeyCacheForTests(): void {
  verifiedKeys.clear();
  verifyCount = 0;
}

/** The instrument AC-20's R4 row reads: 0 more hashes means the cache held. */
export function _boardKeyVerifyCountForTests(): number {
  return verifyCount;
}

export interface PresentedKey {
  boardId: string;
  secret: string;
  fingerprint: string;
}

/**
 * `Authorization: Board <id>.<secret>`, or null for anything else. The split
 * is at the FIRST '.', which is unambiguous: a board id cannot contain one
 * and base64url never produces one.
 */
export function parseBoardKey(header: string | undefined): PresentedKey | null {
  if (!header) return null;
  const space = header.indexOf(' ');
  if (space <= 0) return null;
  if (header.slice(0, space).toLowerCase() !== 'board') return null;
  const key = header.slice(space + 1).trim();
  const dot = key.indexOf('.');
  if (dot <= 0 || dot === key.length - 1) return null;
  const boardId = key.slice(0, dot);
  if (!BOARD_ID.test(boardId)) return null;
  return {
    boardId,
    secret: key.slice(dot + 1),
    fingerprint: crypto.createHash('sha256').update(key).digest('hex'),
  };
}

/** GET and HEAD read; everything else is a write a suspension must stop. */
function isRead(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/**
 * Gate for every board-facing route under /achievements/v1.
 *
 * 401 for a missing, malformed or wrong key, and the three cases are
 * deliberately indistinguishable: the refusal never says which half of
 * `<id>.<secret>` was wrong, and never echoes either half.
 *
 * 403 for a suspended board's WRITES. Its reads still work: suspension is
 * how a sysop stops a board reporting, not how a door's catalog display is
 * broken for its callers, and everything a read returns is data that board
 * could already see.
 */
export function requireBoard(ach: AchievementsConfig) {
  return (req: BoardRequest, res: Response, next: NextFunction): void => {
    const presented = parseBoardKey(req.get('authorization') ?? undefined);
    if (!presented) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const row = withAchievementsDb(ach, (db) => getBoard(db, presented.boardId), {
      readonly: true,
    });
    if (!row) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    const cached = verifiedKeys.get(presented.fingerprint);
    const cacheHolds =
      cached !== undefined &&
      cached.boardId === row.id &&
      cached.keyHash === row.key_hash &&
      Date.now() - cached.verifiedAt < KEY_CACHE_TTL_MS;

    if (!cacheHolds) {
      verifyCount += 1;
      if (!verifyPassword(presented.secret, row.key_hash)) {
        verifiedKeys.delete(presented.fingerprint);
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      verifiedKeys.set(presented.fingerprint, {
        boardId: row.id,
        keyHash: row.key_hash,
        verifiedAt: Date.now(),
      });
    }

    const suspended = row.suspended_at !== null;
    if (suspended && !isRead(req.method)) {
      res.status(403).json({ error: 'board_suspended' });
      return;
    }

    req.board = { id: row.id, name: row.name, suspended };
    next();
  };
}
