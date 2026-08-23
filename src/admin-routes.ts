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
import { analyseDoor, buildGroupTags } from './describe';
import { OVERRIDABLE_FIELDS, isOverridableField, loadOverrides } from './effective';
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

  /**
   * One door, with the SCANNED value and the edited value of every
   * overridable field side by side. This is the one place allowed to read
   * door_catalog raw: the admin needs to see what they changed it FROM.
   */
  router.get('/doors/:archiveName', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db
        .prepare('SELECT * FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such door' });
        return;
      }
      const overrides = loadOverrides(db);
      const edits = overrides.get(row.id as string) ?? {};
      const groupTags = buildGroupTags(
        (db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[]).map(
          (r) => r.archive_name
        )
      );
      const derived = analyseDoor(
        {
          dizText: (row.file_id_diz as string | null) ?? null,
          name: (row.name as string) ?? '',
          archiveName: row.archive_name as string,
          binaryName: (row.binary_name as string | null) ?? null,
          catalogVersion: (row.version as string | null) ?? null,
          catalogAuthor: (row.author as string | null) ?? null,
        },
        groupTags
      );
      res.json({
        id: row.id,
        archiveName: row.archive_name,
        fileIdDiz: row.file_id_diz,
        doc: row.doc_raw,
        docFilename: row.doc_filename,
        /**
         * For each field: what the scan holds, what the classifier reads out
         * of the DIZ (where it has an opinion), and what a human has written.
         */
        fields: Object.fromEntries(
          OVERRIDABLE_FIELDS.map((field) => [
            field,
            {
              scanned: row[field] ?? null,
              derived:
                field === 'description'
                  ? derived.description
                  : field === 'version'
                    ? derived.version || null
                    : field === 'author'
                      ? derived.author || null
                      : field === 'requires_bbs'
                        ? derived.requiresBbs || null
                        : null,
              edited: field in edits ? edits[field] ?? null : undefined,
              isEdited: field in edits,
            },
          ])
        ),
      });
    } finally {
      db.close();
    }
  });

  /**
   * Write one or more corrections. The body is `{ field: value }`; a null
   * value blanks the field (a decision, kept), and a field not named is left
   * as it was. Field names are checked against the allowlist in
   * effective.ts - they arrive from a request body and would otherwise be a
   * column name from a stranger.
   */
  router.patch('/doors/:archiveName', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const entries = Object.entries(body);
    if (entries.length === 0) {
      res.status(400).json({ error: 'no fields given' });
      return;
    }
    const unknown = entries.filter(([field]) => !isOverridableField(field)).map(([field]) => field);
    if (unknown.length) {
      res.status(400).json({ error: `not an editable field: ${unknown.join(', ')}` });
      return;
    }
    const badType = entries.filter(([, value]) => value !== null && typeof value !== 'string');
    if (badType.length) {
      res.status(400).json({ error: 'every value must be a string or null' });
      return;
    }

    const db = openDb(cfg);
    try {
      const row = db
        .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such door' });
        return;
      }
      const before = loadOverrides(db).get(row.id) ?? {};
      const write = db.transaction(() => {
        for (const [field, value] of entries) {
          db.prepare(
            `INSERT INTO door_catalog_overrides (catalog_id, field, value, edited_by, edited_at)
             VALUES (?, ?, ?, ?, strftime('%s','now'))
             ON CONFLICT(catalog_id, field) DO UPDATE SET
               value = excluded.value, edited_by = excluded.edited_by, edited_at = excluded.edited_at`
          ).run(row.id, field, value as string | null, req.admin?.id ?? null);
          recordAudit(db, req.admin?.id ?? null, 'edit', row.id, {
            field,
            from: field in before ? before[field as never] : undefined,
            to: value,
          });
        }
      });
      write();
      res.json({ ok: true, archiveName, fields: Object.keys(body) });
    } finally {
      db.close();
    }
  });

  /** Drop one correction: the field goes back to whatever the scan says. */
  router.delete('/doors/:archiveName/overrides/:field', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const field = Array.isArray(req.params.field) ? '' : req.params.field;
    if (!isOverridableField(field)) {
      res.status(400).json({ error: `not an editable field: ${field}` });
      return;
    }
    const db = openDb(cfg);
    try {
      const row = db
        .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such door' });
        return;
      }
      const result = db
        .prepare('DELETE FROM door_catalog_overrides WHERE catalog_id = ? AND field = ?')
        .run(row.id, field);
      if (result.changes > 0) {
        recordAudit(db, req.admin?.id ?? null, 'revert', row.id, { field });
      }
      res.json({ ok: true, reverted: result.changes > 0 });
    } finally {
      db.close();
    }
  });

  /**
   * What the classifier WOULD say for this door, without writing anything -
   * the preview behind "re-read from the DIZ" in the UI.
   */
  router.post('/doors/:archiveName/redescribe', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db
        .prepare('SELECT * FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such door' });
        return;
      }
      const groupTags = buildGroupTags(
        (db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[]).map(
          (r) => r.archive_name
        )
      );
      const facts = analyseDoor(
        {
          dizText: (row.file_id_diz as string | null) ?? null,
          name: (row.name as string) ?? '',
          archiveName: row.archive_name as string,
          binaryName: (row.binary_name as string | null) ?? null,
          catalogVersion: (row.version as string | null) ?? null,
          catalogAuthor: (row.author as string | null) ?? null,
        },
        groupTags
      );
      res.json(facts);
    } finally {
      db.close();
    }
  });

  /** Who changed what, newest first. */
  router.get('/audit', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;
    const db = openDb(cfg, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT a.id, a.action, a.target, a.detail, a.at, u.username
             FROM admin_audit a LEFT JOIN admin_users u ON u.id = a.admin_id
            ORDER BY a.at DESC, a.id DESC LIMIT ?`
        )
        .all(limit) as { id: number; action: string; target: string; detail: string | null; at: number; username: string | null }[];
      res.json({
        rows: rows.map((r) => ({
          id: r.id,
          action: r.action,
          target: r.target,
          detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
          at: r.at,
          by: r.username,
        })),
      });
    } finally {
      db.close();
    }
  });

  return router;
}
