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
import { readLhaContents, readZipContents } from './archive-reader';
import { repackLzxToLha } from './repack-lzx';
import {
  analyseDoor,
  buildGroupTags,
  clean,
  displayName,
  looksLikeHandle,
  stripVersionTail,
  looksLikeName,
  toPlain,
} from './describe';
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

/**
 * What the submitter typed, as opposed to what the archive says about
 * itself. Every field is optional and trimmed; an empty one means "let the
 * classifier's guess stand" (see mergeOverrides below), not "publish an
 * empty string" - a submitter leaving a field blank is not the same claim
 * as a submitter typing nothing on purpose.
 */
export interface SubmitterOverrides {
  name: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
  requiresBbs: string | null;
}

export interface ReceivedUpload {
  submittedName: string;
  note: string | null;
  overrides: SubmitterOverrides;
  bytes: Buffer;
}

const FIELD_CAPS: Record<keyof SubmitterOverrides, number> = {
  name: 100,
  description: 500,
  version: 40,
  author: 100,
  requiresBbs: 200,
};

/**
 * Read one multipart file plus the optional note and metadata-override
 * fields, refusing anything over the limit WHILE it arrives. Kept in
 * memory: the cap is 8 MB, and holding it means a rejected upload never
 * touches the disk at all.
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
    const overrides: SubmitterOverrides = {
      name: null,
      description: null,
      version: null,
      author: null,
      requiresBbs: null,
    };
    let failed = false;

    const fail = (error: UploadError) => {
      if (failed) return;
      failed = true;
      req.unpipe(busboy);
      reject(error);
    };

    busboy.on('field', (name, value) => {
      if (name === 'note') {
        note = value.slice(0, 500);
        return;
      }
      if (name === 'needs') {
        // "needs" on the wire (the form label a submitter sees), requiresBbs internally (matches DerivedMetadata's own field name).
        const trimmed = value.trim();
        overrides.requiresBbs = trimmed ? trimmed.slice(0, FIELD_CAPS.requiresBbs) : null;
        return;
      }
      if (name === 'name' || name === 'description' || name === 'version' || name === 'author') {
        const trimmed = value.trim();
        overrides[name] = trimmed ? trimmed.slice(0, FIELD_CAPS[name]) : null;
      }
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
      resolve({ submittedName, note, overrides, bytes: Buffer.concat(chunks) });
    });

    req.pipe(busboy);
  });
}

// ─── what the archive says about itself ────────────────────────────────

/**
 * The member most likely to BE the door: an Amiga executable has no
 * extension at all, or one of the door-type extensions. Documentation,
 * icons and data files are not it.
 */
const PROGRAM_EXT = /\.(exe|xim|aim|fim|sim|tim|iim|rexx)$/i;
const NOT_PROGRAM = /\.(info|doc|txt|readme|me|guide|diz|nfo|dat|cfg|prefs|bak|library|font|iff|ilbm|png|gif|jpg|mod|8svx)$/i;
/** Known ad/installer binaries that are never the door itself. */
const AD_BINARY = /^(LE-win|Setup|Install|ad-|ad_|-ad)/i;

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickProgram(files: { path: string; size: number }[], diz: string | null): string | null {
  const candidates = files.filter((f) => {
    const base = f.path.split('/').pop() ?? '';
    if (!base || NOT_PROGRAM.test(base)) return false;
    if (AD_BINARY.test(base)) return false;
    return PROGRAM_EXT.test(base) || !base.includes('.');
  });
  if (!candidates.length) return null;

  // A door ships helpers, and "the biggest member" picks the wrong one often
  // enough to matter: MST-KB13 ships an "ExTract" utility larger than the
  // door itself. The DIZ names the door, so a member the DIZ mentions wins
  // over a member it does not.
  const dizText = squash(diz ?? '');
  const named = candidates.filter((f) => {
    const base = squash((f.path.split('/').pop() ?? '').replace(PROGRAM_EXT, ''));
    return base.length >= 3 && dizText.includes(base);
  });
  const pool = named.length ? named : candidates;
  const best = pool.reduce((a, b) => (b.size > a.size ? b : a));
  return best.path.split('/').pop() ?? null;
}

/**
 * The first line of a DIZ that reads as a door's name.
 *
 * Not merely the first line that is not art: the top of a scene DIZ is the
 * group's, and its first legible cell is usually a handle. Live proof -
 * MST-MT21.LHA's first readable line is "bObO/mYStiC", which is the coder,
 * and taking it named the door after him.
 */
function firstNameLine(diz: string | null): string | null {
  if (!diz) return null;

  // 1. Try to find the title directly using the DIZ pattern: |..Title..|
  const directMatch = diz.match(/\|\.\.(.+?)\.\.\|/);
  if (directMatch && directMatch[1]) {
    const candidate = toPlain(clean(directMatch[1]));
    if (looksLikeName(candidate)) return candidate;
  }

  const candidates: string[] = [];
  const creditWords = new Set(['DEVELOPMENT', 'DESIGN', 'PRESENTS', 'CODED', 'WRITTEN']);
  
  for (const line of diz.split(/[\r\n\x00-\x1f]+/)) {
    if (!/[A-Za-zÀ-ÿ0-9]/.test(line)) continue;
    
    for (const cell of line.split(/[|¦]+/)) {
      const candidate = toPlain(clean(cell));
      if (!looksLikeName(candidate) || looksLikeHandle(candidate)) continue;
      if (!/[A-Za-zÀ-ÿ]{3}/.test(candidate)) continue;
      
      const upper = candidate.toUpperCase();
      if (upper.split(/\s+/).some(word => creditWords.has(word))) continue;

      candidates.push(candidate);
    }
  }
  
  return candidates.length > 0 ? candidates.reduce((a, b) => a.length > b.length ? a : b) : null;
}

export interface DerivedMetadata {
  name: string;
  description: string;
  version: string;
  author: string;
  requiresBbs: string;
  binaryName: string | null;
  fileIdDiz: string | null;
  docFilename: string | null;
  doc: string | null;
  files: { path: string; size: number }[];
  /** True when the submitter typed at least one of name/description/
   *  version/author/requiresBbs themselves, rather than every field being
   *  the classifier's guess. The admin console's "no FILE_ID.DIZ, these
   *  are guesses" warning is misleading when a human filled fields in by
   *  hand with no DIZ present - this is what lets it say something true
   *  instead. */
  submitterProvided: boolean;
}

/**
 * Overlays what a submitter typed onto what the classifier guessed. A
 * blank/whitespace-only override is treated as "no opinion" - see
 * SubmitterOverrides' own doc comment for why an empty string is not a
 * request to publish an empty field.
 */
export function mergeOverrides(derived: DerivedMetadata, overrides: SubmitterOverrides): DerivedMetadata {
  const merged = { ...derived };
  let any = false;
  if (overrides.name) { merged.name = overrides.name; any = true; }
  if (overrides.description) { merged.description = overrides.description; any = true; }
  if (overrides.version) { merged.version = overrides.version; any = true; }
  if (overrides.author) { merged.author = overrides.author; any = true; }
  if (overrides.requiresBbs) { merged.requiresBbs = overrides.requiresBbs; any = true; }
  merged.submitterProvided = any;
  return merged;
}

/**
 * Read a submitted archive the way the catalog reads a scanned one, so an
 * approved door arrives with its Name, Version, Description, Needs and
 * Author already filled in rather than as an empty row waiting for the next
 * corpus scan.
 *
 * LHA and ZIP can be read here (see ./archive-reader). For anything else
 * the fields come back empty and a curator fills them in.
 */
export function deriveMetadata(bytes: Buffer, archiveName: string, groupTags: ReadonlySet<string>): DerivedMetadata {
  const kind = sniffArchive(bytes.subarray(0, 16));
  const contents = kind === 'lha' ? readLhaContents(bytes)
    : kind === 'zip' ? readZipContents(bytes)
    : { files: [], fileIdDiz: null, docFilename: null, doc: null };

  const binaryName = pickProgram(contents.files, contents.fileIdDiz);
  const facts = analyseDoor(
    {
      dizText: contents.fileIdDiz,
      name: firstNameLine(contents.fileIdDiz),
      archiveName,
      binaryName,
    },
    groupTags
  );

  // For a submission the PROGRAM name is the better source: the archive's
  // own member list is unambiguous, while the top of a scene DIZ is the
  // group's business card - MST-JC40's first legible cell is
  // "MYSTiC /X-POWER", which is a group and a BBS, not a door. The DIZ line
  // is used only when the archive ships nothing that looks like a program.
  const named = binaryName
    ? displayName(null, binaryName, archiveName, groupTags)
    : displayName(firstNameLine(contents.fileIdDiz), null, archiveName, groupTags);

  return {
    // "Account Ed V1.03" - the version has its own column.
    name: stripVersionTail(named, facts.version) || named,
    description: facts.description,
    version: facts.version,
    author: facts.author,
    requiresBbs: facts.requiresBbs,
    binaryName,
    fileIdDiz: contents.fileIdDiz,
    docFilename: contents.docFilename,
    doc: contents.doc,
    files: contents.files,
    submitterProvided: false,
  };
}

export interface StoredSubmission {
  id: string;
  archiveName: string;
  size: number;
  md5: string;
  sha256: string;
  derived: DerivedMetadata;
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

  const known = db
    .prepare(
      `SELECT c.archive_name AS archiveName, h.catalog_id IS NOT NULL AS isHidden
         FROM door_catalog c
         LEFT JOIN door_hidden h ON h.catalog_id = c.id
        WHERE c.sha256 = ?`
    )
    .get(sha256) as { archiveName: string; isHidden: number } | undefined;
  if (known) {
    // Hiding is deliberately non-destructive (a corpus re-scan would
    // otherwise resurrect a "deleted" row), so the catalog row - and its
    // sha256 - never actually goes away. A curator hitting this after
    // hiding the archive needs to be told restoring is the one click that
    // fixes it, not left staring at a message that reads like the upload
    // vanished for no reason.
    const hint = known.isHidden
      ? `it is hidden, not gone - restore it from the Removed panel instead of re-uploading`
      : `as ${known.archiveName}`;
    throw new UploadError(`the repository already has that archive, ${hint}`, 409);
  }
  const queued = db
    .prepare("SELECT archive_name FROM door_submissions WHERE sha256 = ? AND status = 'pending'")
    .get(sha256) as { archive_name: string } | undefined;
  if (queued) {
    throw new UploadError(`that archive is already waiting to be looked at, as ${queued.archive_name}`, 409);
  }

  // Read now, not at approval: a curator should see what the archive says
  // about itself while deciding, and reading is cheap while the bytes are
  // already in memory.
  const groupTags = buildGroupTags(
    (db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[]).map(
      (r) => r.archive_name
    )
  );
  const derived = mergeOverrides(deriveMetadata(upload.bytes, archiveName, groupTags), upload.overrides);

  const id = crypto.randomUUID();
  const dir = ensureQuarantine(cfg);
  // Named after the submission, NOT after anything the submitter chose.
  const quarantinePath = path.join(dir, `${id}.bin`);
  fs.writeFileSync(quarantinePath, upload.bytes);

  db.prepare(
    `INSERT INTO door_submissions
       (id, archive_name, quarantine_path, size, md5, sha256, submitter_note, submitter_ip, status,
        parsed_name, parsed_diz, parsed_files)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(
    id,
    archiveName,
    quarantinePath,
    upload.bytes.length,
    md5,
    sha256,
    upload.note,
    ip,
    JSON.stringify(derived),
    derived.fileIdDiz,
    JSON.stringify(derived.files)
  );

  return { id, archiveName, size: upload.bytes.length, md5, sha256, derived };
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
  parsed_name: string | null;
  parsed_diz: string | null;
  parsed_files: string | null;
}

/** The metadata read from the archive when it arrived, or nothing. */
export function derivedOf(row: SubmissionRow): DerivedMetadata | null {
  if (!row.parsed_name) return null;
  try {
    return JSON.parse(row.parsed_name) as DerivedMetadata;
  } catch {
    return null;
  }
}

/**
 * Accept a submission into the repository: the file moves out of quarantine
 * into the archive root and a catalog row appears, carrying what the archive
 * said about itself when it arrived - name, version, author, which BBS it
 * needs, its FILE_ID.DIZ, its documentation and its file list.
 *
 * An LZX or DMS submission has none of that (only LHA can be read here), so
 * those rows arrive with the archive's own name and empty fields for a
 * curator to fill in.
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
  let archiveName = row.archive_name;
  let relativePath = path.posix.join('Submitted', archiveName);
  let destination = path.join(cfg.archivesRoot, 'Submitted', archiveName);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  // LZX archives can't be read by the doorserver — repack as LHA on approval.
  const ext = path.extname(archiveName).toLowerCase();
  if (ext === '.lzx' || ext === '.lzh') {
    const repacked = repackLzxToLha(row.quarantine_path);
    if (!repacked.ok) {
      throw new UploadError(`failed to repack ${ext.toUpperCase()}: ${repacked.error}`, 422);
    }
    // Replace quarantine file with the repacked LHA
    fs.unlinkSync(row.quarantine_path);
    fs.copyFileSync(repacked.outputPath!, row.quarantine_path);
    fs.unlinkSync(repacked.outputPath!);
    // Update name to .lha
    archiveName = archiveName.replace(/\.(lzx|lzh)$/i, '.lha');
    relativePath = path.posix.join('Submitted', archiveName);
    destination = path.join(cfg.archivesRoot, 'Submitted', archiveName);
  }

  const catalogId = crypto.randomUUID();
  const derived = derivedOf(row);
  const files = derived?.files ?? [];

  const commit = db.transaction(() => {
    // Everything the archive said about itself when it arrived: an approved
    // door is a first-class row, not a placeholder waiting for a re-scan.
    db.prepare(
      `INSERT INTO door_catalog
         (id, archive_name, archive_path, name, binary_name, door_type, version, author,
          requires_bbs, description, file_id_diz, doc_filename, doc_raw,
          archive_size, md5, sha256, source, indexed_at)
       VALUES (?, ?, ?, ?, ?, 'XIM', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submission', strftime('%s','now'))`
    ).run(
      catalogId,
      archiveName,
      relativePath,
      derived?.name || path.basename(archiveName, path.extname(archiveName)),
      derived?.binaryName ?? null,
      derived?.version || null,
      derived?.author || null,
      derived?.requiresBbs || null,
      derived?.description || null,
      derived?.fileIdDiz ?? null,
      derived?.docFilename ?? null,
      derived?.doc ?? null,
      row.size,
      row.md5,
      row.sha256
    );
    if (files.length) {
      const addFile = db.prepare(
        'INSERT OR REPLACE INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason) VALUES (?, ?, ?, 0, NULL)'
      );
      for (const file of files) addFile.run(catalogId, file.path, file.size);
    }
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

  return { archiveName, catalogId };
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
