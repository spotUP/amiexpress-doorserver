/**
 * Reading what is inside a submitted archive, without unpacking it to disk.
 *
 * A door sent in by a stranger arrives as a single file. Everything a
 * listing wants to say about it - its name, version, author, which BBS it
 * needs, what it does - is inside, in FILE_ID.DIZ. Publishing a row with all
 * of that empty and waiting for the next corpus scan makes the repository
 * worse for as long as the wait lasts.
 *
 * The decoder is lha.js by Stuart Caie, the same library the BBS unpacks
 * with (amiexpress-web: web/backend/src/utils/lha.js), copied rather than
 * reimplemented. Only the reading is written here, and it reads in memory:
 * a submission is at most 8 MB and nothing is written until a curator says
 * so.
 *
 * LHA only. LZX needs a separate decoder the BBS runs as WASM, and DMS is a
 * whole-disk format; for those the fields stay empty and a curator fills
 * them in, which the console is for.
 */
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
