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
 *
 * What each row SAYS about a door is decided in ./describe.ts, which reads
 * the door's FILE_ID.DIZ. This module only renders; it holds no rules about
 * what a description is.
 *
 * It renders two indexes off one row format: the whole catalog, and the
 * newest N rows for a client that polls for what has just arrived rather
 * than re-reading four thousand lines to find out.
 */
import { describeRow, fetchCatalogRows, toLatin1Safe, type CatalogQuery, type DoorCatalogRow } from './manifest';
import { getCatalogRevision, loadCorpusGroupTags } from './catalog';
import type { ServerConfig } from './config';

/** Collapse whitespace, strip control characters. No length cap. */
function stripControlAndCollapse(s: string): string {
  return s
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

/**
 * A tab or newline inside any field would break the format, so every
 * field gets the same control-character strip Description already got
 * (review round 1, finding 4 - Filename and Path previously stripped only
 * tab/CR/LF, which was inconsistent with Description's fuller strip).
 */
function tsvSafe(s: string): string {
  return stripControlAndCollapse(s);
}

function tsvField(s: string): string {
  return toLatin1Safe(tsvSafe(s));
}

function renderRow(row: DoorCatalogRow, groupTags: ReadonlySet<string>): string {
  const filename = tsvField(row.archive_name);
  const pathCol = tsvField(firstPathSegment(row.archive_path));
  const size = formatSize(row.archive_size ?? 0);
  return `${filename}\t${pathCol}\t${size}\t${tsvField(describeRow(row, groupTags))}`;
}

export const TSV_HEADER = 'Filename\tPath\tSize\tDescription';

/** How many rows the recent index carries when the caller names no number. */
export const RECENT_DEFAULT = 30;
/** The most it will carry. Past this, ask for the full index instead. */
export const RECENT_MAX = 200;

export function clampRecent(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return RECENT_DEFAULT;
  return Math.min(RECENT_MAX, Math.max(1, Math.floor(requested)));
}

export function renderIndexTsv(cfg: ServerConfig, opts?: CatalogQuery): Buffer {
  const rows = fetchCatalogRows(cfg, opts);
  // Tags come from the whole corpus, never from these rows - see
  // catalog.ts's corpusGroupTags. A 30-row recent index recognises almost
  // no tags on its own, and would describe a door differently from the way
  // the full index describes the same door.
  const groupTags = loadCorpusGroupTags(cfg);
  const lines = [TSV_HEADER, ...rows.map((r) => renderRow(r, groupTags))];
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

export function renderIndexTsvCached(cfg: ServerConfig, opts?: CatalogQuery): Buffer {
  const key = `${getCatalogRevision(cfg)}|${opts?.type ?? ''}|${opts?.q ?? ''}|${opts?.recent ?? ''}`;
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
