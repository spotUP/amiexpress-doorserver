/**
 * door-repo-manifest: builds an in-memory manifest of the door catalog and
 * renders it as list.txt — a byte-exact, ISO-8859-1/CRLF plain-text index
 * that legacy AmigaDOS door-repo clients (and 68K doors with no JSON
 * parser) can read directly over a socket, plus a JSON-friendly
 * DoorRepoManifest for modern (web) consumers.
 *
 * Checksums are read straight off the door_catalog row (md5/sha256 columns,
 * populated at index time by amiexpress-web's
 * dev/scripts/door-corpus/build-door-catalog.ts — see this repo's
 * checksums.ts's getArchiveChecksums, the function it reuses for hashing).
 * This is what keeps buildManifest() cheap: on a cold process cache,
 * synchronously fs.readFileSync + hashing ~3300 archives (167 MB)
 * blocks the Node event loop for ~22 SECONDS — during which the whole BBS
 * (telnet/SSH, WebSocket heartbeats, every other route) stalls. Reading a
 * precomputed column is a plain SELECT; no per-request hashing.
 *
 * A row with a still-NULL md5/sha256 (not yet (re)indexed) falls back to
 * computing it live via getArchiveChecksums — but bounded to at most
 * LAZY_CHECKSUM_FALLBACK_LIMIT rows per call. Past that bound, remaining
 * NULL rows are left null with the same ASCII WARN as before (never a
 * thrown error out of buildManifest) — the row still appears in the
 * manifest, and a consumer that tries to install it either gets a null
 * checksum (client-side skip) or 404s at download time if the archive is
 * genuinely missing. The bound exists so a request landing on an
 * un-backfilled/stale slice of the catalog degrades gracefully instead of
 * reproducing the original cold-cache stall.
 */
import Database from 'better-sqlite3';
import { getArchiveChecksums } from './checksums';
import { analyseDoor } from './describe';
import { applyOverrides, hiddenExclusion, isOverridden, loadOverrides } from './effective';
import { resolveArchivePath, getCatalogRevision, loadCorpusGroupTags } from './catalog';
import { openDb } from './db';
import type { ServerConfig } from './config';
import type { ManifestDoor, DoorRepoManifest } from '../contract/manifest-types';

export type { ManifestDoor, DoorRepoManifest };

// ─── DB access ──────────────────────────────────────────────────────────
//
// This module opens the catalog READONLY through openDb() from ./db, the
// only place in this server that opens a database — this module never
// writes to door_catalog.

export interface DoorCatalogRow {
  /** Catalog id - needed to find this door's human corrections. */
  id: string;
  archive_name: string;
  archive_path: string;
  binary_name: string | null;
  door_type: string;
  name: string | null;
  author: string | null;
  release_group: string | null;
  category: string | null;
  description: string | null;
  file_id_diz: string | null;
  archive_size: number | null;
  md5: string | null;
  sha256: string | null;
  junk_live: number;
  has_doc: number;
  /**
   * 1 when a human wrote this row's description. The catalog's own
   * `description` column is raw DIZ art nobody serves, so the renderers ask
   * the classifier for a description UNLESS a person has overridden it -
   * this flag is how they tell the two cases apart.
   */
  description_overridden: number;
}

/**
 * Live ad/junk count expression for the SELECT below.
 *
 * door_catalog.junk_count is a denormalised copy written at index time and
 * can disagree with the per-file rows (12 of 3301 rows on the current live
 * catalog). DOORMAN already prefers the live per-file count over the column
 * for exactly this reason (app.ts, getEntryJunkCount), so the manifest — the
 * thing every OTHER client reads — must not publish the staler number.
 *
 * door_catalog_files is created by the same migration as door_catalog, but
 * several test fixtures build a door_catalog-only database, and a subquery
 * against a missing table is a prepare-time error that would take out the
 * whole manifest rather than one field. Falling back to the column keeps
 * those callers working with the value they had before.
 */
function hasFilesTable(db: Database.Database): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'door_catalog_files'")
    .get();
}

/**
 * Junk counts as a single grouped pass, joined once - NOT a correlated
 * subquery per catalog row.
 *
 * The first version of this was
 *   (SELECT COUNT(*) FROM door_catalog_files f
 *     WHERE f.catalog_id = door_catalog.id AND f.is_junk = 1)
 * which reads as O(1) per row but is not: SQLite chose idx_dcf_is_junk for
 * it, so every one of the 3301 catalog rows rescanned the thousands of rows
 * with is_junk = 1. Measured on the live catalog: 13.05 SECONDS for the
 * query, which every catalog fetch paid - the whole reason the door took so
 * long to start. The same data as a grouped join: 0.03 seconds.
 *
 * A join is also immune to the planner changing its mind, which a
 * correlated subquery with two candidate indexes is not.
 */
const JUNK_JOIN = `
  LEFT JOIN (
    SELECT catalog_id, COUNT(*) AS n
    FROM door_catalog_files
    WHERE is_junk = 1
    GROUP BY catalog_id
  ) j ON j.catalog_id = door_catalog.id
`;

// Upper bound on how many rows buildManifest() will lazily hash (NULL
// md5/sha256, i.e. not yet indexed with digests) in a single call. At the
// measured ~5.9ms/file average (3669 files / 21760ms), 25 files is ~150ms
// worst case — comfortably under "a fraction of a second," even stacked
// with the rest of buildManifest's row-mapping work. Rows beyond the bound
// keep their NULL checksum and log the existing WARN; nothing throws.
export const LAZY_CHECKSUM_FALLBACK_LIMIT = 25;

// ─── Manifest builder ───────────────────────────────────────────────────

/**
 * The one place that queries door_catalog for a filtered listing. Both
 * buildManifest() (below) and index-tsv.ts's renderer call this — Feature
 * 1 (index.tsv) is required to honour the same ?type=/?q= filters as the
 * manifest WITHOUT writing a second catalog query, and this is that shared
 * query. index-tsv.ts needs archive_path (for its Path/System columns) and
 * file_id_diz (for its description classifier), both already selected here
 * for the manifest's own fileIdDiz field and the lazy-checksum fallback's
 * resolveArchivePath() call. binary_name IS an addition to this SELECT
 * (2026-08-23) — index-tsv.ts's description classifier prefers it (the
 * door's actual program name, populated for 2398 of 3301 rows) over a
 * DIZ-mined line; ManifestDoor (the JSON /manifest contract) does not
 * expose it, so adding it here does not change a single byte of
 * /manifest's response — verified by parity, which digests that JSON body.
 */
/**
 * What a rendered index asks the catalog for. `recent` is a row count, not
 * a cutoff date: "the newest N" is answerable against any catalog, while
 * "added since <date>" reports nothing at all on a repository that has been
 * quiet for a month.
 */
export interface CatalogQuery {
  type?: string;
  q?: string;
  recent?: number;
}

export function fetchCatalogRows(cfg: ServerConfig, opts?: CatalogQuery): DoorCatalogRow[] {
  const db = openDb(cfg, { readonly: true });
  try {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.type) {
      conditions.push('door_type = ?');
      params.push(opts.type);
    }

    if (opts?.q && opts.q.trim()) {
      const like = `%${opts.q.trim()}%`;
      conditions.push(
        '(archive_name LIKE ? OR name LIKE ? OR author LIKE ? OR release_group LIKE ? OR description LIKE ?)'
      );
      params.push(like, like, like, like, like);
    }

    // A door taken out of the repository is out of every listing: list.txt,
    // the manifest and index.tsv all come through here.
    const hidden = hiddenExclusion(db);
    if (hidden) conditions.push(hidden);

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    // doc_raw is deliberately NOT selected — it is the full documentation
    // text of every door in the catalog (3218 of 3301 rows carry one), so
    // selecting it to compute a boolean would pull several MB per manifest
    // build. The emptiness test runs in SQL and only the flag comes back.
    const filesTable = hasFilesTable(db);
    // Newest first for a recent index, and by name for every other render.
    // A bulk import stamps hundreds of rows with the same indexed_at second,
    // so the name is the tie-break - without it SQLite is free to return
    // those rows in a different order on each render and the cached bytes
    // would churn against an unchanged catalog.
    const orderBy = opts?.recent
      ? 'ORDER BY indexed_at DESC, archive_name COLLATE NOCASE ASC'
      : 'ORDER BY archive_name COLLATE NOCASE ASC';
    const limit = opts?.recent ? 'LIMIT ?' : '';
    if (opts?.recent) params.push(opts.recent);
    const sql = `
      SELECT id, archive_name, archive_path, binary_name, door_type, name, author, release_group,
             category, description, file_id_diz, archive_size, md5, sha256,
             ${filesTable ? 'COALESCE(j.n, 0)' : 'junk_count'} AS junk_live,
             (CASE WHEN doc_raw IS NOT NULL AND doc_raw <> '' THEN 1 ELSE 0 END) AS has_doc
      FROM door_catalog
      ${filesTable ? JUNK_JOIN : ''}
      ${where}
      ${orderBy}
      ${limit}
    `;
    // One query for every human correction in the catalog, then applied in
    // memory: a per-row lookup would be 3300 extra statements per render.
    const overrides = loadOverrides(db);
    return (db.prepare(sql).all(...params) as DoorCatalogRow[]).map((row) => ({
      ...applyOverrides(row, row.id, overrides),
      description_overridden: isOverridden(row.id, 'description', overrides) ? 1 : 0,
    }));
  } finally {
    db.close();
  }
}

/**
 * One row's description: what a human wrote if anyone has, otherwise what
 * ./describe.ts reads out of the door's FILE_ID.DIZ.
 */
export function describeRow(row: DoorCatalogRow, groupTags: ReadonlySet<string>): string {
  if (row.description_overridden) {
    return row.description ?? '';
  }
  return analyseDoor(
    {
      dizText: row.file_id_diz,
      name: row.name,
      archiveName: row.archive_name,
      binaryName: row.binary_name,
      catalogVersion: null,
      catalogAuthor: row.author,
    },
    groupTags
  ).description;
}

export function buildManifest(cfg: ServerConfig, opts?: CatalogQuery): DoorRepoManifest {
  const rows = fetchCatalogRows(cfg, opts);
  // Tags come from the whole corpus, never from these rows - see
  // corpusGroupTags. A filtered manifest (?q=) sees too few archives to
  // recognise a tag, and would describe the same door differently from an
  // unfiltered one.
  const groupTags = loadCorpusGroupTags(cfg);

  let lazyFallbacksUsed = 0;

  const doors: ManifestDoor[] = rows.map((row) => {
    let md5: string | null = row.md5;
    let sha256: string | null = row.sha256;

    if (md5 === null || sha256 === null) {
      if (lazyFallbacksUsed < LAZY_CHECKSUM_FALLBACK_LIMIT) {
        lazyFallbacksUsed++;
        try {
          const absPath = resolveArchivePath(cfg, row.archive_path);
          const sums = getArchiveChecksums(absPath);
          md5 = sums.md5;
          sha256 = sums.sha256;
        } catch {
          md5 = null;
          sha256 = null;
          // eslint-disable-next-line no-console
          console.log(`[door-repo] WARN checksum unavailable: ${row.archive_name}`);
        }
      } else {
        md5 = null;
        sha256 = null;
        // eslint-disable-next-line no-console
        console.log(`[door-repo] WARN checksum not indexed and lazy-fallback limit (${LAZY_CHECKSUM_FALLBACK_LIMIT}) reached: ${row.archive_name}`);
      }
    }

    return {
      archiveName: row.archive_name,
      doorType: row.door_type,
      name: row.name,
      author: row.author,
      releaseGroup: row.release_group,
      category: row.category,
      // What the door IS, read out of its FILE_ID.DIZ by ./describe.ts -
      // NOT the catalog's raw `description` column, which is scene box art
      // as often as it is words. Both readers of this field (list.txt for
      // the AmigaDOS clients, and the JSON manifest for web consumers) get
      // the same answer as index.tsv, so no two endpoints describe the same
      // door differently.
      description: describeRow(row, groupTags),
      fileIdDiz: row.file_id_diz,
      archiveSize: row.archive_size,
      md5,
      sha256,
      junkCount: row.junk_live ?? 0,
      hasDoc: row.has_doc === 1,
    };
  });

  return {
    formatVersion: 1,
    revision: getCatalogRevision(cfg),
    generatedAt: new Date().toISOString(),
    doors,
  };
}

// ─── list.txt renderer ──────────────────────────────────────────────────
//
// Byte-exact ISO-8859-1 (latin1) plain text, CRLF line endings, for
// AmigaDOS-side clients with no JSON parser:
//   DOORREPO|1|<revision>|<count>
//   <archiveName>|<doorType>|<archiveSize>|<md5>|<name>|<description>
//     |<author>|<releaseGroup>|<junkCount>|<hasDoc>
//   ... (one line per door)
// with a trailing CRLF after the last row.
//
// Fields 7-10 are an APPEND, added 2026-08-18. The format contract
// (amiexpress-web's docs/DOOR-REPO-API.md section 3) states that appending
// trailing fields never bumps the header's version number, because a
// conforming client reads the first six fields by position and ignores the
// rest — so the header still says 1 and every already-deployed client keeps
// working byte-for-byte. Fields 1-6 keep their exact position, meaning and
// type.
//
// Why these four: author and releaseGroup are two of the six fields the
// server's own ?q= search matches (section 8) and two of the six DOORMAN
// filters on, so a list.txt client that held only archive/name/description
// could not reproduce either behaviour — searching for a group name found
// nothing locally while the same query worked server-side. junkCount and
// hasDoc let a client gate its own action keys the way DOORMAN does instead
// of advertising [V]iew doc on a door with no documentation.
//
// sha256 is deliberately NOT here: /archive already returns X-Archive-SHA256
// (and X-Archive-MD5) with the bytes themselves, so a downloading client can
// verify against the strong digest without every client paying 64 bytes per
// row (~211 KB of extra catalog on the current 3301-row corpus) on every
// catalog fetch.

function esc(s: string): string {
  return s.replace(/\|/g, '!');
}

function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ');
}

// `Buffer.from(str, 'latin1')` never throws on a character outside the
// ISO-8859-1 range: it silently truncates each UTF-16 code unit to its
// low byte (e.g. Cyrillic U+0416 becomes byte 0x16, an unrelated control
// character), producing a valid-looking but WRONG byte, not an error and
// not a visible marker. Against the real catalog this affects a handful of
// rows with non-ASCII metadata (accented names not in precomposed form,
// stray Unicode punctuation, etc.). Since these bytes are parsed by a real
// Amiga client with no Unicode awareness, an explicit '?' substitution is
// preferable to that silent corruption.
//
// Iterates by Unicode code point (not UTF-16 code unit), so an astral
// character encoded as a surrogate pair collapses to exactly one '?'
// ("a single '?' per character"), not two.
export function toLatin1Safe(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp <= 0xff ? ch : '?';
  }
  return out;
}

/**
 * Rendered-catalog cache, keyed by the catalog revision and the filters.
 *
 * Every client start fetches list.txt, and until now every one of those
 * rebuilt the whole thing: query 3301 rows, map them, render ~620 KB of
 * text. The revision already changes exactly when the catalog changes
 * (getCatalogRevision: row count + newest indexed_at), so between two
 * catalog edits the answer is byte-identical and there is no reason to
 * compute it twice.
 *
 * Bounded to a handful of entries because the filtered variants (?type=,
 * ?q=) share this cache: an unbounded map keyed by a client-supplied query
 * string is a memory leak with a rude name. The unfiltered catalog - the
 * one every door asks for - is ~620 KB, so the cap is small on purpose.
 */
const LIST_CACHE_MAX = 8;
const listCache = new Map<string, Buffer>();

export function renderListTxtCached(cfg: ServerConfig, opts?: CatalogQuery): Buffer {
  const key = `${getCatalogRevision(cfg)}|${opts?.type ?? ''}|${opts?.q ?? ''}`;
  const hit = listCache.get(key);
  if (hit) {
    return hit;
  }

  const rendered = renderListTxt(buildManifest(cfg, opts));

  // A revision change makes every existing entry unreachable, so drop them
  // rather than letting stale-revision buffers age out one eviction at a
  // time while holding megabytes.
  const currentRevision = key.split('|')[0];
  for (const existing of Array.from(listCache.keys())) {
    if (!existing.startsWith(`${currentRevision}|`)) {
      listCache.delete(existing);
    }
  }
  while (listCache.size >= LIST_CACHE_MAX) {
    const oldest = listCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    listCache.delete(oldest);
  }

  listCache.set(key, rendered);
  return rendered;
}

/** Exported for tests: forget everything rendered so far. */
export function _clearListCacheForTests(): void {
  listCache.clear();
}

export function renderListTxt(m: DoorRepoManifest): Buffer {
  const lines: string[] = [];
  lines.push(`DOORREPO|1|${m.revision}|${m.doors.length}`);

  for (const d of m.doors) {
    // oneLine() runs on every free-text field, not just description: a
    // raw CR/LF/TAB in archiveName or name would otherwise emit an extra
    // physical line, desyncing the header's `count` from the actual number
    // of data lines and breaking any naive line-by-line C parser — the
    // exact failure mode the byte-exact list.txt contract exists to
    // prevent. archiveName/name have no real-world source of embedded
    // newlines today (archiveName is a catalog-row column derived from an
    // archive's own filename; name comes from FILE_ID.DIZ/corpus
    // metadata), but the contract must hold for arbitrary catalog content,
    // not just today's corpus.
    const archiveName = toLatin1Safe(esc(oneLine(d.archiveName)));
    const doorType = d.doorType;
    const archiveSize = d.archiveSize ?? 0;
    const md5 = d.md5 ?? '';
    // No length cap on name: unlike description (capped at 120 to bound
    // line length against genuinely free-text DIZ content), name is a
    // short display label — real corpus max observed is 44 chars, nowhere
    // near a length that would threaten line-based parsing once oneLine()
    // has already removed the only thing that could break the one-row/
    // one-line invariant (embedded newlines). Capping it would be
    // speculative hardening against a problem that doesn't exist.
    const name = toLatin1Safe(esc(oneLine(d.name ?? '')));
    // '?' substitution happens BEFORE the 120-char slice: every character
    // remaining after toLatin1Safe occupies exactly one UTF-16 code unit
    // (latin1-range chars are single-unit; substituted chars are the
    // single-unit '?'), so the truncation boundary counts real output
    // characters instead of risking a cut through the middle of a
    // surrogate pair.
    const description = toLatin1Safe(esc(oneLine(d.description ?? ''))).slice(0, 120);
    // Same escape/oneLine/latin1 treatment as every other free-text field —
    // author and releaseGroup come from scene-release metadata and carry
    // both non-ASCII characters and (rarely) a literal '|'. Capped well
    // above the real corpus maxima (28 and 7 characters) purely to bound
    // the line length against arbitrary future catalog content.
    const author = toLatin1Safe(esc(oneLine(d.author ?? ''))).slice(0, 48);
    const releaseGroup = toLatin1Safe(esc(oneLine(d.releaseGroup ?? ''))).slice(0, 32);
    // '1'/'0' rather than a word: a C89 client tests one byte.
    const hasDoc = d.hasDoc ? '1' : '0';
    lines.push(
      `${archiveName}|${doorType}|${archiveSize}|${md5}|${name}|${description}` +
        `|${author}|${releaseGroup}|${d.junkCount}|${hasDoc}`
    );
  }

  const out = lines.join('\r\n') + '\r\n';
  return Buffer.from(out, 'latin1');
}
