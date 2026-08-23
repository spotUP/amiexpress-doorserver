/**
 * The admin API: everything that can CHANGE the catalog.
 *
 * Mounted under /api/door-repo/admin. Every route except /login is behind
 * requireAdmin (src/auth.ts), which answers 503 when the server has no
 * signing secret configured - a door server without DOORSERVER_JWT_SECRET
 * serves the public API exactly as before and has no admin surface at all.
 */
import express, { type Response, type Router } from 'express';
import { openDb } from './db';
import {
  bearerToken,
  findAdmin,
  recordAudit,
  requireAdmin,
  signToken,
  verifyPassword,
  verifyToken,
  type AuthedRequest,
} from './auth';
import type { ServerConfig } from './config';

/**
 * A failed login costs a scrypt hash (~50 ms), which already makes online
 * guessing slow. This adds a per-username lockout on top: five failures
 * inside five minutes and that account stops answering for five minutes,
 * whoever is asking. It is per-account rather than per-IP because the
 * account is what is being attacked, and an attacker picks their own IP.
 */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const failures = new Map<string, { count: number; first: number }>();

function isLockedOut(username: string, now: number): boolean {
  const entry = failures.get(username);
  if (!entry) return false;
  if (now - entry.first > LOCKOUT_MS) {
    failures.delete(username);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function noteFailure(username: string, now: number): void {
  const entry = failures.get(username);
  if (!entry || now - entry.first > LOCKOUT_MS) {
    failures.set(username, { count: 1, first: now });
    return;
  }
  entry.count += 1;
}

/** Exported for tests: forget every recorded failure. */
export function _clearLoginFailuresForTests(): void {
  failures.clear();
}

export function createAdminRouter(cfg: ServerConfig): Router {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  router.post('/login', (req: AuthedRequest, res: Response) => {
    if (!cfg.jwtSecret) {
      res.status(503).json({ error: 'admin API disabled: DOORSERVER_JWT_SECRET is not set' });
      return;
    }
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }

    const now = Date.now();
    if (isLockedOut(username, now)) {
      res.status(429).json({ error: 'too many failed attempts; try again in a few minutes' });
      return;
    }

    const db = openDb(cfg);
    try {
      const admin = findAdmin(db, username);
      // Same answer for "no such account" and "wrong password": which of the
      // two it was is not the client's business.
      if (!admin || !verifyPassword(password, admin.password_hash)) {
        noteFailure(username, now);
        res.status(401).json({ error: 'invalid credentials' });
        return;
      }
      failures.delete(username);
      db.prepare('UPDATE admin_users SET last_login_at = strftime(\'%s\',\'now\') WHERE id = ?').run(admin.id);
      recordAudit(db, admin.id, 'login', admin.username);
      const user = { id: admin.id, username: admin.username, role: admin.role };
      res.json({ token: signToken(user, cfg.jwtSecret as string), user });
    } finally {
      db.close();
    }
  });

  router.get('/me', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const token = bearerToken(req);
    const payload = token && cfg.jwtSecret ? verifyToken(token, cfg.jwtSecret) : null;
    res.json({ user: req.admin, expiresAt: payload ? payload.exp : null });
  });

  return router;
}
