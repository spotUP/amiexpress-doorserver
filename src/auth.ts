/**
 * Who is allowed to change the catalog.
 *
 * Passwords are hashed with scrypt from Node's own crypto module rather than
 * argon2: argon2 is a native addon, and this image compiles native code from
 * source against musl (see the Dockerfile's better-sqlite3 note). A second
 * compiled dependency is a second way for the live container to fail at
 * require time - and scrypt, with the parameters below, is a memory-hard KDF
 * the platform already ships and audits.
 *
 * Sessions are JWTs sent in the Authorization header, never a cookie: with
 * no cookie there is no CSRF surface, which is the same reasoning the BBS
 * uses. Tokens are signed with DOORSERVER_JWT_SECRET. If that is not set,
 * the admin API refuses every request rather than falling back to a default
 * secret - a predictable signing key is worse than no admin at all.
 */
import * as crypto from 'crypto';
import type Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { ServerConfig } from './config';
import { openDb } from './db';

/** scrypt parameters. N=2^15 costs ~50 ms and 32 MB per hash on the VPS. */
const SCRYPT_N = 32768;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
/**
 * Node caps scrypt at 32 MB by default, and N=2^15 with r=8 needs exactly
 * 128*N*r = 32 MB plus working space - so the default rejects these
 * parameters outright ("memory limit exceeded"). The cap is raised here
 * rather than the cost lowered: the memory hardness IS the defence.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const TOKEN_TTL_SECONDS = 12 * 60 * 60;

export interface AdminUser {
  id: number;
  username: string;
  role: string;
}

export interface AdminTokenPayload extends AdminUser {
  iat: number;
  exp: number;
}

/** `scrypt$<N>$<r>$<p>$<salt-hex>$<key-hex>` - parameters travel with the hash. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Constant-time verification. Reads its parameters out of the stored hash, so
 * raising the cost later does not lock anybody out.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, n, r, p, saltHex, keyHex] = parts;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(keyHex, 'hex');
    actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function signToken(user: AdminUser, secret: string): string {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, secret, {
    algorithm: 'HS256',
    expiresIn: TOKEN_TTL_SECONDS,
  });
}

/** The token's payload, or null for anything that is not a valid HS256 token. */
export function verifyToken(token: string, secret: string): AdminTokenPayload | null {
  try {
    // algorithms is pinned: without it a token could ask to be verified with
    // "none" or with an asymmetric algorithm and be accepted.
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof payload === 'string') return null;
    const { id, username, role, iat, exp } = payload as Record<string, unknown>;
    if (typeof id !== 'number' || typeof username !== 'string' || typeof role !== 'string') return null;
    if (typeof iat !== 'number' || typeof exp !== 'number') return null;
    return { id, username, role, iat, exp };
  } catch {
    return null;
  }
}

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
}

export function findAdmin(db: Database.Database, username: string): AdminRow | null {
  const row = db
    .prepare('SELECT id, username, password_hash, role FROM admin_users WHERE username = ?')
    .get(username) as AdminRow | undefined;
  return row ?? null;
}

/**
 * Turn DOORSERVER_ADMIN_KEYS into accounts on first start: the label is the
 * username, the key is the password. An account that already exists is left
 * alone, so rotating the env var never silently changes a password someone
 * has since set through the UI.
 *
 * Returns the usernames it created.
 */
export function bootstrapAdmins(db: Database.Database, cfg: ServerConfig): string[] {
  const created: string[] = [];
  for (const { label, key } of cfg.adminKeys) {
    if (findAdmin(db, label)) continue;
    db.prepare("INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, 'owner')").run(
      label,
      hashPassword(key)
    );
    created.push(label);
  }
  return created;
}

export function recordAudit(
  db: Database.Database,
  adminId: number | null,
  action: string,
  target: string,
  detail?: unknown
): void {
  db.prepare('INSERT INTO admin_audit (admin_id, action, target, detail) VALUES (?, ?, ?, ?)').run(
    adminId,
    action,
    target,
    detail === undefined ? null : JSON.stringify(detail)
  );
}

/** The authenticated admin, attached by requireAdmin. */
export interface AuthedRequest extends Request {
  admin?: AdminUser;
}

export function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

/**
 * Gate for every admin route. 503 when no signing secret is configured (the
 * admin API is switched off, and says so), 401 for a missing, malformed,
 * expired or wrongly-signed token, or one naming an account that no longer
 * exists - a deleted admin's outstanding token stops working immediately.
 */
export function requireAdmin(cfg: ServerConfig) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!cfg.jwtSecret) {
      res.status(503).json({ error: 'admin API disabled: DOORSERVER_JWT_SECRET is not set' });
      return;
    }
    const token = bearerToken(req);
    const payload = token ? verifyToken(token, cfg.jwtSecret) : null;
    if (!payload) {
      res.status(401).json({ error: 'not authenticated' });
      return;
    }
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db.prepare('SELECT id, username, role FROM admin_users WHERE id = ?').get(payload.id) as
        | AdminUser
        | undefined;
      if (!row || row.username !== payload.username) {
        res.status(401).json({ error: 'not authenticated' });
        return;
      }
      req.admin = row;
    } finally {
      db.close();
    }
    next();
  };
}
