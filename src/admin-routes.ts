/**
 * The admin API: everything that can CHANGE the catalog.
 *
 * Mounted under /api/door-repo/admin. Every route except /login is behind
 * requireAdmin (src/auth.ts), which answers 503 when the server has no
 * signing secret configured - a door server without DOORSERVER_JWT_SECRET
 * serves the public API exactly as before and has no admin surface at all.
 */
import express, { type Response, type Router } from 'express';
import * as path from 'path';
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
import { analyseDoor, buildGroupTags, fixCasing, fixTitleCasing, tidyCase } from './describe';
import { OVERRIDABLE_FIELDS, isHidden, isOverridableField, loadOverrides, type OverrideMap } from './effective';
import { UploadError, approveSubmission, rejectSubmission, deriveMetadata } from './submissions';
import type { ServerConfig } from './config';
import { analyzeArchive } from './ami-stripper';
import { stripArchiveOnServer, resolveArchivePath } from './catalog';
import { extractFile } from './archive-reader';
import { deleteMembers, findArchiverBinary } from './lha-member-delete';
import * as fs from 'fs';

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

const FIX_CASING_SENTINEL = '__FIX_CASING__';
const FIX_TITLE_CASING_SENTINEL = '__FIX_TITLE_CASING__';

/**
 * If value is a casing sentinel, resolve it by reading the current effective
 * value and applying the appropriate casing function.
 * Returns the resolved value, or the original value for non-sentinel cases.
 */
function resolveFixCasingSentinel(
  catalogId: string,
  field: string,
  value: string | null,
  overrides: OverrideMap,
): string | null {
  if (value === FIX_TITLE_CASING_SENTINEL) {
    const current = overrides.get(catalogId);
    const currentVal = current?.[field as keyof typeof current] ?? null;
    if (currentVal === null || currentVal === undefined) return value;
    return fixTitleCasing(String(currentVal));
  }
  if (value === FIX_CASING_SENTINEL) {
    const current = overrides.get(catalogId);
    const currentVal = current?.[field as keyof typeof current] ?? null;
    if (currentVal === null || currentVal === undefined) return value;
    return fixCasing(String(currentVal));
  }
  return value;
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
      // Deliberately not filtered: this is the console, and a hidden door
      // has to be visible HERE or it could never be restored.
      const hidden = isHidden(db, row.id as string);
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
        hidden,
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
      const overrides = loadOverrides(db);
      const before = overrides.get(row.id) ?? {};
      const write = db.transaction(() => {
        for (const [field, value] of entries) {
          const resolved = resolveFixCasingSentinel(row.id, field, value as string | null, overrides);
          db.prepare(
            `INSERT INTO door_catalog_overrides (catalog_id, field, value, edited_by, edited_at)
             VALUES (?, ?, ?, ?, strftime('%s','now'))
             ON CONFLICT(catalog_id, field) DO UPDATE SET
               value = excluded.value, edited_by = excluded.edited_by, edited_at = excluded.edited_at`
          ).run(row.id, field, resolved, req.admin?.id ?? null);
          recordAudit(db, req.admin?.id ?? null, 'edit', row.id, {
            field,
            from: field in before ? before[field as never] : undefined,
            to: resolved,
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
   * Re-scan a door to re-run the derivation and update the catalog.
   */
  router.post('/doors/:archiveName/rescan', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? req.params.archiveName[req.params.archiveName.length - 1] : req.params.archiveName;
    const db = openDb(cfg);
    try {
      const entry = db.prepare('SELECT id, archive_path FROM door_catalog WHERE archive_name = ? COLLATE NOCASE').get(archiveName) as { id: string, archive_path: string } | undefined;
      if (!entry) { res.status(404).json({ error: 'no such door' }); return; }

      const archivePath = path.join(cfg.archivesRoot, entry.archive_path);
      if (!fs.existsSync(archivePath)) { res.status(404).json({ error: 'archive file missing' }); return; }

      const bytes = fs.readFileSync(archivePath);
      const groupTags = buildGroupTags(db.prepare('SELECT archive_name FROM door_catalog').all().map((r: any) => r.archive_name));
      
      const derived = deriveMetadata(bytes, archiveName, groupTags);
      
      db.prepare(`UPDATE door_catalog SET 
          name = ?, version = ?, author = ?, description = ?, 
          requires_bbs = ?, binary_name = ?, file_id_diz = ?, 
          doc_filename = ?, doc_raw = ? 
          WHERE id = ?`).run(
              derived.name, derived.version, derived.author, derived.description,
              derived.requiresBbs, derived.binaryName, derived.fileIdDiz,
              derived.docFilename, derived.doc, entry.id
          );
      
      recordAudit(db, req.admin?.id ?? null, 'rescan-door', archiveName, { newName: derived.name });
      res.json({ ok: true, name: derived.name });
    } catch (e) {
      res.status(500).json({ error: String(e) });
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

  /**
   * The classifier's own casing normaliser, on tap: what tidyCase() would do
   * to a value, without writing anything. This is the "fix casing" button in
   * the field editor - one implementation, so the button and the classifier
   * can never disagree about what normal casing looks like.
   */
  router.post('/tidy-case', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const { text, mode } = (req.body ?? {}) as { text?: unknown; mode?: unknown };
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'text must be a string' });
      return;
    }
    const fn = mode === 'title' ? fixTitleCasing : fixCasing;
    res.json({ text: fn(text) });
  });

  /**
   * Take a door OUT of the repository.
   *
   * Not a DELETE: door_catalog is rewritten by every corpus scan, so a
   * deleted row would come back and the archive would still be on disk.
   * The removal is recorded beside the catalog instead - which makes it
   * reversible, auditable, and effective everywhere at once: the door
   * vanishes from /doors, list.txt, index.tsv and the manifest, and its
   * archive stops downloading.
   */
  router.delete('/doors/:archiveName', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const reason = typeof (req.body as { reason?: unknown })?.reason === 'string'
      ? ((req.body as { reason: string }).reason).slice(0, 500)
      : null;
    const db = openDb(cfg);
    try {
      const row = db
        .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such door' });
        return;
      }
      db.prepare(
        `INSERT INTO door_hidden (catalog_id, reason, hidden_by, hidden_at)
         VALUES (?, ?, ?, strftime('%s','now'))
         ON CONFLICT(catalog_id) DO UPDATE SET
           reason = excluded.reason, hidden_by = excluded.hidden_by, hidden_at = excluded.hidden_at`
      ).run(row.id, reason, req.admin?.id ?? null);
      recordAudit(db, req.admin?.id ?? null, 'hide', row.id, { archiveName, reason });
      res.json({ ok: true, hidden: true, archiveName });
    } finally {
      db.close();
    }
  });

  /** Put a hidden door back into the repository. */
  router.post('/doors/:archiveName/restore', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const db = openDb(cfg);
    try {
      const row = db
        .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such door' });
        return;
      }
      const result = db.prepare('DELETE FROM door_hidden WHERE catalog_id = ?').run(row.id);
      if (result.changes > 0) {
        recordAudit(db, req.admin?.id ?? null, 'restore', row.id, { archiveName });
      }
      res.json({ ok: true, restored: result.changes > 0 });
    } finally {
      db.close();
    }
  });

  /** Everything currently taken out of the repository. */
  router.get('/hidden', requireAdmin(cfg), (_req: AuthedRequest, res: Response) => {
    const db = openDb(cfg, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT c.archive_name AS archiveName, c.name AS catalogName, h.reason, h.hidden_at AS hiddenAt,
                  u.username AS hiddenBy
             FROM door_hidden h
             JOIN door_catalog c ON c.id = h.catalog_id
             LEFT JOIN admin_users u ON u.id = h.hidden_by
            ORDER BY h.hidden_at DESC`
        )
        .all();
      res.json({ rows });
    } finally {
      db.close();
    }
  });

  // ─── batch operations ────────────────────────────────────────────────

  /** Hide multiple doors at once. */
  router.post('/doors/batch-hide', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { doors?: { archiveName: string; reason?: string }[] };
    if (!Array.isArray(body.doors) || body.doors.length === 0) {
      res.status(400).json({ error: 'doors array required' });
      return;
    }
    const db = openDb(cfg);
    try {
      const lookup = db.prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE');
      const hide = db.prepare(
        `INSERT INTO door_hidden (catalog_id, reason, hidden_by, hidden_at)
         VALUES (?, ?, ?, strftime('%s','now'))
         ON CONFLICT(catalog_id) DO UPDATE SET
           reason = excluded.reason, hidden_by = excluded.hidden_by, hidden_at = excluded.hidden_at`
      );
      const results: { archiveName: string; ok: boolean; error?: string }[] = [];
      const write = db.transaction(() => {
        for (const { archiveName, reason } of body.doors!) {
          const row = lookup.get(archiveName) as { id: string } | undefined;
          if (!row) {
            results.push({ archiveName, ok: false, error: 'not found' });
            continue;
          }
          hide.run(row.id, (reason ?? '').slice(0, 500) || null, req.admin?.id ?? null);
          recordAudit(db, req.admin?.id ?? null, 'hide', row.id, { archiveName, reason: reason ?? null });
          results.push({ archiveName, ok: true });
        }
      });
      write();
      res.json({ ok: true, results });
    } finally {
      db.close();
    }
  });

  /** Restore multiple doors at once. */
  router.post('/doors/batch-restore', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { archiveNames?: string[] };
    if (!Array.isArray(body.archiveNames) || body.archiveNames.length === 0) {
      res.status(400).json({ error: 'archiveNames array required' });
      return;
    }
    const db = openDb(cfg);
    try {
      const lookup = db.prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE');
      const del = db.prepare('DELETE FROM door_hidden WHERE catalog_id = ?');
      const results: { archiveName: string; ok: boolean; restored: boolean }[] = [];
      const write = db.transaction(() => {
        for (const archiveName of body.archiveNames!) {
          const row = lookup.get(archiveName) as { id: string } | undefined;
          if (!row) {
            results.push({ archiveName, ok: false, restored: false });
            continue;
          }
          const result = del.run(row.id);
          if (result.changes > 0) {
            recordAudit(db, req.admin?.id ?? null, 'restore', row.id, { archiveName });
          }
          results.push({ archiveName, ok: true, restored: result.changes > 0 });
        }
      });
      write();
      res.json({ ok: true, results });
    } finally {
      db.close();
    }
  });

  /** Edit fields on multiple doors at once. */
  router.post('/doors/batch-patch', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { archiveNames?: string[]; fields?: Record<string, unknown> };
    if (!Array.isArray(body.archiveNames) || body.archiveNames.length === 0) {
      res.status(400).json({ error: 'archiveNames array required' });
      return;
    }
    const fieldEntries = Object.entries(body.fields ?? {});
    if (fieldEntries.length === 0) {
      res.status(400).json({ error: 'fields object required' });
      return;
    }
    const unknown = fieldEntries.filter(([f]) => !isOverridableField(f)).map(([f]) => f);
    if (unknown.length) {
      res.status(400).json({ error: `not an editable field: ${unknown.join(', ')}` });
      return;
    }
    const badType = fieldEntries.find(([, v]) => v !== null && typeof v !== 'string');
    if (badType) {
      res.status(400).json({ error: 'every value must be a string or null' });
      return;
    }
    const db = openDb(cfg);
    try {
      const lookup = db.prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE');
      const upsert = db.prepare(
        `INSERT INTO door_catalog_overrides (catalog_id, field, value, edited_by, edited_at)
         VALUES (?, ?, ?, ?, strftime('%s','now'))
         ON CONFLICT(catalog_id, field) DO UPDATE SET
           value = excluded.value, edited_by = excluded.edited_by, edited_at = excluded.edited_at`
      );
      const overrides = loadOverrides(db);
      let count = 0;
      const write = db.transaction(() => {
        for (const archiveName of body.archiveNames!) {
          const row = lookup.get(archiveName) as { id: string } | undefined;
          if (!row) continue;
          for (const [field, value] of fieldEntries) {
            const resolved = resolveFixCasingSentinel(row.id, field, value as string | null, overrides);
            upsert.run(row.id, field, resolved, req.admin?.id ?? null);
            recordAudit(db, req.admin?.id ?? null, 'edit', row.id, { field, to: resolved, archiveName });
            count++;
          }
        }
      });
      write();
      res.json({ ok: true, edited: body.archiveNames!.length, fields: fieldEntries.length, changes: count });
    } finally {
      db.close();
    }
  });

  /** The submission queue. Pending first unless asked otherwise. */
  router.get('/submissions', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const db = openDb(cfg, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT s.id, s.archive_name AS archiveName, s.size, s.md5, s.sha256,
                  s.submitter_note AS note, s.status, s.reject_reason AS rejectReason,
                  s.created_at AS createdAt, s.decided_at AS decidedAt, u.username AS decidedBy,
                  s.parsed_name AS derived
             FROM door_submissions s
             LEFT JOIN admin_users u ON u.id = s.decided_by
            WHERE (? = 'all' OR s.status = ?)
            ORDER BY s.created_at DESC LIMIT 200`
        )
        .all(status, status) as (Record<string, unknown> & { derived: string | null })[];
      res.json({
        // What the archive said about itself when it arrived, so a curator
        // decides on a door rather than on a filename.
        rows: rows.map(({ derived, ...row }) => ({
          ...row,
          derived: derived ? (JSON.parse(derived) as unknown) : null,
        })),
      });
    } finally {
      db.close();
    }
  });

  /**
   * Accept a submission: the file leaves quarantine for the archive root and
   * a catalog row appears. The submitter's IP is deliberately not in the
   * listing above - a curator decides on the archive, not on who sent it.
   */
  router.post('/submissions/:id/approve', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const id = Array.isArray(req.params.id) ? '' : req.params.id;
    const db = openDb(cfg);
    try {
      const result = approveSubmission(db, cfg, id, req.admin?.id ?? null);
      recordAudit(db, req.admin?.id ?? null, 'approve', id, result);
      res.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof UploadError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    } finally {
      db.close();
    }
  });

  /** Turn a submission down, and delete the file from quarantine. */
  router.post('/submissions/:id/reject', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const id = Array.isArray(req.params.id) ? '' : req.params.id;
    const reason = typeof (req.body as { reason?: unknown })?.reason === 'string'
      ? ((req.body as { reason: string }).reason).slice(0, 500)
      : null;
    const db = openDb(cfg);
    try {
      rejectSubmission(db, id, req.admin?.id ?? null, reason);
      recordAudit(db, req.admin?.id ?? null, 'reject', id, { reason });
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof UploadError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
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

  // ─── archive stripping ───────────────────────────────────────────

  /**
   * Preview what the ad stripper would flag in this archive, without
   * modifying anything. The response includes every file with its
   * classification verdict so the UI can show a checklist.
   */
  router.post('/doors/:archiveName/strip-preview', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db
        .prepare('SELECT archive_path FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { archive_path: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such door' });
        return;
      }
      const absPath = resolveArchivePath(cfg, row.archive_path);
      const fs = require('fs');
      if (!fs.existsSync(absPath)) {
        res.status(404).json({ error: 'archive file not found on disk' });
        return;
      }

      let result;
      try {
        const learned = db
          .prepare('SELECT pattern FROM learned_junk_patterns')
          .all() as { pattern: string }[];
        const extraPatterns = learned.map((r) => r.pattern);
        result = analyzeArchive(absPath, extraPatterns.length > 0 ? extraPatterns : undefined);
      } catch (e: any) {
        res.status(400).json({ error: `cannot read archive: ${e?.message ?? String(e)}` });
        return;
      }
      if (result.kept.length === 0 && result.stripped.length === 0) {
        const ext = require('path').extname(absPath).toLowerCase();
        if (ext === '.lzx') {
          res.status(400).json({ error: 'LZX archives cannot be read by this server' });
          return;
        }
      }
      res.json({
        archiveName,
        archivePath: absPath,
        kept: result.kept,
        stripped: result.stripped,
        reason: result.reason,
      });
    } finally {
      db.close();
    }
  });

  /**
   * Strip junk members from a catalog archive in place. The archive must
   * be LHA/LZH (LZX cannot be rewritten). After deletion the catalog row
   * is re-described: size, digests, junk_count, and indexed_at are
   * refreshed.
   */
  router.post('/doors/:archiveName/strip', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const body = (req.body ?? {}) as { members?: unknown };
    if (!Array.isArray(body.members) || body.members.length === 0) {
      res.status(400).json({ error: 'members must be a non-empty array of file paths' });
      return;
    }
    const members = body.members.filter((m): m is string => typeof m === 'string');
    if (members.length === 0) {
      res.status(400).json({ error: 'members must be non-empty strings' });
      return;
    }

    const result = stripArchiveOnServer(cfg, archiveName, members, req.admin?.id ?? null);
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    const auditDb = openDb(cfg);
    try {
      recordAudit(auditDb, req.admin?.id ?? null, 'strip', archiveName, {
        members,
        removed: result.removed,
      });
    } finally {
      auditDb.close();
    }
    res.json({ ok: true, removed: result.removed, newJunkCount: result.newJunkCount });
  });

  // ─── learned junk patterns ──────────────────────────────────────

  /** Add a learned junk pattern. The classifier will treat matching files as ad/junk in future previews. */
  router.post('/learn', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { pattern?: unknown; archiveName?: unknown; filePath?: unknown };
    const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : '';
    if (!pattern) {
      res.status(400).json({ error: 'pattern is required' });
      return;
    }
    const archiveName = typeof body.archiveName === 'string' ? body.archiveName : null;
    const filePath = typeof body.filePath === 'string' ? body.filePath : null;
    const db = openDb(cfg);
    try {
      const existing = db
        .prepare('SELECT id FROM learned_junk_patterns WHERE pattern = ? COLLATE NOCASE')
        .get(pattern) as { id: number } | undefined;
      if (existing) {
        res.json({ ok: true, id: existing.id, duplicate: true });
        return;
      }
      const info = db
        .prepare('INSERT INTO learned_junk_patterns (pattern, archive_name, file_path, learned_by) VALUES (?, ?, ?, ?)')
        .run(pattern, archiveName, filePath, req.admin?.username ?? 'admin');
      recordAudit(db, req.admin?.id ?? null, 'learn', archiveName ?? '', { pattern, filePath });
      res.json({ ok: true, id: Number(info.lastInsertRowid), duplicate: false });
    } finally {
      db.close();
    }
  });

  /** List all learned junk patterns. */
  router.get('/learned', requireAdmin(cfg), (_req: AuthedRequest, res: Response) => {
    const db = openDb(cfg, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT id, pattern, archive_name, file_path, learned_by, created_at FROM learned_junk_patterns ORDER BY created_at DESC')
        .all() as { id: number; pattern: string; archive_name: string | null; file_path: string | null; learned_by: string; created_at: number }[];
      res.json({ patterns: rows });
    } finally {
      db.close();
    }
  });

  /** Remove a learned junk pattern. */
  router.delete('/learned/:id', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const id = Number.parseInt(Array.isArray(req.params.id) ? '' : req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const db = openDb(cfg);
    try {
      const info = db.prepare('DELETE FROM learned_junk_patterns WHERE id = ?').run(id);
      if (info.changes === 0) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      recordAudit(db, req.admin?.id ?? null, 'unlearn', '', { id });
      res.json({ ok: true });
    } finally {
      db.close();
    }
  });

  // ─── file extraction and deletion ──────────────────────────────────

  /** Extract a single file from an archive and return its content. */
  router.get('/doors/:archiveName/file', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const memberPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!memberPath) {
      res.status(400).json({ error: 'path query parameter required' });
      return;
    }
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db
        .prepare('SELECT archive_path FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { archive_path: string } | undefined;
      if (!row) { res.status(404).json({ error: 'no such door' }); return; }
      const absPath = resolveArchivePath(cfg, row.archive_path);
      const bytes = fs.readFileSync(absPath);
      const unpacked = extractFile(bytes, memberPath);
      if (!unpacked) { res.status(404).json({ error: 'member not found or cannot be decoded' }); return; }
      res.setHeader('Content-Type', 'text/plain; charset=iso-8859-1');
      res.send(Buffer.from(unpacked));
    } catch {
      res.status(500).json({ error: 'failed to read archive' });
    } finally {
      db.close();
    }
  });

  /** Delete one or more members from an LHA archive in place. */
  router.post('/doors/:archiveName/delete-files', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const body = (req.body ?? {}) as { members?: unknown };
    if (!Array.isArray(body.members) || body.members.length === 0) {
      res.status(400).json({ error: 'members must be a non-empty array of paths' });
      return;
    }
    const members = body.members.filter((m): m is string => typeof m === 'string' && m.length > 0);
    if (members.length === 0) {
      res.status(400).json({ error: 'members must be non-empty strings' });
      return;
    }
    const db = openDb(cfg);
    try {
      const row = db
        .prepare('SELECT archive_path FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { archive_path: string } | undefined;
      if (!row) { res.status(404).json({ error: 'no such door' }); return; }
      const absPath = resolveArchivePath(cfg, row.archive_path);
      const binary = findArchiverBinary();
      if (!binary) { res.status(400).json({ error: 'no lha binary available' }); return; }
      const result = deleteMembers(absPath, members, { binary });
      if (!result.ok) { res.status(400).json({ error: result.reason }); return; }
      // Update door_catalog_files to remove deleted members
      const catRow = db.prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE').get(archiveName) as { id: string } | undefined;
      if (catRow) {
        const delStmt = db.prepare('DELETE FROM door_catalog_files WHERE catalog_id = ? AND path = ?');
        for (const m of members) delStmt.run(catRow.id, m);
      }
      recordAudit(db, req.admin?.id ?? null, 'delete-files', archiveName, { members, removed: result.removed });
      res.json({ ok: true, removed: result.removed });
    } finally {
      db.close();
    }
  });

  // ─── release groups ────────────────────────────────────────────────

  /** List all release group abbreviations with their full names. */
  router.get('/release-groups', requireAdmin(cfg), (_req: AuthedRequest, res: Response) => {
    const db = openDb(cfg);
    try {
      const rows = db
        .prepare('SELECT abbreviation, full_name, updated_at FROM release_groups ORDER BY abbreviation')
        .all() as { abbreviation: string; full_name: string; updated_at: number }[];
      res.json({ groups: rows });
    } finally {
      db.close();
    }
  });

  /** Set the full name for one or more release groups. */
  router.patch('/release-groups', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const entries = Object.entries(body);
    if (entries.length === 0) {
      res.status(400).json({ error: 'no groups given' });
      return;
    }
    for (const [abbr, name] of entries) {
      if (typeof abbr !== 'string' || abbr.length === 0) {
        res.status(400).json({ error: 'every key must be a non-empty abbreviation' });
        return;
      }
      if (name !== null && typeof name !== 'string') {
        res.status(400).json({ error: 'every value must be a string or null' });
        return;
      }
    }

    const db = openDb(cfg);
    try {
      const upsert = db.prepare(
        `INSERT INTO release_groups (abbreviation, full_name, updated_at)
         VALUES (?, ?, strftime('%s','now'))
         ON CONFLICT(abbreviation) DO UPDATE SET
           full_name = excluded.full_name, updated_at = excluded.updated_at`
      );
      const del = db.prepare('DELETE FROM release_groups WHERE abbreviation = ?');
      const write = db.transaction(() => {
        for (const [abbr, name] of entries) {
          if (name === null || name === '') {
            del.run(abbr);
          } else {
            upsert.run(abbr, name);
          }
          recordAudit(db, req.admin?.id ?? null, 'edit-release-group', abbr, { full_name: name });
        }
      });
      write();
      res.json({ ok: true, groups: Object.keys(body) });
    } finally {
      db.close();
    }
  });

  // ─── duplicate detection ────────────────────────────────────────────

  /** Find doors with duplicate MD5, SHA256, or name+author+version. */
  router.get('/duplicates', requireAdmin(cfg), (_req: AuthedRequest, res: Response) => {
    const db = openDb(cfg, { readonly: true });
    try {
      const byMd5 = db
        .prepare(
          `SELECT md5, COUNT(*) AS n, GROUP_CONCAT(archive_name) AS archives
             FROM door_catalog
            WHERE md5 IS NOT NULL AND md5 <> ''
            GROUP BY md5 HAVING n > 1
            ORDER BY n DESC`
        )
        .all() as { md5: string; n: number; archives: string }[];

      const bySha256 = db
        .prepare(
          `SELECT sha256, COUNT(*) AS n, GROUP_CONCAT(archive_name) AS archives
             FROM door_catalog
            WHERE sha256 IS NOT NULL AND sha256 <> ''
            GROUP BY sha256 HAVING n > 1
            ORDER BY n DESC`
        )
        .all() as { sha256: string; n: number; archives: string }[];

      const byContent = db
        .prepare(
          `SELECT name, author, version, COUNT(*) AS n, GROUP_CONCAT(archive_name) AS archives
             FROM door_catalog
            WHERE name IS NOT NULL AND name <> ''
              AND author IS NOT NULL AND author <> ''
            GROUP BY name, author, version HAVING n > 1
            ORDER BY n DESC
            LIMIT 50`
        )
        .all() as { name: string; author: string; version: string | null; n: number; archives: string }[];

      res.json({ byMd5, bySha256, byContent });
    } finally {
      db.close();
    }
  });

  // ─── per-door audit history ────────────────────────────────────────

  router.get('/doors/:archiveName/audit', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db
        .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such door' });
        return;
      }
      const entries = db
        .prepare(
          `SELECT a.id, a.action, a.target, a.detail, a.at, COALESCE(u.username, 'system') AS by
             FROM admin_audit a
             LEFT JOIN admin_users u ON u.id = a.admin_id
            WHERE a.target = ?
            ORDER BY a.at DESC
            LIMIT 100`
        )
        .all(row.id) as { id: number; action: string; target: string; detail: string | null; at: number; by: string }[];
      res.json({
        entries: entries.map((e) => ({
          ...e,
          detail: e.detail ? JSON.parse(e.detail) as Record<string, unknown> : null,
        })),
      });
    } finally {
      db.close();
    }
  });

  // ─── tags / labels ──────────────────────────────────────────────────

  /** List all unique tags in use. */
  router.get('/tags', requireAdmin(cfg), (_req: AuthedRequest, res: Response) => {
    const db = openDb(cfg, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT tag, COUNT(*) AS n FROM door_tags GROUP BY tag ORDER BY n DESC')
        .all() as { tag: string; n: number }[];
      res.json({ tags: rows });
    } finally {
      db.close();
    }
  });

  /** Get tags for a specific door. */
  router.get('/doors/:archiveName/tags', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db
        .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such door' });
        return;
      }
      const tags = db
        .prepare('SELECT tag FROM door_tags WHERE catalog_id = ? ORDER BY tag')
        .all(row.id) as { tag: string }[];
      res.json({ tags: tags.map((t) => t.tag) });
    } finally {
      db.close();
    }
  });

  /** Set tags for a door (replaces all tags). */
  router.patch('/doors/:archiveName/tags', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const body = (req.body ?? {}) as { tags?: unknown };
    if (!Array.isArray(body.tags)) {
      res.status(400).json({ error: 'tags must be an array of strings' });
      return;
    }
    const tags = body.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
    const db = openDb(cfg);
    try {
      const row = db
        .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'no such door' });
        return;
      }
      const del = db.prepare('DELETE FROM door_tags WHERE catalog_id = ?');
      const ins = db.prepare(
        'INSERT INTO door_tags (catalog_id, tag, added_by) VALUES (?, ?, ?)'
      );
      const write = db.transaction(() => {
        del.run(row.id);
        for (const tag of tags) {
          ins.run(row.id, tag.trim().toLowerCase(), req.admin?.id ?? null);
        }
        recordAudit(db, req.admin?.id ?? null, 'edit-tags', row.id, { archiveName, tags });
      });
      write();
      res.json({ ok: true, tags });
    } finally {
      db.close();
    }
  });

  return router;
}
