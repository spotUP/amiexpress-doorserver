/**
 * Scene ad/junk detection and archive stripping engine.
 *
 * Ported from amiexpress-web/web/backend/src/doors/ami-stripper.lib.ts.
 * The classification logic (classifyFile, deriveStripPlan) is pure and
 * identical to the BBS-side original. Archive reading is adapted to use
 * this project's own archive-reader.ts (LHA + ZIP) instead of the full
 * extractor factory that amiexpress-web carries.
 *
 * Three detection tiers:
 *   1. Filename patterns (scene-strip-patterns.json — 5100+ globs)
 *   2. MD5 fingerprints (junk-fingerprints.json — 30+ known junk files)
 *   3. Content-scan signals (currently disabled for text files)
 *
 * Content-based protection (never stripped):
 *   - Workbench .info icons (magic 00 00 03 E7)
 *   - Amiga hunk binaries (magic 00 00 03 F3)
 *   - AmigaGuide .guide files (@database/@node)
 *   - Binary .cfg/.dat/.data/.stat/.config
 *   - file_id.diz (always preserved)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { readLhaContents, readZipContents, readLzxContents, extractLzxFile, type ArchiveContents } from './archive-reader';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const LHA = require('./lha.js') as {
  read: (data: Uint8Array) => Array<{ name: string; length: number; data?: unknown }>;
  unpack: (entry: { name: string; length: number; data?: unknown }) => Uint8Array | null;
};

const SEEDS_DIR = path.join(__dirname, '..', 'seeds');
const PATTERNS_JSON = path.join(SEEDS_DIR, 'scene-strip-patterns.json');
const FINGERPRINTS_JSON = path.join(SEEDS_DIR, 'junk-fingerprints.json');

export interface StripEntry {
  path: string;
  size: number;
  md5: string;
}

export interface StripResult {
  kept: StripEntry[];
  stripped: StripEntry[];
  reason: Record<string, 'pattern' | 'md5' | 'content-scan'>;
}

export interface StripArchiveResult extends StripResult {
  outputPath: string;
}

interface PatternDb {
  filenamePatterns: string[];
  dizPatterns: string[];
}

export interface FingerprintDb {
  [md5: string]: { filename: string; archiveCount: number };
}

function loadPatterns(): PatternDb {
  if (!fs.existsSync(PATTERNS_JSON)) {
    return { filenamePatterns: [], dizPatterns: [] };
  }
  return JSON.parse(fs.readFileSync(PATTERNS_JSON, 'utf-8'));
}

function loadFingerprints(): FingerprintDb {
  if (!fs.existsSync(FINGERPRINTS_JSON)) return {};
  return JSON.parse(fs.readFileSync(FINGERPRINTS_JSON, 'utf-8'));
}

// ─── Content validation ───────────────────────────────────────────────────────

const WORKBENCH_MAGIC = Buffer.from([0x00, 0x00, 0x03, 0xe7]);
const HUNK_MAGIC = Buffer.from([0x00, 0x00, 0x03, 0xf3]);

function isWorkbenchIcon(buf: Buffer): boolean {
  return buf.length >= 4 && buf.slice(0, 4).equals(WORKBENCH_MAGIC);
}

function isAmigaHunk(buf: Buffer): boolean {
  return buf.length >= 4 && buf.slice(0, 4).equals(HUNK_MAGIC);
}

function isAmigaGuide(buf: Buffer): boolean {
  const text = buf.slice(0, 512).toString('latin1').toLowerCase();
  return text.includes('@database') || text.includes('@node');
}

export function isTextFile(buf: Buffer): boolean {
  return !isBinaryContent(buf);
}

function isBinaryContent(buf: Buffer): boolean {
  for (let i = 0; i < Math.min(buf.length, 1024); i++) {
    const b = buf[i];
    if (b > 0x7e) return true;
    if (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09 && b !== 0x0c) return true;
  }
  return false;
}

const AD_SIGNAL_PATTERNS = [
  /\+\d{1,2}[\s-]\d+/,
  /\d{3}[-. ]\d{3,4}[-. ]\d{4}/,
  /call us/i,
  /greetings from/i,
  /visit us/i,
  /logon to/i,
  /connect to/i,
  /download here/i,
];

function hasAdSignals(buf: Buffer): boolean {
  const text = buf.toString('latin1');
  return AD_SIGNAL_PATTERNS.some(re => re.test(text));
}

function matchesPattern(filename: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  try {
    return new RegExp(regexStr, 'i').test(filename);
  } catch {
    return false;
  }
}

/**
 * Junk-detection verdict for a single file. Pure, no fs/network — shared
 * by analyzeArchive and stripArchive so classification exists in one place.
 */
export function classifyFile(
  name: string,
  buf: Buffer,
  filenamePatterns: string[],
  fingerprints: FingerprintDb
): 'pattern' | 'md5' | 'content-scan' | null {
  const base = path.basename(name).toLowerCase();
  const ext = path.extname(base);

  // Content-based protection
  if (ext === '.info' && isWorkbenchIcon(buf)) return null;
  if ((ext === '.library' || ext === '') && isAmigaHunk(buf)) return null;
  if (ext === '.guide' && isAmigaGuide(buf)) return null;
  if (['.cfg', '.dat', '.data', '.stat', '.config'].includes(ext) && isBinaryContent(buf)) return null;
  if (base === 'file_id.diz') return null;

  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  if (fingerprints[md5]) return 'md5';

  for (const pat of filenamePatterns) {
    if (matchesPattern(base, pat)) return 'pattern';
  }

  return null;
}

/**
 * Strip-plan derivation: sort entries into kept/stripped/reason.
 * Pure and synchronous — shared by analyzeArchive and stripArchive.
 */
export function deriveStripPlan(
  entries: Array<{ path: string; size: number; buf: Buffer }>,
  filenamePatterns: string[],
  fingerprints: FingerprintDb
): StripResult {
  const kept: StripEntry[] = [];
  const stripped: StripEntry[] = [];
  const reason: Record<string, 'pattern' | 'md5' | 'content-scan'> = {};

  for (const entry of entries) {
    const md5 = crypto.createHash('md5').update(entry.buf).digest('hex');
    const verdict = classifyFile(entry.path, entry.buf, filenamePatterns, fingerprints);
    if (verdict) {
      stripped.push({ path: entry.path, size: entry.size, md5 });
      reason[entry.path] = verdict;
    } else {
      kept.push({ path: entry.path, size: entry.size, md5 });
    }
  }

  return { kept, stripped, reason };
}

// ─── Archive reading via archive-reader.ts ────────────────────────────────────

function readArchiveContents(archivePath: string, bytes?: Buffer): ArchiveContents {
  const ext = path.extname(archivePath).toLowerCase();
  const buf = bytes ?? fs.readFileSync(archivePath);

  if (ext === '.lha' || ext === '.lzh') {
    const contents = readLhaContents(buf);
    if (contents.files.length === 0 && buf.length > 0) {
      throw new Error(`LHA reader returned 0 files from ${buf.length}-byte archive — the file may be corrupt or an unsupported LHA variant`);
    }
    return contents;
  }
  if (ext === '.zip') {
    const contents = readZipContents(buf);
    if (contents.files.length === 0 && buf.length > 0) {
      throw new Error(`ZIP reader returned 0 files from ${buf.length}-byte archive — the file may be corrupt`);
    }
    return contents;
  }
  if (ext === '.lzx') {
    const contents = readLzxContents(buf);
    if (contents.files.length === 0 && buf.length > 0) {
      throw new Error(`LZX reader returned 0 files from ${buf.length}-byte archive — the file may be corrupt or the WASM module is not available`);
    }
    return contents;
  }

  throw new Error(`Unsupported archive format: ${ext || '(none)'}`);
}

/**
 * Read every file out of an archive and return buffers for classification.
 * Uses the doorserver's own LHA/ZIP readers.
 */
function readArchiveFiles(
  archivePath: string
): Array<{ path: string; size: number; buf: Buffer }> {
  const bytes = fs.readFileSync(archivePath);
  const contents = readArchiveContents(archivePath, bytes);
  const files: Array<{ path: string; size: number; buf: Buffer }> = [];
  const ext = path.extname(archivePath).toLowerCase();

  for (const entry of contents.files) {
    let buf: Buffer | null = null;

    if (ext === '.lha' || ext === '.lzh') {
      let entries: Array<{ name: string; length: number; data?: unknown }>;
      try {
        entries = LHA.read(new Uint8Array(bytes));
      } catch {
        continue;
      }
      for (const member of entries) {
        const memberPath = (member.name || '').replace(/\\/g, '/').replace(/^[A-Za-z0-9_.-]*:/, '').replace(/^\/+/, '');
        if (memberPath === entry.path || memberPath.toLowerCase() === entry.path.toLowerCase()) {
          try {
            const unpacked = LHA.unpack(member);
            if (unpacked) buf = Buffer.from(unpacked);
          } catch { /* skip */ }
          break;
        }
      }
    } else if (ext === '.zip') {
      buf = extractZipMember(bytes, entry.path);
    } else if (ext === '.lzx') {
      const extracted = extractLzxFile(bytes, entry.path);
      if (extracted) buf = Buffer.from(extracted);
    }

    if (buf) {
      files.push({ path: entry.path, size: entry.size, buf });
    }
  }

  return files;
}

/** Extract a single member from a ZIP archive by name. */
function extractZipMember(bytes: Buffer, targetPath: string): Buffer | null {
  const ZIP_EOCD_SIG = 0x06054b50;
  const ZIP_CENTRAL_SIG = 0x02014b50;
  const ZIP_LOCAL_SIG = 0x04034b50;
  const ZIP_EOCD_MIN_LEN = 22;
  const ZIP_CENTRAL_MIN_LEN = 46;
  const ZIP_LOCAL_MIN_LEN = 30;

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

  let p = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + ZIP_CENTRAL_MIN_LEN > bytes.length) return null;
    if (bytes.readUInt32LE(p) !== ZIP_CENTRAL_SIG) return null;

    const method = bytes.readUInt16LE(p + 10);
    const compressedSize = bytes.readUInt32LE(p + 20);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const localHeaderOffset = bytes.readUInt32LE(p + 42);

    const nameStart = p + ZIP_CENTRAL_MIN_LEN;
    if (nameStart + nameLen > bytes.length) return null;
    const name = bytes.toString('latin1', nameStart, nameStart + nameLen);

    p = nameStart + nameLen + extraLen + commentLen;

    // Match by path (case-insensitive, normalize separators)
    const normalized = name.replace(/\\/g, '/');
    const targetLower = targetPath.toLowerCase();
    if (normalized.toLowerCase() !== targetLower) continue;

    // Read via local header
    const lp = localHeaderOffset;
    if (lp + ZIP_LOCAL_MIN_LEN > bytes.length) return null;
    if (bytes.readUInt32LE(lp) !== ZIP_LOCAL_SIG) return null;

    const lNameLen = bytes.readUInt16LE(lp + 26);
    const lExtraLen = bytes.readUInt16LE(lp + 28);
    const dataStart = lp + ZIP_LOCAL_MIN_LEN + lNameLen + lExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > bytes.length || dataEnd > bytes.length) return null;

    const compressed = bytes.subarray(dataStart, dataEnd);
    if (method === 0) return Buffer.from(compressed);
    if (method === 8) {
      try { return Buffer.from(zlib.inflateRawSync(compressed)); } catch { return null; }
    }
    return null;
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze an archive for junk files. Supports LHA, LZH, and ZIP.
 * Returns empty results for unsupported formats (LZX, DMS, etc.).
 */
export function analyzeArchive(archivePath: string, extraPatterns?: string[]): StripResult {
  const patterns = loadPatterns();
  const fingerprints = loadFingerprints();
  const allPatterns = extraPatterns
    ? [...patterns.filenamePatterns, ...extraPatterns]
    : patterns.filenamePatterns;
  const files = readArchiveFiles(archivePath);
  return deriveStripPlan(files, allPatterns, fingerprints);
}

/**
 * Strip junk files from an archive and repack as ZIP.
 * The output is always a .zip because there is no portable LHA writer.
 */
export function stripArchive(
  archivePath: string,
  outPath: string,
  preservePaths?: Set<string>
): StripArchiveResult {
  const patterns = loadPatterns();
  const fingerprints = loadFingerprints();
  const files = readArchiveFiles(archivePath);
  const plan = deriveStripPlan(files, patterns.filenamePatterns, fingerprints);
  const stripPaths = new Set(plan.stripped.filter(e => !preservePaths?.has(e.path)).map(e => e.path));

  const zip = new AdmZip();
  for (const file of files) {
    if (stripPaths.has(file.path)) continue;
    zip.addFile(file.path, file.buf);
  }

  const outputPath = /\.zip$/i.test(outPath)
    ? outPath
    : outPath.replace(/\.(lha|lzx|lzh)$/i, '') + '.zip';
  zip.writeZip(outputPath);

  return { ...plan, outputPath };
}

// ─── Directory-based operations (installed doors) ────────────────────────────

/**
 * Analyze a directory of installed door files for junk. Reads every file
 * recursively and classifies each one. Portable — pure fs, no archive
 * format concerns.
 */
export function analyzeDirectory(dirPath: string): StripResult {
  const patterns = loadPatterns();
  const fingerprints = loadFingerprints();
  const files: Array<{ path: string; size: number; buf: Buffer }> = [];

  function scanDir(absDir: string, relPrefix: string): void {
    let entries: string[];
    try { entries = fs.readdirSync(absDir); } catch { return; }
    for (const name of entries) {
      const absPath = path.join(absDir, name);
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) { scanDir(absPath, relPath); continue; }
      let buf: Buffer;
      try { buf = fs.readFileSync(absPath); } catch { continue; }
      files.push({ path: relPath, size: stat.size, buf });
    }
  }

  scanDir(dirPath, '');
  return deriveStripPlan(files, patterns.filenamePatterns, fingerprints);
}

/**
 * Delete junk files from an installed door directory. RelPaths are
 * relative to dirPath. Errors are silently ignored — a file that cannot
 * be deleted (permissions, etc.) is left in place.
 */
export function stripFilesFromDirectory(dirPath: string, relPaths: string[]): void {
  for (const rel of relPaths) {
    const abs = path.join(dirPath, rel);
    try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* ignore */ }
  }
}

/**
 * Extract an archive to destDir, omitting junk files (unless listed in
 * preservePaths — files flagged but kept anyway by user choice).
 * Portable — reads via the doorserver's own LHA/ZIP readers.
 */
export function extractClean(archivePath: string, destDir: string, preservePaths?: Set<string>): void {
  const patterns = loadPatterns();
  const fingerprints = loadFingerprints();
  const files = readArchiveFiles(archivePath);
  const plan = deriveStripPlan(files, patterns.filenamePatterns, fingerprints);
  const stripPaths = new Set(plan.stripped.filter(e => !preservePaths?.has(e.path)).map(e => e.path));

  fs.mkdirSync(destDir, { recursive: true });
  const destRoot = path.normalize(destDir + path.sep);

  for (const file of files) {
    if (stripPaths.has(file.path)) continue;

    const outPath = path.normalize(path.join(destDir, file.path));
    if (!outPath.startsWith(destRoot)) continue; // zip-slip guard
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, file.buf);
  }
}
