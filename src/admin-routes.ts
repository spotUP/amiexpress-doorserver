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
import { analyzeArchive, isMatchAllGlob, type StripEntry } from './ami-stripper';
import { stripArchiveOnServer, resolveArchivePath } from './catalog';
import { extractFile, readLhaContents, readZipContents, readLzxContents, looksLikeText } from './archive-reader';
import { deleteMembers, findArchiverBinary } from './lha-member-delete';
import { createJob, runJobSequentially, getJob, setJobResult, markJobFailed } from './batch-jobs';
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

/**
 * Re-read one archive's DIZ/file list and write it back to the catalog.
 * Shared by the single-door /reextract route and the batch job runner -
 * previously this logic lived only inline in the single-door route. The
 * single-door route's response is richer than the batch route needs, so
 * this returns the full `derived` object on success and each caller picks
 * what it needs from it.
 *
 * The whole body is wrapped in try/catch (rather than just try/finally
 * around db.close()) so that an exception thrown mid-extraction - e.g.
 * deriveMetadata() or an archive reader choking on a corrupt file - comes
 * back as a clean `{ error }` result instead of propagating uncaught. The
 * single-door route used to have its own outer try/catch around this exact
 * body for that reason; that catch is now unreachable dead code and has
 * been removed from the route, since this function can no longer throw.
 * The batch route doesn't need its own catch either: runJobSequentially()
 * already treats a returned `{ error }` as a normal failed-item outcome.
 */
function reextractOneDoor(cfg: ServerConfig, archiveName: string, adminId: number | null): { ok: true; fileCount: number; derived: ReturnType<typeof deriveMetadata> } | { error: string } {
  const db = openDb(cfg);
  try {
    const entry = db.prepare('SELECT id, archive_path FROM door_catalog WHERE archive_name = ? COLLATE NOCASE').get(archiveName) as { id: string; archive_path: string } | undefined;
    if (!entry) return { error: 'no such door' };

    const archivePath = path.join(cfg.archivesRoot, entry.archive_path);
    if (!fs.existsSync(archivePath)) return { error: 'archive file missing' };

    const bytes = fs.readFileSync(archivePath);
    const groupTags = buildGroupTags(
      (db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[]).map((r) => r.archive_name)
    );
    const derived = deriveMetadata(bytes, archiveName, groupTags);

    // Pull the file list directly from the archive reader, which now
    // falls back to the system `lha` binary when the JS reader fails.
    const ext = path.extname(archivePath).toLowerCase();
    let files: { path: string; size: number }[] = [];
    if (ext === '.lha' || ext === '.lzh') files = readLhaContents(bytes, archivePath).files;
    else if (ext === '.zip') files = readZipContents(bytes).files;
    else if (ext === '.lzx') files = readLzxContents(bytes).files;

    const write = db.transaction(() => {
      // Update catalog metadata from the freshly-read archive.
      db.prepare(`UPDATE door_catalog SET
          name = ?, version = ?, author = ?, description = ?,
          requires_bbs = ?, binary_name = ?, file_id_diz = ?,
          doc_filename = ?, doc_raw = ?, indexed_at = strftime('%s','now')
          WHERE id = ?`).run(
        derived.name, derived.version, derived.author, derived.description,
        derived.requiresBbs, derived.binaryName, derived.fileIdDiz,
        derived.docFilename, derived.doc, entry.id
      );
      // Wipe and rewrite the file list - overwrites any previous junk
      // flagging, which is what a full re-extract means.
      db.prepare('DELETE FROM door_catalog_files WHERE catalog_id = ?').run(entry.id);
      if (files.length > 0) {
        const ins = db.prepare('INSERT INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason) VALUES (?, ?, ?, 0, NULL)');
        for (const f of files) ins.run(entry.id, f.path, f.size);
      }
      recordAudit(db, adminId, 'reextract', archiveName, { fileCount: files.length, dizFound: Boolean(derived.fileIdDiz), docFound: Boolean(derived.doc) });
    });
    write();
    return { ok: true, fileCount: files.length, derived };
  } catch (e) {
    return { error: String(e) };
  } finally {
    db.close();
  }
}

/**
 * Defense-in-depth backstop for the three `void runJobSequentially(...)`
 * fire-and-forget call sites below. runJobSequentially itself now never
 * throws (see its top-level try/catch in batch-jobs.ts) - this exists for
 * anything that could still escape from outside it, e.g. a callback passed
 * into it throwing after runJobSequentially's own promise has resolved.
 * Reads the job's last-known progress so the terminal 'failed' event reports
 * real numbers instead of zeros.
 */
function failJobOnEscape(cfg: ServerConfig, jobId: string, total: number): (e: unknown) => void {
  return (e: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`[door-repo] job ${jobId} escaped with an unhandled error:`, e);
    const job = getJob(cfg, jobId);
    markJobFailed(cfg, jobId, job?.completed ?? 0, total, job?.failedCount ?? 0);
  };
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
   * Re-extract the file list for a door and write it into
   * door_catalog_files. Also updates FILE_ID.DIZ, doc, name, version,
   * author, description, binary_name, requires_bbs from the archive.
   *
   * Use this for doors that were scanned before the reader supported
   * their compression level — the catalog row exists, but no files were
   * ever written.
   */
  router.post('/doors/:archiveName/reextract', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? req.params.archiveName[req.params.archiveName.length - 1] : req.params.archiveName;
    const result = reextractOneDoor(cfg, archiveName, req.admin?.id ?? null);
    if ('error' in result) {
      res.status(result.error === 'no such door' || result.error === 'archive file missing' ? 404 : 500).json({ error: result.error });
      return;
    }
    res.json({
      ok: true,
      archiveName,
      fileCount: result.fileCount,
      name: result.derived.name,
      version: result.derived.version,
      author: result.derived.author,
      description: result.derived.description,
      binaryName: result.derived.binaryName,
      fileIdDiz: result.derived.fileIdDiz,
      docFilename: result.derived.docFilename,
    });
  });

  /** Re-extract many doors as a tracked background job. */
  router.post('/doors/batch-reextract', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { archiveNames?: string[] };
    if (!Array.isArray(body.archiveNames) || body.archiveNames.length === 0) {
      res.status(400).json({ error: 'archiveNames array required' });
      return;
    }
    const jobId = createJob(cfg, 'reextract', body.archiveNames, req.admin?.id ?? null);
    const adminId = req.admin?.id ?? null;
    void runJobSequentially(cfg, jobId, body.archiveNames, (archiveName) => {
      const result = reextractOneDoor(cfg, archiveName, adminId);
      return 'error' in result ? { error: result.error } : { ok: true };
    }).catch(failJobOnEscape(cfg, jobId, body.archiveNames.length));
    res.json({ jobId });
  });

  /** Re-extract the file list for every door that currently has zero files.
   *  Useful as a one-shot fix after adding a fallback reader. Returns the
   *  count fixed and the names that still could not be read. */
  router.post('/doors/reextract-empty', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const db = openDb(cfg);
    const groupTags = buildGroupTags(
      (db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[]).map(
        (r) => r.archive_name
      )
    );
    const empty = db.prepare(
      `SELECT id, archive_name, archive_path FROM door_catalog
        WHERE id NOT IN (SELECT DISTINCT catalog_id FROM door_catalog_files)
        ORDER BY archive_name`
    ).all() as { id: string; archive_name: string; archive_path: string }[];

    const fixed: string[] = [];
    const stillEmpty: string[] = [];
    const errors: { name: string; error: string }[] = [];

    for (const entry of empty) {
      const archivePath = path.join(cfg.archivesRoot, entry.archive_path);
      if (!fs.existsSync(archivePath)) {
        stillEmpty.push(entry.archive_name);
        continue;
      }
      try {
        const bytes = fs.readFileSync(archivePath);
        const ext = path.extname(archivePath).toLowerCase();
        let files: { path: string; size: number }[] = [];
        if (ext === '.lha' || ext === '.lzh') {
          files = readLhaContents(bytes, archivePath).files;
        } else if (ext === '.zip') {
          files = readZipContents(bytes).files;
        } else if (ext === '.lzx') {
          files = readLzxContents(bytes).files;
        }
        if (files.length === 0) {
          stillEmpty.push(entry.archive_name);
          continue;
        }
        const derived = deriveMetadata(bytes, entry.archive_name, groupTags);
        const write = db.transaction(() => {
          db.prepare(`UPDATE door_catalog SET 
              name = ?, version = ?, author = ?, description = ?, 
              requires_bbs = ?, binary_name = ?, file_id_diz = ?, 
              doc_filename = ?, doc_raw = ?, indexed_at = strftime('%s','now')
              WHERE id = ?`).run(
                  derived.name, derived.version, derived.author, derived.description,
                  derived.requiresBbs, derived.binaryName, derived.fileIdDiz,
                  derived.docFilename, derived.doc, entry.id
              );
          db.prepare('DELETE FROM door_catalog_files WHERE catalog_id = ?').run(entry.id);
          const ins = db.prepare(
            'INSERT INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason) VALUES (?, ?, ?, 0, NULL)'
          );
          for (const f of files) ins.run(entry.id, f.path, f.size);
        });
        write();
        fixed.push(entry.archive_name);
        recordAudit(db, req.admin?.id ?? null, 'reextract', entry.archive_name, { fileCount: files.length });
      } catch (e) {
        errors.push({ name: entry.archive_name, error: String(e) });
      }
    }
    res.json({ ok: true, fixed: fixed.length, stillEmpty: stillEmpty.length, errors, fixedNames: fixed, stillEmptyNames: stillEmpty });
  });

  /** Get the content of a file inside an archive. */
  router.get(/^\/doors\/([^\/]+)\/files\/(.*)$/, requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = req.params[0];
    const filePath = req.params[1];
    const db = openDb(cfg, { readonly: true });
    try {
      const entry = db.prepare('SELECT archive_path FROM door_catalog WHERE archive_name = ? COLLATE NOCASE').get(archiveName) as { archive_path: string } | undefined;
      if (!entry) { res.status(404).json({ error: 'no such door' }); return; }

      const archivePath = path.join(cfg.archivesRoot, entry.archive_path);
      if (!fs.existsSync(archivePath)) { res.status(404).json({ error: 'archive file missing' }); return; }

      const bytes = fs.readFileSync(archivePath);
      const fileBytes = extractFile(bytes, filePath);
      
      if (!fileBytes) { res.status(404).json({ error: 'file not found in archive' }); return; }
      
      res.setHeader('Content-Type', 'application/octet-stream');
      res.send(Buffer.from(fileBytes));
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

  /** Current state of a bulk job - for a client reconnecting after a refresh. */
  router.get('/jobs/:id', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const id = Array.isArray(req.params.id) ? '' : req.params.id;
    const job = getJob(cfg, id);
    if (!job) {
      res.status(404).json({ error: 'no such job' });
      return;
    }
    res.json(job);
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

  /** Add/remove tags across multiple doors at once (additive, unlike the
   *  single-door PATCH which replaces the whole tag set). */
  router.post('/doors/batch-tags', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { archiveNames?: string[]; add?: string[]; remove?: string[] };
    if (!Array.isArray(body.archiveNames) || body.archiveNames.length === 0) {
      res.status(400).json({ error: 'archiveNames array required' });
      return;
    }
    const add = (body.add ?? []).filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
    const remove = (body.remove ?? []).filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
    const db = openDb(cfg);
    try {
      const lookup = db.prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE');
      const insTag = db.prepare('INSERT OR IGNORE INTO door_tags (catalog_id, tag, added_by) VALUES (?, ?, ?)');
      const delTag = db.prepare('DELETE FROM door_tags WHERE catalog_id = ? AND tag = ?');
      const results: { archiveName: string; ok: boolean; error?: string }[] = [];
      const write = db.transaction(() => {
        for (const archiveName of body.archiveNames!) {
          const row = lookup.get(archiveName) as { id: string } | undefined;
          if (!row) {
            results.push({ archiveName, ok: false, error: 'not found' });
            continue;
          }
          for (const tag of add) insTag.run(row.id, tag.trim().toLowerCase(), req.admin?.id ?? null);
          for (const tag of remove) delTag.run(row.id, tag.trim().toLowerCase());
          recordAudit(db, req.admin?.id ?? null, 'edit-tags', row.id, { archiveName, add, remove });
          results.push({ archiveName, ok: true });
        }
      });
      write();
      res.json({ ok: true, results });
    } finally {
      db.close();
    }
  });

  /** Permanently remove multiple doors: catalog row, every child row keyed
   *  to it, and the archive file on disk. No single-door equivalent exists
   *  today (DELETE /doors/:archiveName is a soft hide) - this defines the
   *  real delete for the first time, so it enumerates every table itself
   *  rather than reusing something that doesn't do this. */
  router.post('/doors/batch-delete', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { archiveNames?: string[]; confirm?: string };
    if (!Array.isArray(body.archiveNames) || body.archiveNames.length === 0) {
      res.status(400).json({ error: 'archiveNames array required' });
      return;
    }
    if (body.archiveNames.some((n) => typeof n !== 'string')) {
      res.status(400).json({ error: 'archiveNames must all be strings' });
      return;
    }
    if (body.archiveNames.length > 200) {
      res.status(400).json({ error: 'batch too large - split into requests of 200 or fewer' });
      return;
    }
    if (body.confirm !== String(body.archiveNames.length)) {
      res.status(400).json({ error: `confirm must equal the archive count (${body.archiveNames.length})` });
      return;
    }
    const db = openDb(cfg);
    try {
      const lookup = db.prepare('SELECT id, archive_path FROM door_catalog WHERE archive_name = ? COLLATE NOCASE');
      const cleanupByCatalogId = [
        'DELETE FROM door_catalog_files WHERE catalog_id = ?',
        'DELETE FROM door_catalog_overrides WHERE catalog_id = ?',
        'DELETE FROM door_hidden WHERE catalog_id = ?',
        'DELETE FROM door_tags WHERE catalog_id = ?',
        'DELETE FROM door_votes WHERE catalog_id = ?',
      ].map((sql) => db.prepare(sql));
      const cleanupNotJunk = db.prepare('DELETE FROM door_not_junk WHERE archive_name = ? COLLATE NOCASE');
      const deleteCatalogRow = db.prepare('DELETE FROM door_catalog WHERE id = ?');
      const results: { archiveName: string; ok: boolean; error?: string }[] = [];
      // Absolute paths to unlink AFTER the DB transaction below has
      // committed - see the phase-2 comment for why the filesystem must
      // not be touched while the transaction is still open.
      const toUnlink: string[] = [];

      // Phase 1: every catalog-side DELETE for the whole batch runs inside
      // one transaction, and nothing here touches the filesystem. If a
      // later archive's statement throws (e.g. SQLITE_BUSY from a
      // concurrent writer), db.transaction() rolls back everything done so
      // far in this call - including the catalog rows for archives already
      // processed earlier in the loop. As long as no file has been deleted
      // yet, that rollback is safe: the catalog rows come back and the
      // files are still on disk. Deleting a file inside this block would
      // make that rollback resurrect a catalog row whose file is already
      // gone forever.
      const write = db.transaction(() => {
        for (const archiveName of body.archiveNames!) {
          const row = lookup.get(archiveName) as { id: string; archive_path: string } | undefined;
          if (!row) {
            results.push({ archiveName, ok: false, error: 'not found' });
            continue;
          }
          for (const stmt of cleanupByCatalogId) stmt.run(row.id);
          cleanupNotJunk.run(archiveName);
          deleteCatalogRow.run(row.id);
          recordAudit(db, req.admin?.id ?? null, 'delete', archiveName, {});
          results.push({ archiveName, ok: true });
          toUnlink.push(resolveArchivePath(cfg, row.archive_path));
        }
      });
      write();

      // Phase 2: write() has returned, so the transaction above has
      // COMMITTED - every catalog row deleted above is durably gone. Only
      // now do we mutate the filesystem, each unlink in its own try/catch:
      // a missing file or a permission error here leaves an orphan on
      // disk, not a reason to report an already-committed catalog delete
      // as failed.
      for (const absPath of toUnlink) {
        try {
          if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
        } catch {
          // Orphaned file on disk; the catalog row is already gone and
          // committed, so this is not reported as a failure.
        }
      }

      res.json({ ok: true, results });
    } catch (e) {
      res.status(500).json({ error: String(e) });
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
   * Runs strip-preview's classification for one archive: resolves the
   * catalog row, loads the admin's "not junk" corrections and any learned
   * patterns, and runs analyzeArchive(). Shared by the single-door
   * '/strip-preview' route and the batch-strip-preview job below.
   *
   * Returns everything the single-door route needs to reconstruct its
   * response unchanged - the full StripEntry[] (path+size+md5, not
   * narrowed), the full reason map, and the real preserved paths. The
   * batch route builds its own compact {path,reason}[] shape from
   * `stripped`+`reason`; this function does not pre-narrow that for it,
   * so the single-door route's response never has to change to serve the
   * batch caller's convenience.
   */
  function previewStripOne(cfg: ServerConfig, archiveName: string):
    | { ok: true; archivePath: string; kept: StripEntry[]; stripped: StripEntry[]; reason: Record<string, string>; notJunk: string[]; cleanedDiz: string | null; isEmptyLzx: boolean }
    | { error: string } {
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db
        .prepare('SELECT archive_path FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { archive_path: string } | undefined;
      if (!row) return { error: 'no such door' };
      const absPath = resolveArchivePath(cfg, row.archive_path);
      if (!fs.existsSync(absPath)) return { error: 'archive file not found on disk' };

      // Files the admin has marked as "not junk" are always kept, even
      // when the auto-stripper would flag them. This is the feedback
      // channel that makes the stripper smarter over time.
      const notJunk = db
        .prepare('SELECT file_path AS path FROM door_not_junk WHERE archive_name = ? COLLATE NOCASE')
        .all(archiveName) as { path: string }[];
      const preservePaths = new Set(notJunk.map((r) => r.path));

      let result;
      try {
        const learned = db
          .prepare('SELECT pattern FROM learned_junk_patterns')
          .all() as { pattern: string }[];
        const extraPatterns = learned.map((r) => r.pattern);
        result = analyzeArchive(
          absPath,
          extraPatterns.length > 0 ? extraPatterns : undefined,
          preservePaths.size > 0 ? preservePaths : undefined,
        );
      } catch (e: unknown) {
        return { error: `cannot read archive: ${(e as Error)?.message ?? String(e)}` };
      }
      const isEmptyLzx = result.kept.length === 0 && result.stripped.length === 0
        && path.extname(absPath).toLowerCase() === '.lzx';
      return {
        ok: true,
        archivePath: absPath,
        kept: result.kept,
        stripped: result.stripped,
        reason: result.reason,
        notJunk: Array.from(preservePaths),
        cleanedDiz: result.cleanedDiz ?? null,
        isEmptyLzx,
      };
    } finally {
      db.close();
    }
  }

  /**
   * Preview what the ad stripper would flag in this archive, without
   * modifying anything. The response includes every file with its
   * classification verdict so the UI can show a checklist.
   */
  router.post('/doors/:archiveName/strip-preview', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const result = previewStripOne(cfg, archiveName);
    if ('error' in result) {
      res.status(result.error === 'no such door' || result.error === 'archive file not found on disk' ? 404 : 400).json({ error: result.error });
      return;
    }
    if (result.isEmptyLzx) {
      res.status(400).json({ error: 'LZX archives cannot be read by this server' });
      return;
    }
    res.json({
      archiveName,
      archivePath: result.archivePath,
      kept: result.kept,
      stripped: result.stripped,
      reason: result.reason,
      notJunk: result.notJunk,
      cleanedDiz: result.cleanedDiz,
    });
  });

  /** Preview strip candidates across many doors as a tracked job - phase 1
   *  of batch strip. Never deletes anything; a later batch-strip-apply
   *  needs the admin's reviewed selection first. The job's resultJson is
   *  the review UI's own compact shape:
   *  {archiveName, stripped:{path,reason}[], error?: string}[], built here
   *  (not by previewStripOne) from the full stripped+reason it returns -
   *  archives with zero flagged files are included, not omitted, so the UI
   *  can show "0 flagged" instead of silently skipping them, and an archive
   *  that failed to preview (e.g. its file is missing) gets an `error` entry
   *  instead of vanishing from the review screen entirely.
   *
   *  `results` is written to `result_json` via runJobSequentially's
   *  `onBeforeComplete` hook rather than a `.then()` chained onto its
   *  returned promise - that guarantees the write lands BEFORE the terminal
   *  'done' SSE event fires, so a client that reacts to 'done' by fetching
   *  the job can never race the write (see Minor fix 2 in the fix-wave
   *  spec: this used to work only because the microtask always beat the
   *  client's HTTP round-trip).
   */
  router.post('/doors/batch-strip-preview', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { archiveNames?: string[] };
    if (!Array.isArray(body.archiveNames) || body.archiveNames.length === 0) {
      res.status(400).json({ error: 'archiveNames array required' });
      return;
    }
    const jobId = createJob(cfg, 'strip-preview', body.archiveNames, req.admin?.id ?? null);
    const results: { archiveName: string; stripped: { path: string; reason: string }[]; error?: string }[] = [];
    void runJobSequentially(
      cfg,
      jobId,
      body.archiveNames,
      (archiveName) => {
        const result = previewStripOne(cfg, archiveName);
        if ('error' in result) {
          results.push({ archiveName, stripped: [], error: result.error });
          return { error: result.error };
        }
        results.push({
          archiveName,
          stripped: result.stripped.map((e) => ({ path: e.path, reason: result.reason[e.path] ?? 'pattern' })),
        });
        return { ok: true };
      },
      () => setJobResult(cfg, jobId, JSON.stringify(results))
    ).catch(failJobOnEscape(cfg, jobId, body.archiveNames.length));
    res.json({ jobId });
  });

  /** Phase 2 of batch strip: apply exactly the member lists the admin
   *  confirmed in the review screen. Never re-derives from the classifier -
   *  each selection's `members` array is the only source of what gets
   *  deleted. An entry with `members: []` is a genuine skip (matches
   *  stripArchiveOnServer's own empty-members behavior: it marks the door
   *  reviewed via ads_stripped=1 without touching the archive on disk). */
  router.post('/doors/batch-strip-apply', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as { selections?: unknown };
    if (!Array.isArray(body.selections) || body.selections.length === 0) {
      res.status(400).json({ error: 'selections array required' });
      return;
    }
    // Same defensive shape-check the single-door '/strip' route applies to
    // `members`: reject anything that isn't {archiveName: string, members:
    // string[]} per entry rather than letting a malformed selection flow
    // straight into stripArchiveOnServer/deleteMembers.
    const selections = body.selections as unknown[];
    for (const s of selections) {
      const entry = s as { archiveName?: unknown; members?: unknown };
      if (typeof entry?.archiveName !== 'string' || !Array.isArray(entry?.members)) {
        res.status(400).json({ error: 'each selection needs an archiveName string and a members array' });
        return;
      }
    }
    const validSelections = selections as { archiveName: string; members: unknown[] }[];
    const archiveNames = validSelections.map((s) => s.archiveName);
    const membersByArchive = new Map(
      validSelections.map((s) => [s.archiveName, s.members.filter((m): m is string => typeof m === 'string')])
    );
    const jobId = createJob(cfg, 'strip-apply', archiveNames, req.admin?.id ?? null);
    void runJobSequentially(cfg, jobId, archiveNames, (archiveName) => {
      const members = membersByArchive.get(archiveName) ?? [];
      const result = stripArchiveOnServer(cfg, archiveName, members, req.admin?.id ?? null);
      if (!result.ok) return { error: result.reason ?? 'strip failed' };
      const auditDb = openDb(cfg);
      try {
        recordAudit(auditDb, req.admin?.id ?? null, 'strip', archiveName, { members, removed: result.removed });
      } finally {
        auditDb.close();
      }
      return { ok: true };
    }).catch(failJobOnEscape(cfg, jobId, archiveNames.length));
    res.json({ jobId });
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
    // An empty members array is allowed: it marks the door as reviewed
    // (sets ads_stripped=1) without removing anything - useful when the
    // stripper finds 0 ads and the operator wants to record the review.
    if (!Array.isArray(body.members)) {
      res.status(400).json({ error: 'members must be an array of file paths (may be empty)' });
      return;
    }
    const members = body.members.filter((m): m is string => typeof m === 'string');

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
    // Reject patterns that would match every file: bare '*' or '?', or any
    // pattern whose compiled form is anchored on both ends and contains
    // only wildcards. Without this guard, learning a single '*' file
    // would mark every future door as junk.
    if (isMatchAllGlob(pattern)) {
      res.status(400).json({ error: `pattern '${pattern}' would match every file - refuse to learn` });
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

  /**
   * Remove a learned pattern that was attached to a specific file in a
   * specific archive. Used by the "junk" toggle in the file list when the
   * admin realises they flagged the wrong file. Looks up the pattern that
   * was created with this archive+file pair and deletes it; the door's
   * file list and the catalog's is_junk flags then refresh on the next
   * strip-preview.
   *
   * Registered BEFORE /learned/:id so the literal segment "by-path" doesn't
   * get captured as an :id value. Express matches in declaration order.
   */
  router.delete('/learned/by-path', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = typeof req.query.archiveName === 'string' ? req.query.archiveName : '';
    const filePath = typeof req.query.filePath === 'string' ? req.query.filePath : '';
    if (!archiveName || !filePath) {
      res.status(400).json({ error: 'archiveName and filePath are required' });
      return;
    }
    const db = openDb(cfg);
    try {
      const info = db
        .prepare('DELETE FROM learned_junk_patterns WHERE archive_name = ? COLLATE NOCASE AND file_path = ? COLLATE NOCASE')
        .run(archiveName, filePath);
      if (info.changes === 0) {
        res.status(404).json({ error: 'no learned pattern for that file' });
        return;
      }
      recordAudit(db, req.admin?.id ?? null, 'unlearn', archiveName, { filePath });
      res.json({ ok: true, removed: info.changes });
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

  /**
   * Mark a file as "explicitly not junk" — the stripper will always keep
   * it, regardless of filename pattern, MD5 fingerprint, or content
   * scan. This is how an admin teaches the stripper "no, that .nfo
   * ISN'T an ad". A second call with the same path is a no-op.
   */
  router.post('/doors/:archiveName/not-junk', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const body = (req.body ?? {}) as { path?: unknown; reason?: unknown };
    const filePath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!filePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
    const db = openDb(cfg);
    try {
      db.prepare(
        `INSERT INTO door_not_junk (archive_name, file_path, reason, marked_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(archive_name, file_path) DO UPDATE SET
           reason = excluded.reason,
           marked_by = excluded.marked_by,
           marked_at = strftime('%s','now')`
      ).run(archiveName, filePath, reason, req.admin?.username ?? 'admin');
      recordAudit(db, req.admin?.id ?? null, 'not-junk', archiveName, { filePath, reason });
      res.json({ ok: true, archiveName, filePath });
    } finally {
      db.close();
    }
  });

  /** Drop a "not junk" override. */
  router.delete('/doors/:archiveName/not-junk', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter required' });
      return;
    }
    const db = openDb(cfg);
    try {
      const info = db
        .prepare('DELETE FROM door_not_junk WHERE archive_name = ? COLLATE NOCASE AND file_path = ?')
        .run(archiveName, filePath);
      if (info.changes === 0) {
        res.status(404).json({ error: 'no not-junk entry for that file' });
        return;
      }
      recordAudit(db, req.admin?.id ?? null, 'not-junk-remove', archiveName, { filePath });
      res.json({ ok: true, removed: info.changes });
    } finally {
      db.close();
    }
  });

  /** List every "not junk" override for an archive. */
  router.get('/doors/:archiveName/not-junk', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const db = openDb(cfg, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT file_path AS path, reason, marked_by AS markedBy, marked_at AS markedAt FROM door_not_junk WHERE archive_name = ? COLLATE NOCASE ORDER BY file_path')
        .all(archiveName) as { path: string; reason: string | null; markedBy: string; markedAt: number }[];
      res.json({ entries: rows });
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

  /**
   * Report whether a file inside an archive is text. Used by the UI to
   * decide whether to offer a "view" button. Reads up to 2 KB - the
   * detection only needs to spot null bytes and clusters of C0 controls,
   * not parse the whole document.
   */
  router.get('/doors/:archiveName/file-info', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
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
      const buf = Buffer.from(unpacked);
      res.json({
        path: memberPath,
        size: buf.length,
        isText: looksLikeText(buf),
      });
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

  /**
   * Set the full name for one or more release groups, or rename the
   * abbreviation itself.
   *
   * Body shape: `{ "<abbreviation>": { fullName: string|null, newAbbreviation?: string } }`
   *
   * - `fullName`: string sets the full name; `null` or `""` removes the group.
   * - `newAbbreviation`: if present and different from the current key,
   *   the row is renamed and every door_catalog row that referenced the
   *   old abbreviation is updated to point at the new one.
   */
  router.patch('/release-groups', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const entries = Object.entries(body);
    if (entries.length === 0) {
      res.status(400).json({ error: 'no groups given' });
      return;
    }

    const parsed: { oldAbbr: string; fullName: string | null; newAbbr: string }[] = [];
    for (const [abbr, raw] of entries) {
      if (typeof abbr !== 'string' || abbr.length === 0) {
        res.status(400).json({ error: 'every key must be a non-empty abbreviation' });
        return;
      }
      const value = raw as { fullName?: unknown; newAbbreviation?: unknown } | null | string;
      let fullName: unknown;
      let newAbbr: unknown;
      if (value === null) {
        fullName = null;
      } else if (typeof value === 'string') {
        fullName = value;
      } else if (typeof value === 'object' && value !== null) {
        fullName = value.fullName;
        newAbbr = value.newAbbreviation;
      } else {
        res.status(400).json({ error: 'every value must be a string, null, or an object' });
        return;
      }
      if (fullName !== null && typeof fullName !== 'string') {
        res.status(400).json({ error: 'fullName must be a string or null' });
        return;
      }
      if (newAbbr !== undefined && (typeof newAbbr !== 'string' || newAbbr.length === 0)) {
        res.status(400).json({ error: 'newAbbreviation must be a non-empty string' });
        return;
      }
      parsed.push({ oldAbbr: abbr, fullName: fullName as string | null, newAbbr: (newAbbr as string | undefined) ?? abbr });
    }

    const db = openDb(cfg);
    try {
      const lookup = db.prepare('SELECT full_name FROM release_groups WHERE abbreviation = ?');
      const upsert = db.prepare(
        `INSERT INTO release_groups (abbreviation, full_name, updated_at)
         VALUES (?, ?, strftime('%s','now'))
         ON CONFLICT(abbreviation) DO UPDATE SET
           full_name = excluded.full_name, updated_at = excluded.updated_at`
      );
      const del = db.prepare('DELETE FROM release_groups WHERE abbreviation = ?');
      const renameDoors = db.prepare(
        `UPDATE door_catalog SET release_group = ?, indexed_at = strftime('%s','now')
         WHERE release_group = ? COLLATE NOCASE`
      );
      const write = db.transaction(() => {
        for (const { oldAbbr, fullName, newAbbr } of parsed) {
          if (fullName === null || fullName === '') {
            del.run(oldAbbr);
            renameDoors.run(null, oldAbbr);
            recordAudit(db, req.admin?.id ?? null, 'edit-release-group', oldAbbr, { removed: true });
            continue;
          }
          const renamed = newAbbr !== oldAbbr;
          if (renamed) {
            const existing = lookup.get(newAbbr) as { full_name: string } | undefined;
            if (existing) {
              res.status(409).json({ error: `a group called "${newAbbr}" already exists` });
              throw new Error('abbreviation-collision');
            }
            const oldRow = lookup.get(oldAbbr) as { full_name: string } | undefined;
            if (oldRow) {
              del.run(oldAbbr);
              renameDoors.run(newAbbr, oldAbbr);
            }
            upsert.run(newAbbr, fullName);
            recordAudit(db, req.admin?.id ?? null, 'edit-release-group', oldAbbr, { renamed_to: newAbbr, full_name: fullName });
          } else {
            upsert.run(oldAbbr, fullName);
            recordAudit(db, req.admin?.id ?? null, 'edit-release-group', oldAbbr, { full_name: fullName });
          }
        }
      });
      try {
        write();
      } catch (e) {
        if ((e as Error).message === 'abbreviation-collision') return;
        throw e;
      }
      res.json({ ok: true, groups: parsed.map((p) => p.newAbbr) });
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

  // ─── authors (multi-value: stored as JSON array in the author column) ────

  /** Parse the author column into an array. Legacy rows hold a single name
   *  in plain text - return that as a one-element array so the UI is uniform. */
  function readAuthors(raw: string | null | undefined): string[] {
    if (!raw) return [];
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
        }
      } catch {
        // fall through to legacy handling
      }
    }
    return [trimmed];
  }

  router.get('/doors/:archiveName/authors', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const db = openDb(cfg, { readonly: true });
    try {
      const row = db
        .prepare('SELECT id, author FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string; author: string | null } | undefined;
      if (!row) { res.status(404).json({ error: 'no such door' }); return; }
      res.json({ authors: readAuthors(row.author) });
    } finally {
      db.close();
    }
  });

  router.patch('/doors/:archiveName/authors', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const archiveName = Array.isArray(req.params.archiveName) ? '' : req.params.archiveName;
    const body = (req.body ?? {}) as { authors?: unknown };
    if (!Array.isArray(body.authors)) {
      res.status(400).json({ error: 'authors must be an array of strings' });
      return;
    }
    const authors = body.authors
      .filter((s): s is string => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // Dedupe (case-insensitive) so the UI can be lazy about it
    const seen = new Set<string>();
    const unique = authors.filter((a) => {
      const k = a.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const db = openDb(cfg);
    try {
      const row = db
        .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
        .get(archiveName) as { id: string } | undefined;
      if (!row) { res.status(404).json({ error: 'no such door' }); return; }

      const stored = unique.length === 0 ? null : JSON.stringify(unique);
      db.prepare(
        `UPDATE door_catalog SET author = ?, indexed_at = strftime('%s','now') WHERE id = ?`
      ).run(stored, row.id);
      recordAudit(db, req.admin?.id ?? null, 'edit-authors', archiveName, { authors: unique });
      res.json({ ok: true, authors: unique });
    } finally {
      db.close();
    }
  });

  return router;
}
