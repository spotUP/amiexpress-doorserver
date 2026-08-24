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
 * LHA and ZIP only. LZX needs a separate decoder the BBS runs as WASM, and
 * DMS is a whole-disk format never used to distribute doors; for those the
 * fields stay empty and a curator fills them in, which the console is for.
 */
import * as zlib from 'zlib';
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
 */
export function readLhaContents(bytes: Buffer): ArchiveContents {
  const empty: ArchiveContents = { files: [], fileIdDiz: null, docFilename: null, doc: null };
  let entries: LhaEntry[];
  try {
    entries = LHA.read(new Uint8Array(bytes));
  } catch {
    return empty;
  }

  const files: { path: string; size: number }[] = [];
  let fileIdDiz: string | null = null;
  let docFilename: string | null = null;
  let doc: string | null = null;
  // The largest document wins: an archive often ships both a one-line
  // .readme and the real .guide.
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
      // One member failing to unpack says nothing about the others; Amiga
      // archives routinely carry a member a strict reader rejects.
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
