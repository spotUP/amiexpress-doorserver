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

// ─── description classifier (Feature 1b, tightened in review round 1) ──
//
// 759 of the 3301 catalogued doors have a FILE_ID.DIZ whose first line (and
// often several more) is box-drawing ASCII art rather than words - scene
// release banners routinely open with a border like
// "______    ________.  /\    ______.__________". A TSV row that surfaces
// that as its Description reads as noise, not as a description.
//
// Review round 1 added three more real-corpus problems on top of the
// original art-vs-words split:
//   - ~1300 of 3264 DIZ files open with a "<group> presents" banner that
//     DOES read as real words - it just names who released the door, not
//     what the door is. That line must be skipped in favor of the door's
//     actual name.
//   - The catalog's own `binary_name` (populated for 2398 of 3301 rows -
//     "Children", "Statusbbs", "offliner") is what the door actually IS,
//     and is preferred over a DIZ-mined line when both exist.
//   - Frame punctuation ("### ... ###", "»» ... ««") can wrap an otherwise
//     good line; copyright/credit lines ("... - (c) Group 1996") can pass
//     the word test while being pure attribution, not a description.

// The cheap first filter: does the line contain a run of at least 3
// letters anywhere? A pure border line never does. Includes the Latin-1
// diacritic range (À-ÿ): this corpus is Latin-1 scene text, and without it
// a word like "Größe" breaks into "Gr" (2 ASCII letters) before "ö",
// never reaching a 3-letter run, and reads as decoration instead of a word.
const HAS_WORD_RE = /[A-Za-zÀ-ÿ]{3,}/;

/** A single letter (ASCII or Latin-1 diacritic) or digit. */
function isLetterOrDigit(ch: string): boolean {
  return /[A-Za-z0-9À-ÿ]/.test(ch);
}

/**
 * True when `line` reads as real words rather than box-drawing/ASCII art
 * or punctuation-heavy decoration: it has a run of 3+ letters, AND
 * letters+digits are a clear supermajority (at least 3x) of everything
 * else that isn't whitespace. Counting "alphanumeric" against "everything
 * else non-blank" catches any box-drawing glyph (underscores, slashes,
 * pipes, high-bit CP437-style characters, Unicode box-drawing) without
 * having to enumerate which characters a scene group might have used for
 * a border.
 */
function looksLikeWords(line: string): boolean {
  if (!HAS_WORD_RE.test(line)) return false;
  let alnum = 0;
  let other = 0;
  for (const ch of line) {
    if (isLetterOrDigit(ch)) {
      alnum++;
    } else if (!/\s/.test(ch)) {
      other++;
    }
  }
  // Raised bar (review round 1, finding 2 defect 2): alnum must be a clear
  // supermajority (at least 3x), not just barely over half, so a
  // punctuation/frame-heavy line with an incidental word doesn't qualify.
  // HAS_WORD_RE above already guarantees alnum >= 3.
  return alnum >= other * 3;
}

/** A group/release-credit line naming who shipped the door, not what it is. */
const BANNER_RE = /\b(presents?|brings?|proudly|releases?)\b/i;

/** A copyright/credit line: attribution, not a description. */
const COPYRIGHT_RE = /©|\(c\)/i;

/**
 * Frame decoration this corpus wraps real content in: the punctuation set
 * from the original Feature 1b classification rule (`_ . / \ : | - = * #
 * ~ ( ) [ ] < > + ' " ,`), plus a handful of high-bit characters seen doing
 * the same job in real DIZ borders (guillemets, middle dot, degree sign,
 * en/em dash, the registered-trademark glyph used as a full-width border
 * character in some releases). Deliberately excludes `!` -- meaningful in
 * names like "iRoNCoDE!", not decoration.
 */
const FRAME_LEAD_RE = /^[\s_.,'"/\\:|=*#~()[\]<>+»«·°®–—-]+/;
const FRAME_TRAIL_RE = /[\s_.,'"/\\:|=*#~()[\]<>+»«·°®–—-]+$/;

/** Trim a run of frame punctuation from both ends of `s`, not just the middle. */
function trimFrame(s: string): string {
  return s.replace(FRAME_LEAD_RE, '').replace(FRAME_TRAIL_RE, '');
}

/** Collapse whitespace, strip control characters. No length cap. */
function stripControlAndCollapse(s: string): string {
  return s
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** stripControlAndCollapse, then cap at 60 characters (the Description field's limit). */
function cleanText(s: string): string {
  return stripControlAndCollapse(s).slice(0, 60);
}

/**
 * A single space-free token dense with digits (e.g. "JU6V13GOZY2WB4LCSE85")
 * reads as a serial number, hash, or registration key, not a description -
 * seen for real in this corpus as a catalog `name` field with no DIZ to
 * fall back to first. `looksLikeWords`'s letter-run/ratio test alone does
 * not catch this: a run of 4+ letters buried in a digit-heavy blob still
 * clears the word-run bar and the alnum-vs-punctuation ratio (there is
 * barely any punctuation to outweigh it). The real signal is structural -
 * no word boundaries at all, unlike genuine prose.
 */
function looksLikeKey(line: string): boolean {
  const trimmed = line.trim();
  if (/\s/.test(trimmed)) return false;
  const digits = trimmed.match(/[0-9]/g)?.length ?? 0;
  return digits >= 4;
}

/**
 * A placeholder/redacted run of one repeated character (e.g. "XXXX", seen
 * for real in this corpus as both the `name` field and the entire DIZ of
 * archive AE_DOORS.LHA). Satisfies the word-run and ratio tests trivially
 * (there is no punctuation to outweigh it), but repeating one letter is
 * not a word - it is what a scene release uses to say "no real title
 * given". Checked on the whitespace-free text, so "X X X X" is still
 * caught, not just "XXXX".
 */
function isRepeatedChar(line: string): boolean {
  const compact = line.replace(/\s+/g, '');
  return compact.length > 0 && /^(.)\1*$/.test(compact);
}

/**
 * Trims frame punctuation from `raw` FIRST, then tests the trimmed result:
 * real words (looksLikeWords), not a copyright/credit line, not a bare
 * key/hash token, AND not the product of trimming away most of the line -
 * the trimmed text must retain at least half of the original (whitespace
 * aside). Returns the trimmed, qualifying text, or null.
 *
 * Trimming before testing (not after) matters: this corpus's borders are
 * typically flush against the real content within the same short line
 * (">:::   User Status V0.8 BETA    :::<"), so testing the RAW line counts
 * that border punctuation against the ratio bar and wrongly rejects an
 * otherwise perfectly good line. Trimming first evaluates quality on what
 * a reader would actually see once the border is gone - which is also
 * exactly what gets returned, so the caller never re-trims.
 *
 * The retention floor exists because trim-then-test alone would let a
 * single incidental real word survive frame-trimming out of an otherwise
 * near-total wall of decoration (e.g. a border reading
 * "\/\/\/\/\/\/[for]\/\/\/\/\/\/" trims down to the bare word "for", which
 * would otherwise pass on its own merits). A border that dominates the
 * WHOLE line leaves too little behind to be a real trim target; a border
 * that only wraps the edges (the common case in this corpus) leaves most
 * of the line intact.
 */
function qualifyingCandidate(raw: string): string | null {
  const trimmed = trimFrame(raw);
  if (!looksLikeWords(trimmed)) return null;
  if (COPYRIGHT_RE.test(trimmed)) return null;
  if (looksLikeKey(trimmed)) return null;
  if (isRepeatedChar(trimmed)) return null;
  const original = raw.trim().length;
  if (original > 0 && trimmed.length < original * 0.5) return null;
  return trimmed;
}

/**
 * End index of the LAST banner-keyword match in `line`, or null if none.
 * A compound phrase like "Group Proudly Presents" matches BANNER_RE twice
 * ("proudly" and "presents"); taking the remainder after only the FIRST
 * match would return " Presents" - itself just another banner word, not a
 * description. The last match is always the right split point.
 */
function lastBannerMatchEnd(line: string): number | null {
  const re = /\b(presents?|brings?|proudly|releases?)\b/gi;
  let m: RegExpExecArray | null;
  let end: number | null = null;
  while ((m = re.exec(line)) !== null) {
    end = m.index + m[0].length;
  }
  return end;
}

/**
 * Walks `dizText` line by line for the door's own descriptive line -
 * skipping past a release banner ("<group> presents ...") rather than
 * returning it, and skipping a copyright/credit line in favor of a later
 * one. Returns null when nothing in the DIZ qualifies.
 *
 * Banner handling: when a candidate line matches BANNER_RE, the door's
 * name is either (a) the remainder of that same line after the LAST
 * matched word, if IT reads as real words, or (b) the next usable line,
 * looking ahead at most 3 lines. If neither works, the banner is skipped
 * entirely (not returned) and scanning continues from the following line.
 */
function findDescriptiveLine(dizText: string): string | null {
  const lines = dizText.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i++) {
    const candidate = qualifyingCandidate(lines[i]);
    if (!candidate) continue;

    if (!BANNER_RE.test(candidate)) {
      return candidate;
    }

    // Split point is found on the ORIGINAL line (a banner keyword could
    // sit inside frame punctuation that trimming already removed from
    // `candidate`, shifting offsets), then re-qualified on its own.
    const endIdx = lastBannerMatchEnd(lines[i]) ?? lines[i].length;
    const after = qualifyingCandidate(lines[i].slice(endIdx));
    if (after && !BANNER_RE.test(after)) {
      return after;
    }

    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      const lookahead = qualifyingCandidate(lines[j]);
      if (lookahead && !BANNER_RE.test(lookahead)) {
        return lookahead;
      }
    }
    // Banner with no usable substitute nearby - not a descriptive line on
    // its own merit; keep scanning past it rather than returning it.
  }

  return null;
}

/**
 * Picks a one-line, human-readable description for a door.
 *
 * Finds a descriptive line, in order: the FILE_ID.DIZ (via
 * findDescriptiveLine, banner-aware), then the catalog `name` field, both
 * via qualifyingCandidate (frame-trimmed, then tested: real words, not
 * copyright/credit, not a bare key/hash token).
 *
 * Then composes with `binaryName` (the catalog's `binary_name` - the
 * door's actual program, e.g. "Children", "offliner" - populated for 2398
 * of 3301 rows): `binaryName - <descriptive line>`, or just `binaryName`
 * when no descriptive line survived, skipping the prefix when the
 * descriptive line already contains it (case-insensitive) so it isn't
 * named twice. With no `binaryName`, falls back to the descriptive line
 * alone, then to the archive's own base name (extension stripped) -
 * accepted unconditionally, since it is guaranteed short, ASCII and
 * non-empty.
 *
 * Finally: collapse whitespace, strip control characters, cap at 60 chars.
 *
 * Exported standalone (not inlined into the TSV renderer) because this is
 * the piece most likely to need tuning against real corpus rows later.
 */
export function describeDoor(
  dizText: string | null,
  name: string | null,
  archiveName: string,
  binaryName: string | null
): string {
  const descriptive = (dizText ? findDescriptiveLine(dizText) : null) ?? (name ? qualifyingCandidate(name) : null);

  const bn = binaryName && binaryName.trim() ? binaryName.trim() : null;
  if (bn) {
    if (!descriptive) {
      return cleanText(bn);
    }
    const alreadyNamed = descriptive.toLowerCase().includes(bn.toLowerCase());
    return cleanText(alreadyNamed ? descriptive : `${bn} - ${descriptive}`);
  }

  if (descriptive) {
    return cleanText(descriptive);
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

/**
 * A tab or newline inside any field would break the format, so every
 * field gets the same control-character strip Description already got
 * (review round 1, finding 4 - Filename/Path/System previously stripped
 * only tab/CR/LF, which was inconsistent with Description's fuller strip).
 */
function tsvSafe(s: string): string {
  return stripControlAndCollapse(s);
}

function tsvField(s: string): string {
  return toLatin1Safe(tsvSafe(s));
}

function renderRow(row: DoorCatalogRow): string {
  const system = firstPathSegment(row.archive_path);
  const filename = tsvField(row.archive_name);
  const pathCol = tsvField(system);
  const size = formatSize(row.archive_size ?? 0);
  const description = tsvField(describeDoor(row.file_id_diz, row.name, row.archive_name, row.binary_name));
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
