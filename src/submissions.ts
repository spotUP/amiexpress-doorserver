/**
 * Doors sent in by strangers.
 *
 * Anyone may upload; nobody may publish. An upload lands in a quarantine
 * directory that no route serves, is recorded as `pending`, and becomes part
 * of the repository only when a curator approves it. Until then it is
 * invisible: not in the listing, not in list.txt, not downloadable.
 *
 * Everything a stranger controls is checked before it reaches disk:
 *
 *   - the byte count, mid-stream, so an oversized body is cut off rather
 *     than buffered;
 *   - the extension, against an allowlist;
 *   - the file's own magic bytes, because an extension is a claim, not
 *     evidence - a .lha that is really a shell script is refused;
 *   - the name, rebuilt from scratch rather than trusted (the file on disk
 *     is named after the submission id, never after what was uploaded);
 *   - the sha256, against the catalog and the queue, so the same archive
 *     cannot be sent twice;
 *   - how many that IP has already sent today.
 *
 * The rate limit here is not the rate limiting this project has rejected
 * elsewhere: that argument is about not locking out a BBS's own logged-in
 * users. This is an anonymous write endpoint on a public host.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Request } from 'express';
import Busboy from 'busboy';
import type Database from 'better-sqlite3';
import type { ServerConfig } from './config';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const DAILY_LIMIT_PER_IP = 10;

/** Where uploads wait. Beside the database, never inside the archive root. */
export function quarantineDir(cfg: ServerConfig): string {
  return path.join(path.dirname(cfg.dbPath), 'quarantine');
}

export function ensureQuarantine(cfg: ServerConfig): string {
  const dir = quarantineDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * What an Amiga door ships as. The extension is checked first because it is
 * cheap, and then disbelieved: `sniffArchive` has the final say.
 */
const ALLOWED_EXTENSIONS = new Set(['.lha', '.lzx', '.lzh', '.dms', '.zip']);

/**
 * The file's own first bytes. LHA/LZH carry their marker at offset 2
 * ("-lh5-", "-lz4-"...), LZX and DMS lead with theirs, ZIP is "PK\x03\x04".
 */
export function sniffArchive(head: Buffer): string | null {
  if (head.length >= 7 && head.toString('latin1', 2, 7).match(/^-l(h[0-7]|z[45s])-$/)) return 'lha';
  if (head.length >= 3 && head.toString('latin1', 0, 3) === 'LZX') return 'lzx';
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'DMS!') return 'dms';
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'PK\x03\x04') return 'zip';
  return null;
}

/**
 * A filename this server is willing to write. Rebuilt from the submitted
 * one rather than sanitised: anything not in the allowed set is dropped, so
 * no traversal, no separators, no control bytes can survive.
 */
export function safeArchiveName(submitted: string): string | null {
  const base = path.basename(submitted).replace(/[^A-Za-z0-9!$^&._-]/g, '');
  if (!base || base.length > 40 || base.startsWith('.')) return null;
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return null;
  return base;
}

/**
 * Read and throw away what is left of a request body, up to a budget, so the
 * client can finish sending and actually READ the refusal.
 *
 * Without this, answering 413 mid-upload closes the socket while the browser
 * is still writing, and the person sees a network error instead of "that
 * file is larger than 8 MB". The budget is there because the alternative -
 * draining whatever arrives - is an unbounded read from a stranger.
 */
export function discardBody(req: Request, budget = 2 * 1024 * 1024): void {
  let seen = 0;
  req.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > budget) req.destroy();
  });
  req.resume();
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface ReceivedUpload {
  submittedName: string;
  note: string | null;
  bytes: Buffer;
}

/**
 * Read one multipart file plus an optional note, refusing anything over the
 * limit WHILE it arrives. Kept in memory: the cap is 8 MB, and holding it
 * means a rejected upload never touches the disk at all.
 */
export function receiveUpload(req: Request): Promise<ReceivedUpload> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.get('content-length') ?? 0);
    if (declared > MAX_UPLOAD_BYTES * 1.1) {
      reject(new UploadError('that file is larger than 8 MB', 413));
      return;
    }

    let busboy: ReturnType<typeof Busboy>;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
    } catch {
      reject(new UploadError('expected a multipart upload', 400));
      return;
    }

    const chunks: Buffer[] = [];
    let submittedName: string | null = null;
    let note: string | null = null;
    let failed = false;

    const fail = (error: UploadError) => {
      if (failed) return;
      failed = true;
      req.unpipe(busboy);
      reject(error);
    };

    busboy.on('field', (name, value) => {
      if (name === 'note') note = value.slice(0, 500);
    });

    busboy.on('file', (_name, stream, info) => {
      submittedName = info.filename;
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => fail(new UploadError('that file is larger than 8 MB', 413)));
    });

    busboy.on('error', () => fail(new UploadError('that upload could not be read', 400)));
    busboy.on('close', () => {
      if (failed) return;
      if (!submittedName) {
        reject(new UploadError('no file was attached', 400));
        return;
      }
      resolve({ submittedName, note, bytes: Buffer.concat(chunks) });
    });

    req.pipe(busboy);
  });
}

export interface StoredSubmission {
  id: string;
  archiveName: string;
  size: number;
  md5: string;
  sha256: string;
}

/**
 * Validate an upload and put it in the queue. Throws UploadError with the
 * reason a person can act on - "that is not an Amiga archive" is more use
 * than "400".
 */
export function storeSubmission(
  db: Database.Database,
  cfg: ServerConfig,
  upload: ReceivedUpload,
  ip: string
): StoredSubmission {
  const archiveName = safeArchiveName(upload.submittedName);
  if (!archiveName) {
    throw new UploadError('a door has to be a .lha, .lzx, .lzh, .dms or .zip file', 400);
  }
  if (upload.bytes.length === 0) {
    throw new UploadError('that file is empty', 400);
  }
  if (upload.bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadError('that file is larger than 8 MB', 413);
  }
  if (!sniffArchive(upload.bytes.subarray(0, 16))) {
    // The extension said one thing; the bytes say another.
    throw new UploadError('that file is not an Amiga archive, whatever it is called', 400);
  }

  const sinceYesterday = (
    db
      .prepare("SELECT COUNT(*) AS n FROM door_submissions WHERE submitter_ip = ? AND created_at > strftime('%s','now') - 86400")
      .get(ip) as { n: number }
  ).n;
  if (sinceYesterday >= DAILY_LIMIT_PER_IP) {
    throw new UploadError('that is enough for one day; try again tomorrow', 429);
  }

  const sha256 = crypto.createHash('sha256').update(upload.bytes).digest('hex');
  const md5 = crypto.createHash('md5').update(upload.bytes).digest('hex');

  const known = db.prepare('SELECT archive_name FROM door_catalog WHERE sha256 = ?').get(sha256) as
    | { archive_name: string }
    | undefined;
  if (known) {
    throw new UploadError(`the repository already has that archive, as ${known.archive_name}`, 409);
  }
  const queued = db
    .prepare("SELECT archive_name FROM door_submissions WHERE sha256 = ? AND status = 'pending'")
    .get(sha256) as { archive_name: string } | undefined;
  if (queued) {
    throw new UploadError(`that archive is already waiting to be looked at, as ${queued.archive_name}`, 409);
  }

  const id = crypto.randomUUID();
  const dir = ensureQuarantine(cfg);
  // Named after the submission, NOT after anything the submitter chose.
  const quarantinePath = path.join(dir, `${id}.bin`);
  fs.writeFileSync(quarantinePath, upload.bytes);

  db.prepare(
    `INSERT INTO door_submissions
       (id, archive_name, quarantine_path, size, md5, sha256, submitter_note, submitter_ip, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(id, archiveName, quarantinePath, upload.bytes.length, md5, sha256, upload.note, ip);

  return { id, archiveName, size: upload.bytes.length, md5, sha256 };
}

export interface SubmissionRow {
  id: string;
  archive_name: string;
  quarantine_path: string;
  size: number;
  md5: string;
  sha256: string;
  submitter_note: string | null;
  status: string;
}

/**
 * Accept a submission into the repository: the file moves out of quarantine
 * into the archive root and a catalog row appears.
 *
 * The row is thin on purpose - archive, size, checksums, and the name the
 * submitter gave it. Everything else (FILE_ID.DIZ, the file list, the junk
 * flags) comes from the corpus builder, which unpacks archives; this server
 * does not, and inventing metadata it cannot read would be worse than
 * leaving the fields empty for the next scan to fill.
 */
export function approveSubmission(
  db: Database.Database,
  cfg: ServerConfig,
  id: string,
  adminId: number | null
): { archiveName: string; catalogId: string } {
  const row = db.prepare('SELECT * FROM door_submissions WHERE id = ?').get(id) as SubmissionRow | undefined;
  if (!row) throw new UploadError('no such submission', 404);
  if (row.status !== 'pending') throw new UploadError(`that submission is already ${row.status}`, 409);

  const clash = db
    .prepare('SELECT id FROM door_catalog WHERE archive_name = ? COLLATE NOCASE')
    .get(row.archive_name) as { id: string } | undefined;
  if (clash) {
    throw new UploadError(`the repository already has an archive called ${row.archive_name}`, 409);
  }

  // Submissions land in their own directory, so the corpus a scan walks and
  // the files strangers sent stay distinguishable on disk.
  const relativePath = path.posix.join('Submitted', row.archive_name);
  const destination = path.join(cfg.archivesRoot, 'Submitted', row.archive_name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const catalogId = crypto.randomUUID();
  const commit = db.transaction(() => {
    db.prepare(
      `INSERT INTO door_catalog
         (id, archive_name, archive_path, name, door_type, archive_size, md5, sha256, source, indexed_at)
       VALUES (?, ?, ?, ?, 'XIM', ?, ?, ?, 'submission', strftime('%s','now'))`
    ).run(
      catalogId,
      row.archive_name,
      relativePath,
      path.basename(row.archive_name, path.extname(row.archive_name)),
      row.size,
      row.md5,
      row.sha256
    );
    db.prepare(
      "UPDATE door_submissions SET status = 'approved', decided_by = ?, decided_at = strftime('%s','now') WHERE id = ?"
    ).run(adminId, id);
  });

  // The file moves BEFORE the transaction commits its catalog row, and the
  // row is rolled back if the move fails - a catalog entry pointing at a
  // file that is not there would 404 for every client.
  fs.renameSync(row.quarantine_path, destination);
  try {
    commit();
  } catch (error) {
    fs.renameSync(destination, row.quarantine_path);
    throw error;
  }

  return { archiveName: row.archive_name, catalogId };
}

/** Turn a submission down. The file is removed from quarantine. */
export function rejectSubmission(
  db: Database.Database,
  id: string,
  adminId: number | null,
  reason: string | null
): void {
  const row = db.prepare('SELECT * FROM door_submissions WHERE id = ?').get(id) as SubmissionRow | undefined;
  if (!row) throw new UploadError('no such submission', 404);
  if (row.status !== 'pending') throw new UploadError(`that submission is already ${row.status}`, 409);

  db.prepare(
    "UPDATE door_submissions SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = strftime('%s','now') WHERE id = ?"
  ).run(reason, adminId, id);
  fs.rmSync(row.quarantine_path, { force: true });
}
