/**
 * Reading what is inside a submitted archive, without unpacking it to disk.
 *
 * A door sent in by a stranger arrives as a single file. Everything a
 * listing wants to say about it - its name, version, author, which BBS it
 * needs, what it does - is inside, in FILE_ID.DIZ. Publishing a row with all
 * of that empty and waiting for the next corpus scan makes the repository
 * worse for as long as the wait lasts.
 *
 * The LHA decoder is lha.js by Stuart Caie, the same library the BBS
 * unpacks with (amiexpress-web: web/backend/src/utils/lha.js), copied
 * rather than reimplemented. The ZIP reader below is hand-written: Node has
 * no built-in ZIP container parser, and pulling in a dependency for a
 * central-directory walk plus zlib inflate (Node's own `zlib` already does
 * the decompression) is more machinery than the format needs. Both readers
 * work in memory: a submission is at most 8 MB and nothing is written until
 * a curator says so.
 *
 * LHA, ZIP, and LZX (via WASM). DMS is a whole-disk format never used to
 * distribute doors; for those the fields stay empty and a curator fills
 * them in, which the console is for.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { spawnSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LHA = require('./lha.js') as {
  read: (data: Uint8Array) => LhaEntry[];
  unpack: (entry: LhaEntry) => Uint8Array | null;
};

interface LhaEntry {
  name: string;
  length: number;
  data?: unknown;
}

export interface ArchiveContents {
  /** Every member, in the archive's own order, as relative paths. */
  files: { path: string; size: number }[];
  /** The FILE_ID.DIZ text, Latin-1 decoded, or null. */
  fileIdDiz: string | null;
  /** The .guide or .doc/.readme, if the archive carries one. */
  docFilename: string | null;
  doc: string | null;
}

const DIZ_NAME = /(^|\/)file_id\.diz$/i;
const DOC_NAME = /\.(guide|doc|readme|txt|me)$/i;

/** A system `lha` binary, used as a fallback when the in-memory JS reader
 *  fails on a compression level it doesn't support (e.g. lh0, lh4, lh6). */
function findSystemLha(): string | null {
  for (const candidate of ['/opt/homebrew/bin/lha', '/usr/local/bin/lha', '/usr/bin/lha']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Run `lha lq` against a file and return one line per member:
 *  "<size> <month> <day> <year> <filename>". Returns [] on any error.
 *  `lha` exits non-zero when it cannot read a header (corrupt members,
 *  unknown compression levels) but still prints every member it CAN read,
 *  so we accept any non-empty listing. */
function listLhaViaSystem(bin: string, archivePath: string): { size: number; name: string }[] {
  const r = spawnSync(bin, ['lq', archivePath], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (!r.stdout) return [];
  const out: { size: number; name: string }[] = [];
  for (const raw of r.stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[[^\]]+\]\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (m) {
      const size = Number(m[1]);
      const name = m[2].trim();
      if (name && !name.endsWith('/')) out.push({ size, name });
      continue;
    }
    const m2 = /^\[unknown\]\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (m2) {
      const size = Number(m2[1]);
      const name = m2[2].trim();
      if (name && !name.endsWith('/')) out.push({ size, name });
    }
  }
  return out;
}

/** Extract one member from an LHA via the system binary, returns raw bytes
 *  or null on failure. Streams to a temp file to handle binary members
 *  safely (no shell, no encoding). */
function extractLhaMemberViaSystem(bin: string, archivePath: string, member: string): Buffer | null {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lha-extract-'));
  try {
    const r = spawnSync(bin, ['xq', archivePath, member], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    if (r.status !== 0) return null;
    const extracted = path.join(tmpDir, member);
    if (!fs.existsSync(extracted)) return null;
    return fs.readFileSync(extracted);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** AmigaDOS writes "Work:Doors\Thing", and a member path must stay relative. */
function relativeName(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z0-9_.-]*:/, '')
    .replace(/^\/+/, '');
}

function decodeLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

/**
 * Read an LHA archive's member list and its documentation. Never throws: a
 * submission that cannot be read is still a submission, and a curator can
 * look at it by hand.
 *
 * Falls back to the system `lha` binary when the in-memory JS reader
 * returns no members - some LHA levels (lh0, lh6, lh7, ...) are not
 * supported by lha.js. The system binary handles them all.
 */
export function readLhaContents(bytes: Buffer, sourcePath?: string): ArchiveContents {
  const empty: ArchiveContents = { files: [], fileIdDiz: null, docFilename: null, doc: null };
  let entries: LhaEntry[];
  try {
    entries = LHA.read(new Uint8Array(bytes));
  } catch {
    entries = [];
  }

  const files: { path: string; size: number }[] = [];
  let fileIdDiz: string | null = null;
  let docFilename: string | null = null;
  let doc: string | null = null;
  let docSize = 0;

  for (const entry of entries) {
    const path = relativeName(entry.name || '');
    if (!path || path.endsWith('/')) continue;
    files.push({ path, size: entry.length ?? 0 });

    const wantsDiz = DIZ_NAME.test(path) && fileIdDiz === null;
    const wantsDoc = DOC_NAME.test(path) && (entry.length ?? 0) > docSize;
    if (!wantsDiz && !wantsDoc) continue;

    let unpacked: Uint8Array | null = null;
    try {
      unpacked = LHA.unpack(entry);
    } catch {
      continue;
    }
    if (!unpacked) continue;

    if (wantsDiz) {
      fileIdDiz = decodeLatin1(unpacked);
    } else if (wantsDoc) {
      doc = decodeLatin1(unpacked);
      docFilename = path;
      docSize = entry.length ?? 0;
    }
  }

  if (files.length > 0 || !sourcePath) {
    return { files, fileIdDiz, docFilename, doc };
  }

  // Fallback: ask the system lha to list members. The same archive may
  // carry compression levels (lh0/lh6/...) lha.js refuses, while the
  // installed `lha` binary handles them. We need sourcePath here because
  // the binary reads the file by name, not from a buffer.
  const bin = findSystemLha();
  if (!bin) return { files, fileIdDiz, docFilename, doc };
  const members = listLhaViaSystem(bin, sourcePath);
  if (members.length === 0) return { files, fileIdDiz, docFilename, doc };

  for (const m of members) {
    const rel = relativeName(m.name);
    if (!rel || rel.endsWith('/')) continue;
    if (!files.some((f) => f.path === rel)) files.push({ path: rel, size: m.size });
  }

  // Pull the DIZ and the largest .guide/.doc/.readme/.txt/.me member.
  for (const m of members) {
    const rel = relativeName(m.name);
    if (!rel || rel.endsWith('/')) continue;
    if (!fileIdDiz && DIZ_NAME.test(rel)) {
      const data = extractLhaMemberViaSystem(bin, sourcePath, m.name);
      if (data) fileIdDiz = decodeLatin1(data);
    } else if (DOC_NAME.test(rel) && m.size > docSize) {
      const data = extractLhaMemberViaSystem(bin, sourcePath, m.name);
      if (data) {
        doc = decodeLatin1(data);
        docFilename = rel;
        docSize = m.size;
      }
    }
  }

  return { files, fileIdDiz, docFilename, doc };
}

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;
/** The fixed part of an EOCD record; a variable-length comment (0-65535
 *  bytes) can follow it, which is why finding it means searching backward
 *  from the end rather than trusting a fixed offset. */
const ZIP_EOCD_MIN_LEN = 22;
/** The fixed part of a central directory file header, before its
 *  variable-length name/extra/comment fields. */
const ZIP_CENTRAL_MIN_LEN = 46;
/** The fixed part of a local file header, before its variable-length
 *  name/extra fields - this is what actually precedes a member's data,
 *  and can differ from the central directory's copy of the same fields. */
const ZIP_LOCAL_MIN_LEN = 30;

interface ZipCentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Every read below is bounds-checked before it happens, never after - a
 *  hand-rolled binary-format walk over an untrusted upload is exactly
 *  where an unchecked Buffer.readUInt32LE would throw a RangeError on a
 *  truncated or hostile file, and every parse in this file promises never
 *  to throw. */
function readZipCentralDirectory(bytes: Buffer): ZipCentralEntry[] | null {
  if (bytes.length < ZIP_EOCD_MIN_LEN) return null;

  let eocdOffset = -1;
  const searchFloor = Math.max(0, bytes.length - ZIP_EOCD_MIN_LEN - 65535);
  for (let i = bytes.length - ZIP_EOCD_MIN_LEN; i >= searchFloor; i--) {
    if (bytes.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return null;

  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = bytes.readUInt32LE(eocdOffset + 16);

  const entries: ZipCentralEntry[] = [];
  let p = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + ZIP_CENTRAL_MIN_LEN > bytes.length) return null;
    if (bytes.readUInt32LE(p) !== ZIP_CENTRAL_SIG) return null;

    const method = bytes.readUInt16LE(p + 10);
    const compressedSize = bytes.readUInt32LE(p + 20);
    const uncompressedSize = bytes.readUInt32LE(p + 24);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const localHeaderOffset = bytes.readUInt32LE(p + 42);

    const nameStart = p + ZIP_CENTRAL_MIN_LEN;
    if (nameStart + nameLen > bytes.length) return null;
    const name = bytes.toString('latin1', nameStart, nameStart + nameLen);

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Reads one member's raw bytes via its OWN local file header (not the
 *  central directory's copy of name/extra field lengths, which the ZIP
 *  spec allows to differ) - this is what actually locates the data. */
function readZipMember(bytes: Buffer, entry: ZipCentralEntry): Uint8Array | null {
  const p = entry.localHeaderOffset;
  if (p + ZIP_LOCAL_MIN_LEN > bytes.length) return null;
  if (bytes.readUInt32LE(p) !== ZIP_LOCAL_SIG) return null;

  const nameLen = bytes.readUInt16LE(p + 26);
  const extraLen = bytes.readUInt16LE(p + 28);
  const dataStart = p + ZIP_LOCAL_MIN_LEN + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart > bytes.length || dataEnd > bytes.length) return null;

  const compressed = bytes.subarray(dataStart, dataEnd);
  if (entry.method === 0) {
    return new Uint8Array(compressed);
  }
  if (entry.method === 8) {
    try {
      return new Uint8Array(zlib.inflateRawSync(compressed));
    } catch {
      return null;
    }
  }
  // Any other method (bzip2, LZMA, AES-encrypted, ...) is rare for a scene
  // door archive and unsupported here - the member is listed (its name and
  // declared size are still useful) but its content is not read.
  return null;
}

/**
 * Read a ZIP archive's member list and its documentation, via the central
 * directory (the archive's own table of contents) rather than scanning for
 * local headers one at a time. Never throws, same contract as
 * readLhaContents(): a submission that cannot be read is still a
 * submission, and a curator can look at it by hand.
 */
export function readZipContents(bytes: Buffer): ArchiveContents {
  const empty: ArchiveContents = { files: [], fileIdDiz: null, docFilename: null, doc: null };
  let entries: ZipCentralEntry[] | null;
  try {
    entries = readZipCentralDirectory(bytes);
  } catch {
    entries = null;
  }
  if (!entries) return empty;

  const files: { path: string; size: number }[] = [];
  let fileIdDiz: string | null = null;
  let docFilename: string | null = null;
  let doc: string | null = null;
  // The largest document wins, same rule as the LHA reader: an archive
  // often ships both a one-line .readme and the real .guide.
  let docSize = 0;

  for (const entry of entries) {
    const path = relativeName(entry.name || '');
    if (!path || path.endsWith('/')) continue;
    files.push({ path, size: entry.uncompressedSize });

    const wantsDiz = DIZ_NAME.test(path) && fileIdDiz === null;
    const wantsDoc = DOC_NAME.test(path) && entry.uncompressedSize > docSize;
    if (!wantsDiz && !wantsDoc) continue;

    let unpacked: Uint8Array | null;
    try {
      unpacked = readZipMember(bytes, entry);
    } catch {
      // One member failing to unpack says nothing about the others.
      continue;
    }
    if (!unpacked) continue;

    if (wantsDiz) {
      fileIdDiz = decodeLatin1(unpacked);
    } else if (wantsDoc) {
      doc = decodeLatin1(unpacked);
      docFilename = path;
      docSize = entry.uncompressedSize;
    }
  }

  return { files, fileIdDiz, docFilename, doc };
}

// ─── LZX via WASM ───────────────────────────────────────────────────────────

let lzxWasm: any = null;

function getLzxWasm(): any {
  if (!lzxWasm) {
    const pkgPath = path.join(__dirname, '..', '..', 'wasm', 'lzx', 'lzx_wasm');
    try {
      lzxWasm = require(pkgPath);
    } catch {
      // WASM module not available — LZX support disabled
      return null;
    }
  }
  return lzxWasm;
}

/**
 * Read an LZX archive's member list and its documentation via the Rust/WASM
 * lzx_wasm module. Same contract as readLhaContents/readZipContents: never
 * throws, returns an empty result on failure.
 */
export function readLzxContents(bytes: Buffer): ArchiveContents {
  const empty: ArchiveContents = { files: [], fileIdDiz: null, docFilename: null, doc: null };
  const wasm = getLzxWasm();
  if (!wasm) return empty;

  let entries: Array<{ name: string; data: number[] }>;
  try {
    const json = wasm.lzx_extract_all(new Uint8Array(bytes)) as string;
    entries = JSON.parse(json);
  } catch {
    return empty;
  }

  const files: { path: string; size: number }[] = [];
  let fileIdDiz: string | null = null;
  let docFilename: string | null = null;
  let doc: string | null = null;
  let docSize = 0;

  for (const entry of entries) {
    const entryPath = relativeName(entry.name || '');
    if (!entryPath || entryPath.endsWith('/')) continue;
    const dataSize = entry.data?.length ?? 0;
    files.push({ path: entryPath, size: dataSize });

    const buf = Buffer.from(entry.data);
    const wantsDiz = DIZ_NAME.test(entryPath) && fileIdDiz === null;
    const wantsDoc = DOC_NAME.test(entryPath) && dataSize > docSize;
    if (!wantsDiz && !wantsDoc) continue;

    if (wantsDiz) {
      fileIdDiz = decodeLatin1(new Uint8Array(buf));
    } else if (wantsDoc) {
      doc = decodeLatin1(new Uint8Array(buf));
      docFilename = entryPath;
      docSize = dataSize;
    }
  }

  return { files, fileIdDiz, docFilename, doc };
}

/**
 * Extract a single file from an LZX archive by name via WASM.
 */
export function extractLzxFile(bytes: Buffer, memberPath: string): Uint8Array | null {
  const wasm = getLzxWasm();
  if (!wasm) return null;

  let entries: Array<{ name: string; data: number[] }>;
  try {
    const json = wasm.lzx_extract_all(new Uint8Array(bytes)) as string;
    entries = JSON.parse(json);
  } catch {
    return null;
  }

  const target = memberPath.toLowerCase();
  for (const entry of entries) {
    const path = relativeName(entry.name || '').toLowerCase();
    if (path === target) {
      return new Uint8Array(entry.data);
    }
  }
  return null;
}

/**
 * Heuristic: does this byte buffer look like printable text?
 *
 * Amiga doors and their DIZs are Latin-1: bytes 0x00-0x7F are ASCII,
 * bytes 0x80-0xFF hold accented letters and box-drawing characters that
 * show up in scene art. A null byte (0x00) is the strongest binary
 * signal — a real text file basically never contains one. Beyond that
 * we accept anything that isn't a C0 control character; high-bit
 * characters are normal Latin-1.
 *
 * Returns true for empty buffers (vacuously text - the UI shows an
 * empty doc, not a binary error).
 */
export function looksLikeText(buf: Buffer | Uint8Array | null | undefined): boolean {
  if (!buf || buf.length === 0) return true;
  const limit = Math.min(buf.length, 2048);
  let controlCount = 0;
  for (let i = 0; i < limit; i++) {
    const b = buf[i];
    if (b === 0x00) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) {
      controlCount++;
    }
  }
  // Tolerate a stray control char (line noise from scene editors) but
  // reject a buffer that's mostly controls (clearly binary).
  return controlCount / limit < 0.1;
}

/**
 * Extract a single file from an LHA or ZIP archive. Returns the decompressed
 * bytes, or null if the member is not found or cannot be decoded.
 */
export function extractFile(bytes: Buffer, memberPath: string): Uint8Array | null {
  const target = memberPath.toLowerCase();

  // Try LHA
  let entries: LhaEntry[];
  try {
    entries = LHA.read(new Uint8Array(bytes));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const path = relativeName(entry.name || '').toLowerCase();
    if (path === target) {
      try {
        return LHA.unpack(entry);
      } catch {
        return null;
      }
    }
  }

  // Try ZIP
  let zipEntries: ZipCentralEntry[] | null;
  try {
    zipEntries = readZipCentralDirectory(bytes);
  } catch {
    zipEntries = null;
  }
  if (zipEntries) {
    for (const entry of zipEntries) {
      const path = relativeName(entry.name).toLowerCase();
      if (path === target) {
        try {
          return readZipMember(bytes, entry);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}
