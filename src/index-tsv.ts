/**
 * index.tsv: a tab-separated door index for UHC Tools' `uhcsearch` (Patrik's
 * Amiga package manager). uhcsearch has no JSON parser and builds a
 * download URL as `basePath + Path + "/" + Filename`, so the column order
 * and exact header names are load-bearing, not cosmetic — see
 * docs/DOOR-REPO-API.md.
 *
 * ISO-8859-1, LF line endings — NOT CRLF. list.txt (manifest.ts) uses CRLF
 * because that is what the original AmigaDOS door-repo clients expect;
 * uhcsearch's own format spec is explicit that this file must use LF, so
 * the two byte-exact formats intentionally differ in this one respect.
 */
import { fetchCatalogRows, toLatin1Safe, type DoorCatalogRow } from './manifest';
import { getCatalogRevision } from './catalog';
import type { ServerConfig } from './config';

// ─── description classifier (Feature 1b) ───────────────────────────────
//
// 759 of the 3301 catalogued doors have a FILE_ID.DIZ whose first line (and
// often several more) is box-drawing ASCII art rather than words - scene
// release banners routinely open with a border like
// "______    ________.  /\    ______.__________". A TSV row that surfaces
// that as its Description reads as noise, not as a description.

// The cheap first filter: does the line contain a run of at least 3 letters
// anywhere? A pure border line never does.
const HAS_WORD_RE = /[A-Za-z]{3,}/;

/**
 * True when `line` reads as real words rather than box-drawing/ASCII art:
 * it has a run of 3+ letters, AND letters+digits outnumber everything else
 * that isn't whitespace. The second half is what actually rejects art -
 * counting "alphanumeric" against "everything else non-blank" catches any
 * box-drawing glyph (underscores, slashes, pipes, high-bit CP437-style
 * characters, Unicode box-drawing) without having to enumerate which
 * characters a scene group might have used for a border.
 */
function looksLikeWords(line: string): boolean {
  if (!HAS_WORD_RE.test(line)) return false;
  let alnum = 0;
  let other = 0;
  for (const ch of line) {
    if (/[A-Za-z0-9]/.test(ch)) {
      alnum++;
    } else if (!/\s/.test(ch)) {
      other++;
    }
  }
  return alnum > other;
}

/** Collapse whitespace, strip control characters, cap at 60 characters. */
function cleanText(s: string): string {
  return s
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * Picks a one-line, human-readable description for a door, in order:
 *   1. The first FILE_ID.DIZ line that reads as real words (looksLikeWords).
 *   2. The catalog `name` field, if IT reads as real words.
 *   3. The archive's own base name (extension stripped) — accepted
 *      unconditionally, since it is guaranteed short, ASCII and non-empty.
 * Then: collapse whitespace, strip control characters, cap at 60 chars.
 *
 * Exported standalone (not inlined into the TSV renderer) because this is
 * the piece most likely to need tuning against real corpus rows later.
 */
export function describeDoor(dizText: string | null, name: string | null, archiveName: string): string {
  if (dizText) {
    for (const line of dizText.split(/\r\n|\r|\n/)) {
      if (looksLikeWords(line)) {
        return cleanText(line);
      }
    }
  }
  if (name && looksLikeWords(name)) {
    return cleanText(name);
  }
  const dot = archiveName.lastIndexOf('.');
  const base = dot === -1 ? archiveName : archiveName.slice(0, dot);
  return cleanText(base);
}

// ─── TSV renderer (Feature 1) ──────────────────────────────────────────

/**
 * The corpus system directory a catalog row belongs to: the first path
 * segment of archive_path (e.g. "AmiExpress/ACC-V103.LHA" -> "AmiExpress"),
 * or "Unsorted" when archive_path has no directory segment at all.
 */
function firstPathSegment(archivePath: string): string {
  const slash = archivePath.indexOf('/');
  return slash === -1 ? 'Unsorted' : archivePath.slice(0, slash);
}

/** Integer KiB with a "K" suffix, or "NNNB" under 1024 bytes. No padding. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${Math.round(bytes / 1024)}K`;
}

/** A tab or newline inside any field would break the format. */
function tsvSafe(s: string): string {
  return s.replace(/[\t\r\n]+/g, ' ');
}

function tsvField(s: string): string {
  return toLatin1Safe(tsvSafe(s));
}

function renderRow(row: DoorCatalogRow): string {
  const system = firstPathSegment(row.archive_path);
  const filename = tsvField(row.archive_name);
  const pathCol = tsvField(system);
  const size = formatSize(row.archive_size ?? 0);
  const description = tsvField(describeDoor(row.file_id_diz, row.name, row.archive_name));
  return `${filename}\t${pathCol}\t${size}\t${pathCol}\t${description}`;
}

export function renderIndexTsv(cfg: ServerConfig, opts?: { type?: string; q?: string }): Buffer {
  const rows = fetchCatalogRows(cfg, opts);
  const lines = ['Filename\tPath\tSize\tSystem\tDescription', ...rows.map(renderRow)];
  return Buffer.from(lines.join('\n') + '\n', 'latin1');
}

/**
 * Rendered-index cache, keyed by catalog revision and filters — the same
 * shape as manifest.ts's renderListTxtCached and for the same reason: every
 * uhcsearch run fetches this in full, and between two catalog edits the
 * answer is byte-identical.
 */
const CACHE_MAX = 8;
const cache = new Map<string, Buffer>();

export function renderIndexTsvCached(cfg: ServerConfig, opts?: { type?: string; q?: string }): Buffer {
  const key = `${getCatalogRevision(cfg)}|${opts?.type ?? ''}|${opts?.q ?? ''}`;
  const hit = cache.get(key);
  if (hit) {
    return hit;
  }

  const rendered = renderIndexTsv(cfg, opts);

  const currentRevision = key.split('|')[0];
  for (const existing of Array.from(cache.keys())) {
    if (!existing.startsWith(`${currentRevision}|`)) {
      cache.delete(existing);
    }
  }
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }

  cache.set(key, rendered);
  return rendered;
}

/** Exported for tests: forget everything rendered so far. */
export function _clearIndexTsvCacheForTests(): void {
  cache.clear();
}
