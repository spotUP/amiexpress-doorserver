/**
 * What a door IS, read out of its FILE_ID.DIZ.
 *
 * A scene DIZ is a picture of a box, not a paragraph: the door's name, its
 * version, the group that released it, the handle that coded it and the BBS
 * version it needs are scattered across the cells of an ASCII frame. This
 * module pulls those five facts apart so each can live in its own column.
 *
 * The rules were tuned over fifteen rounds of corrections from the catalog's
 * owner against real rows of the 3301-door corpus, in the prototype at
 * amiexpress-web:dev/scripts/door-index/description_rules.py. That file and
 * this one are the same classifier and must stay that way: its
 * test_description_rules.py and this repo's tests/describe.test.ts assert the
 * same cases against the same DIZ fixtures. Change a rule in one, change it
 * in both.
 *
 * Every rule below exists because a specific row read wrong:
 *
 *   - a line is scored by its best CELL, because "+[ MYSTiC /X-POWER ]-----[
 *     JoinCnf 4.0 ]---+" holds two independent cells and scoring the whole
 *     row produced "Mystic /POWER ]-----[ Joincnf"
 *   - group tags are stripped, but only tags DERIVED FROM THE CORPUS
 *     (prefixes appearing on 3+ archives), so "MB-MAKER" keeps its name
 *   - CamelCase splits ("SendMessage" -> "Send Message") but scene
 *     mixed-case does not ("KiLLER", "sTc", "AmiQWK")
 *   - elite casing normalises ("dOOR 4 dAYdREAM" -> "Door 4 Daydream") with
 *     an acronym allowlist and ALL-CAPS de-shouting
 *   - decoration is stripped but ACCENTED LETTERS are kept, while CP437 box
 *     art ("³Y³ Óääù") is rejected: a word needs ASCII letters in it
 *   - "/X" keeps its slash - it is the name of this BBS, not punctuation
 *   - the best PARAGRAPH is chosen, not the best line: DIZ text wraps
 *   - the release banner is skipped, and a mid-line banner splits into
 *     author + description ("KiLLraVeN/MYSTiC BRiNGS: KiLLER-BAUD 1.3")
 *   - release metadata goes ("[RELEASE 2]"), and so does a bracket emptied
 *     by extraction ("(Version )")
 *   - the length cap cuts on a word boundary, so it can never sever
 *     "[RELEASE 2]" into "[RELEASE 2"
 *   - a compatibility note ("Now working on /X 3.30") is true but does not
 *     describe the door, and loses to the line that names it
 *   - the BBS version a door needs is read from the WHOLE DIZ, because it is
 *     usually stamped in the bottom border, which no description quotes
 */

/** Frame punctuation: decoration at either end of a cell. */
const FRAME = " :-*()[]|_=+~<>.,'\"`^¦¬·°#!?/\\";

const ART_RE = /^[\s_\-=*#~/\\|:.,+()[\]<>'"`^¦°·;!?%$&@]*$/;
const BANNER_RE = /\b(presents?|brings?|proudly|releases?|bringing|presenting)\b/i;

/** Credits, distribution notes and dates: never a description. */
const JUNK_RE =
  /passed\s+thr|courier|released?\s+(on|at|by)|\bthanx|greets?\b|\bdate\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|^\s*(by|coded\s+by|written\s+by)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*,?\s*\d/i;

/** A copyright/credit line: attribution, not a description. */
const COPYRIGHT_RE = /©|\(c\)/i;

/** A handle on a line of its own: "sNoW^5D", "Jordan/5D". */
const HANDLE_RE = /^[A-Za-z0-9!._-]{2,20}\s*[\^/]\s*[A-Za-z0-9!._-]{2,20}$/;

// JS word boundaries are ASCII-only where Python's are Unicode-aware, so
// "v2.1ß" looked like a clean version here and not there - a 12-point
// scoring difference that changed which paragraph a row was described by.
// Latin-1 letters count as word characters in every boundary below.
const VERSIONISH_RE = /(?<![\wÀ-ÿ])v?\d+\.\d+(?![\wÀ-ÿ])/i;
const DOORISH_RE =
  /(?<![\wÀ-ÿ])(door|tool|util|utility|wall|scan|stat|list|chat|game|edit|menu|logon|logoff|upload|download|msg|mail|page|check|info|view|manager|maker)[\wÀ-ÿ]*(?![\wÀ-ÿ])/i;

/**
 * A note about which BBS version the door runs on - true, useful, and still
 * not a description of what the door DOES.
 */
const COMPAT_RE =
  /\b(?:now\s+work(?:s|ing)|works?\s+(?:only\s+)?(?:with|on)|requires?|needs?)\b.{0,12}\b(?:\/?X|amiexpress|fame|daydream|\d)/i;

/**
 * A word needs at least two ASCII letters in its run. A 3-letter run alone
 * is not enough: CP437/Amiga box art ("³Y³ Óääù Ð Á") lands in the Latin-1
 * letter range and would pass. Real words in this corpus are ASCII with the
 * occasional accent.
 */
const WORD_RE = /[A-Za-zÀ-ÿ]*[A-Za-z][A-Za-zÀ-ÿ]*[A-Za-z][A-Za-zÀ-ÿ]*/;

/** ANSI colour sequences ride along in DIZ text and are invisible in a terminal. */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b/g;

/**
 * A DIZ line is a row of an ASCII box. "+[ MYSTiC /X-POWER ]-----[ JoinCnf
 * 4.0 ]---+" holds two INDEPENDENT cells either side of a border run, and
 * ".---\/---\/-/X-pOwEr!-\/^-----|" is a border with one word trapped in it.
 * Split the row on border runs and pillars and judge each cell alone.
 *
 * The lookahead stops a run from swallowing the slash of "/X": the run then
 * backtracks one character and the cell starts at "/X".
 */
const CELL_SPLIT_RE = /[|¦]+|[[\]]?\s*[-_=~*^/\\¬]{3,}(?![Xx](?![A-Za-zÀ-ÿ]))\s*[[\]]?|\]\s*\[/;

/** Release-sequence metadata a group stamps on the box. */
const META_BRACKET_RE = /[[(]\s*(?:release|rel\.?|disk|part|file)\s*\d+(?:\s*(?:of|\/)\s*\d+)?\s*[\])]?/gi;

/** A bracket emptied by pulling its contents into a column of their own. */
const EMPTY_BRACKET_RE = /[[(]\s*(?:version|ver|v|rel|no)?\s*[.:]?\s*(?:[\])]|$)/gi;

/**
 * "/X" IS the name of the BBS (short for AmiExpress), so the slash is part
 * of a word, not frame decoration. Stripping it turned "/X dIVISION" into
 * "X Division" on 47 rows of the corpus.
 */
const XNAME_RE = /^\/[Xx](?![A-Za-zÀ-ÿ])/;

function isLatin1Letter(ch: string): boolean {
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(ch);
}

function isAsciiAlnum(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}

/** Share of characters above ASCII. Scene box art is drawn with them. */
function highBitShare(s: string): number {
  if (!s) return 0;
  let n = 0;
  for (const ch of s) if (ch.charCodeAt(0) > 0x7f) n++;
  return n / s.length;
}

function alnumShare(s: string): number {
  if (!s) return 0;
  let n = 0;
  for (const ch of s) if (isAsciiAlnum(ch) || isLatin1Letter(ch)) n++;
  return n / s.length;
}

/** strip(FRAME) at both ends, without eating the slash of "/X". */
export function stripFrameBoth(s: string): string {
  let out = s;
  while (out && FRAME.includes(out[out.length - 1])) out = out.slice(0, -1);
  while (out && FRAME.includes(out[0]) && !XNAME_RE.test(out)) out = out.slice(1);
  return out;
}

/**
 * stripFrameBoth, except for a CLOSING bracket that has its opener: FRAME
 * contains ")" and "]", so a plain strip turns "MultiTop (Version 2.0)" into
 * "MultiTop (Version 2.0" - it unbalances the very brackets the next rule
 * then has to repair, and the repair loses the text.
 */
function stripFrameKeepingPairs(s: string): string {
  let out = s;
  while (out) {
    const ch = out[out.length - 1];
    if (!FRAME.includes(ch)) break;
    if (ch === ')' || ch === ']') {
      const opener = ch === ')' ? '(' : '[';
      const head = out.slice(0, -1);
      if (count(head, opener) > count(head, ch)) break;
    }
    out = out.slice(0, -1);
  }
  while (out && FRAME.includes(out[0]) && !XNAME_RE.test(out)) out = out.slice(1);
  return out.trim();
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Collapse whitespace, drop ANSI and control codes, trim frame decoration. */
export function clean(s: string): string {
  const stripped = s.replace(ANSI_RE, '').replace(/[\x00-\x1f\x7f]/g, ' ');
  return stripFrameBoth(collapse(stripped)).trim();
}

export function dropMetaBrackets(s: string): string {
  if (!s) return s;
  return collapse(s.replace(META_BRACKET_RE, ' ').replace(EMPTY_BRACKET_RE, ' '));
}

/**
 * Cap the description without leaving a scar.
 *
 * Cutting at exactly `cap` characters severed "[RELEASE 2]" into
 * "[RELEASE 2" - a bracket opened and never closed reads as corruption. Cut
 * on a word boundary, then drop any group left hanging open, then any
 * connector the removal left dangling ("Adi Menu by").
 */
export function finalise(s: string, cap = 60): string {
  let out = stripFrameKeepingPairs(dropMetaBrackets(collapse(s ?? '')));
  if (out.length > cap) {
    const cut = out.slice(0, cap);
    out = cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
  }
  // A bracket opened and never closed is either a truncation scar or a
  // credit tag whose closer the frame-strip already ate ("[-5th Dynasty-]"
  // arrives as "[-5th Dynasty"). Drop a short tag; for prose, drop only the
  // bracket, or "5D-User V1.10 [-5th Dynasty Command to list all users"
  // would lose the description along with the tag.
  for (const [open, close] of [['[', ']'], ['(', ')']] as const) {
    const i = out.lastIndexOf(open);
    if (i === -1 || out.indexOf(close, i) !== -1) continue;
    const tail = out.slice(i + 1);
    const words = tail.match(/[A-Za-zÀ-ÿ0-9']+/g) ?? [];
    out = tail.length <= 24 && words.length <= 3 ? out.slice(0, i) : out.slice(0, i) + out.slice(i + 1);
  }
  out = out.replace(
    /[\s,;:-]*\b(?:coded|written|programmed|created|made|done)?\s*(?:by|from|for|with|of|and)\s*$/i,
    ''
  );
  return stripFrameKeepingPairs(out);
}

// ─── choosing the line ─────────────────────────────────────────────────

interface Scored {
  score: number;
  text: string;
}

function score(line: string): Scored {
  const c = clean(line);
  if (!c || ART_RE.test(c)) return { score: -99, text: c };
  if (!WORD_RE.test(c)) return { score: -99, text: c };
  if (highBitShare(c) > 0.3) return { score: -99, text: c };
  if (alnumShare(c) < 0.5) return { score: -99, text: c };
  if (c.length < 6) return { score: -50, text: c };
  let s = 0;
  if (JUNK_RE.test(c)) s -= 40;
  if (COPYRIGHT_RE.test(c)) s -= 40;
  if (COMPAT_RE.test(c)) s -= 20;
  if (HANDLE_RE.test(c)) s -= 40;
  if (VERSIONISH_RE.test(c)) s += 12;
  if (DOORISH_RE.test(c)) s += 8;
  const words = c.match(/[A-Za-zÀ-ÿ]{3,}/g) ?? [];
  s += Math.min(words.length, 6) * 3;
  if (c.length > 55) s -= 4;
  // "Added Features:" heads a list, it does not describe the door. The colon
  // is tested on the RAW line because clean() strips it off.
  if (/:[\s|¦:.]*$/.test(line)) s -= 6;
  return { score: s, text: c };
}

/**
 * Score a box row by its best CELL, falling back to the whole row when there
 * is no border inside it. A cell torn out of a border must stand on its own
 * to count: two words, or one word carrying a version or a door word
 * ("JoinCnf 4.0"). That is what keeps "/X-pOwEr!" and "mYSTIC!" - single
 * words trapped in border art - from being read as descriptions.
 */
export function bestCell(line: string): Scored {
  const parts = line.split(CELL_SPLIT_RE);
  if (parts.length <= 1) return score(line);
  let best: Scored = { score: -99, text: '' };
  for (const part of parts) {
    if (part === undefined) continue;
    const s = score(part);
    if (s.score <= -50) continue;
    const words = s.text.match(/[A-Za-zÀ-ÿ]{3,}/g) ?? [];
    if (words.length < 2 && !(words.length && (VERSIONISH_RE.test(s.text) || DOORISH_RE.test(s.text)))) {
      continue;
    }
    if (s.score > best.score) best = s;
  }
  return best;
}

/**
 * Pick the best PARAGRAPH, not the best line.
 *
 * DIZ descriptions wrap across lines behind decoration, so choosing a single
 * line yields a mid-sentence fragment. Group consecutive prose lines into
 * blocks, score the block, and read from its start. When the door's program
 * name is known, skip a block that only restates it - the top block is often
 * the header cell ("JoinCnf 4.0"), and the name already has its own column.
 */
/**
 * The single best LINE, used only when no paragraph qualifies.
 *
 * Block selection needs two consecutive prose lines to work with; a DIZ that
 * offers exactly one usable line between walls of art produces no block at
 * all. This is the prototype's `describe()` - the same scan, scoring each
 * line by its best cell, with a bonus for the line right after a release
 * banner (which is where the door's own name usually sits).
 */
export function describeLine(diz: string | null): string {
  const lines = (diz ?? '').replace(/\r/g, '').split('\n');
  let best: { score: number; index: number; text: string } | null = null;
  lines.forEach((line, i) => {
    const s = bestCell(line);
    if (s.score <= -50) return;
    const bonus = i > 0 && BANNER_RE.test(lines[i - 1]) ? 10 : 0;
    const score = s.score + bonus;
    if (!best || score > best.score) best = { score, index: i, text: s.text };
  });
  if (!best || (best as { score: number }).score <= 0) return '';
  const text = (best as { text: string }).text.replace(
    /^(presents?|brings?|proudly|releases?|presenting|bringing)\b[\s:.-]*/i,
    ''
  );
  // A chosen line can trail scene decoration a frame-strip leaves behind.
  return finalise(text).replace(/(\s+[^A-Za-z0-9À-ÿ]{1,3})+$/, '');
}

export function describeBlock(diz: string | null, cap = 70, prog?: string | null): string {
  const lines = (diz ?? '').replace(/\r/g, '').split('\n');
  const blocks: Scored[][] = [];
  let cur: Scored[] = [];
  const starts: number[] = [];
  lines.forEach((line, i) => {
    const s = bestCell(line);
    const prose = s.score > 0 && !JUNK_RE.test(s.text) && !HANDLE_RE.test(s.text);
    if (prose) {
      // The block's own line number, not lines.indexOf(line): two identical
      // lines in one DIZ would otherwise score every later block as if it
      // started at the first copy.
      if (!cur.length) starts.push(i);
      cur.push(s);
    } else if (cur.length) {
      blocks.push(cur);
      cur = [];
    }
  });
  if (cur.length) blocks.push(cur);
  // No paragraph qualified - fall back to the best single line.
  if (!blocks.length) return describeLine(diz);

  const blockScore = (b: Scored[], firstLine: number): number =>
    Math.max(...b.map((x) => x.score)) + Math.min(b.length, 4) * 4 - firstLine;

  const withIndex = blocks.map((b, i) => ({ block: b, first: starts[i] ?? 0 }));
  const ranked = [...withIndex].sort((a, b) => blockScore(b.block, b.first) - blockScore(a.block, a.first));

  let chosen = ranked[0].block;
  if (prog) {
    for (const cand of ranked) {
      if (!bodyAddsNothing(prog, cand.block.map((x) => x.text).join(' '))) {
        chosen = cand.block;
        break;
      }
    }
  }

  let parts = chosen.map((x) => x.text);
  parts[0] = parts[0].replace(/^(presents?|brings?|proudly|releases?|presenting|bringing)\b[\s:.-]*/i, '');
  parts[0] = stripFrameBoth(parts[0].replace(/^\d{1,2}[.)]\s+/, '')).trim();
  // DIZ feature lists are bulleted ("o Totally NEW Lay-Out"); the bullet is
  // decoration, and joining two bulleted lines must not read "Lay-Out o
  // Manages up to 256 Cnfs".
  parts = parts.map((p) => finalise(p.replace(/^[o*·+]\s+/, ''), cap)).filter((p) => p.length > 0);
  if (!parts.length) return '';

  // A first line that already stands on its own IS the description - only
  // keep appending while it is too short to mean anything by itself.
  let text = parts[0];
  for (const next of parts.slice(1)) {
    if (text.length >= 30) break;
    text = `${text} ${next}`;
  }
  return finalise(text.replace(/\s+[o*·]\s+/g, ' '), cap);
}

// ─── version ───────────────────────────────────────────────────────────
//
// Scene DIZ files spell versions loosely: "V1.05", "v 1.51", "V3.0", even
// "v1.o5" with a letter o for zero. A version after "/X" or "for" is the
// BBS's REQUIREMENT, not the door's, and is left alone here.

const VER_RE =
  /(?<![A-Za-zÀ-ÿ0-9.])[vV]\s?\.?\s?(\d{1,2}[.,][0-9oO]{1,3}[a-zA-Z]?)(?![0-9])|(?<![A-Za-zÀ-ÿ0-9.])[vV]\s?(\d{1,2})(?![0-9.])/g;
const BARE_VER_RE = /(?<![\wÀ-ÿ./-])(\d{1,2}[.,]\d{1,2}[a-z]?)(?![\wÀ-ÿ.])/g;
const BBS_CONTEXT_RE = /(?:\/X|amiexpress|ami|s!x|fame|daydream|for)\s*$/i;

export function normaliseVersion(raw: string): string {
  return raw.trim().toLowerCase().replace(/,/g, '.').replace(/o/g, '0');
}

export function splitVersion(desc: string, catalogVersion?: string | null): { text: string; version: string } {
  let found: string | null = null;
  let text = desc;
  let match: { start: number; end: number; value: string } | null = null;

  for (const re of [VER_RE, BARE_VER_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(desc)) !== null) {
      if (BBS_CONTEXT_RE.test(desc.slice(0, m.index))) continue;
      match = { start: m.index, end: m.index + m[0].length, value: m[1] ?? m[2] };
      break;
    }
    if (match) break;
  }

  if (match) {
    found = normaliseVersion(match.value);
    text = `${desc.slice(0, match.start)} ${desc.slice(match.end)}`;
  }
  if (!found && catalogVersion && catalogVersion.trim()) {
    found = normaliseVersion(catalogVersion);
  }
  text = dropMetaBrackets(collapse(text));
  text = stripFrameBoth(text.replace(/\s*([-|:/])\s*$/, '')).trim();
  return { text, version: found ?? '' };
}

// ─── which BBS the door needs ──────────────────────────────────────────
//
// "For /X 2.3x", "/X 3.x+", "requires AmiExpress 4.x" - the BBS version a
// door was coded against is the single fact a sysop needs before installing
// it, and it is NOT the door's own version.

const BBS_NAMES: Record<string, string> = {
  '/x': '/X',
  x: '/X',
  amiexpress: 'AmiExpress',
  ae: '/X',
  's!x': 'S!X',
  sx: 'S!X',
  fame: 'FAME',
  daydream: 'DayDream',
  dd: 'DayDream',
  dreamdoor: 'DayDream',
};

const BBS_REQ_RE =
  /(?:\b(?:for|only\s+for|requires?|required|needs?|works?\s+(?:only\s+)?(?:with|on)|coded\s+for|written\s+for|compatible\s+with)\b\s*[:-]?\s*)?(?<![A-Za-zÀ-ÿ0-9])(\/X|Ami-?Express|S!X|FAME|DayDream|AE|X)\s*(?:v(?:er(?:sion)?)?\.?\s*)?(\d{1,2}(?:[.,](?:[0-9]{1,3}[a-z]?|[xX]{1,3}))?\+?)/i;

export function normaliseRequirement(name: string, ver: string): string {
  const key = name.toLowerCase().replace(/-/g, '');
  const bbs = BBS_NAMES[key] ?? name;
  let version = ver.replace(/,/g, '.');
  const dot = version.indexOf('.');
  if (dot !== -1) {
    // 4.X and 4.x are one thing
    version = version.slice(0, dot + 1) + version.slice(dot + 1).replace(/X/g, 'x');
  }
  return `${bbs} ${version}`;
}

export function splitBbsRequirement(desc: string): { text: string; requires: string } {
  if (!desc) return { text: desc, requires: '' };
  const m = BBS_REQ_RE.exec(desc);
  if (!m) return { text: desc, requires: '' };
  const requires = normaliseRequirement(m[1], m[2]);
  const rest = stripFrameBoth(collapse(`${desc.slice(0, m.index)} ${desc.slice(m.index + m[0].length)}`)).trim();
  // A row that says nothing BUT which BBS it needs keeps saying it: the
  // requirement is then all the description has.
  if (!/[A-Za-zÀ-ÿ]{3}/.test(rest)) return { text: desc, requires };
  return { text: rest, requires };
}

/**
 * The requirement is a property of the ARCHIVE, not of the one line that got
 * picked as the description - "XIM - /X 3.38+" often sits in the bottom
 * border of the box, which no description would ever quote.
 */
export function bbsRequirementFromDiz(diz: string | null): string {
  if (!diz) return '';
  for (const raw of diz.replace(/\r/g, '').split('\n')) {
    // Raw, minus control codes only: every tidy-up in this module strips
    // frame characters off the ends, and "/X 3.38+" sits flush against the
    // box border - so the "+", the whole difference between "3.38" and
    // "3.38 or later", would be stripped as decoration.
    const line = raw.replace(ANSI_RE, '').replace(/[\x00-\x1f\x7f]/g, ' ');
    const m = BBS_REQ_RE.exec(line);
    if (m) return normaliseRequirement(m[1], m[2]);
  }
  return '';
}

// ─── author ────────────────────────────────────────────────────────────

const AUTHOR_RE = /\s*[-,]?\s*\b(?:coded|written|programmed|created|made|done)?\s*by\s+(.+)$/i;
/** Trailing clauses that are not part of a handle: "for /X", "v1.0", "1996". */
const AUTHOR_TAIL_RE = /\s+(?:for|fuer|fur)\b.*$|\s+v?\d+[.,]\d+.*$|\s+(?:19|20)\d{2}.*$/i;
const AUTHOR_JUNK_RE = /^[^A-Za-zÀ-ÿ0-9]*(?:\/?X[\\/])?\s*/i;

export function splitAuthor(desc: string, catalogAuthor?: string | null): { text: string; author: string } {
  let found: string | null = null;
  let text = desc;
  const m = AUTHOR_RE.exec(desc);
  if (m) {
    const raw = stripFrameBoth(m[1] ?? '').trim();
    // A credit runs to the end of the line; trim only trailing clauses that
    // clearly are not part of a handle ("for /X", a version, a year).
    const cand = collapse(stripFrameBoth(raw.replace(AUTHOR_TAIL_RE, '')).trim());
    if (cand && cand.length <= 40 && (cand.match(/[A-Za-z0-9]/g) ?? []).length >= 2) {
      found = cand;
      text = `${desc.slice(0, m.index)} ${desc.slice(m.index + m[0].length)}`;
    }
  }
  if (!found && catalogAuthor && catalogAuthor.trim()) found = catalogAuthor.trim();
  return { text: stripFrameBoth(collapse(text)).trim(), author: found ?? '' };
}

const BANNER_SPLIT_RE = /\b(?:presents?|presenting|brings?|bringing|proudly|releases?)\b\s*[:-]*\s*/gi;

/**
 * Split "KiLLraVeN/MYSTiC BRiNGS: KiLLER-BAUD 1.3".
 *
 * A banner names WHO released the door before it names the door. Splitting
 * on the LAST banner word puts the door in the description and hands the
 * credit back as an author when it reads like a handle.
 */
export function splitBannerCredit(text: string): { text: string; credit: string } {
  if (!text) return { text, credit: '' };
  BANNER_SPLIT_RE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = BANNER_SPLIT_RE.exec(text)) !== null) last = m;
  if (!last) return { text, credit: '' };
  const after = stripFrameBoth(text.slice(last.index + last[0].length)).trim();
  const before = stripFrameBoth(text.slice(0, last.index)).trim();
  if (after.length < 4 || !/[A-Za-zÀ-ÿ]{3}/.test(after)) return { text, credit: '' };
  const credit = before && before.length <= 40 && HANDLE_RE.test(before) ? before : '';
  return { text: after, credit };
}

/** Strip art and system tags that bled into the catalog's author field. */
export function cleanAuthor(a: string | null): string {
  if (!a) return '';
  return stripFrameBoth(toPlain(a).replace(AUTHOR_JUNK_RE, '')).trim();
}

// ─── program-name prettifying ──────────────────────────────────────────
//
// binary_name is a FILENAME, so it reads like "5D-SendMessage" or
// "5D_Status.FIM": a group tag, then the door's name run together.

const DOOR_EXT_RE = /\.(exe|fim|xim|aim|sim|tim|iim|rexx|lha|lzx|lzh|info)$/i;
const GROUP_TAG_RE = /^[A-Za-z0-9!$^&*]{1,5}[-_^!.]/;

/**
 * Release-group tags, derived from the corpus itself rather than guessed:
 * any prefix appearing on 3 or more archives. This is what stops "MB-MAKER"
 * becoming "MAKER" and "pizza_taxi" becoming "taxi" - MB and PIZZA are parts
 * of names, not groups, and the data says so.
 */
export function buildGroupTags(archiveNames: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const a of archiveNames) {
    const m = /^([A-Za-z0-9!$^&]{1,5})[-_^!]/.exec(a);
    if (!m) continue;
    const k = m[1].toUpperCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const tags = new Set<string>();
  for (const [k, n] of counts) if (n >= 3) tags.add(k);
  return tags;
}

export function prettifyProgram(prog: string, groupTags: ReadonlySet<string>): string {
  if (!prog) return prog;
  let p = prog.trim().replace(DOOR_EXT_RE, '');
  const m = GROUP_TAG_RE.exec(p);
  if (m) {
    const tag = m[0].slice(0, -1).toUpperCase();
    const stripped = p.slice(m[0].length);
    // only a KNOWN group tag is removed, and only if a name survives
    if (groupTags.has(tag) && (stripped.match(/[A-Za-zÀ-ÿ]/g) ?? []).length >= 3) p = stripped;
  }
  p = p.replace(/_/g, ' ').replace(/-/g, ' ');
  // Split real CamelCase ("SendMessage") but NOT scene mixed-case ("KiLLER",
  // "sTc", "pRESENTS"): only break where the capital begins a lowercase word.
  p = p.replace(/(?<=[a-zà-ÿ]{2})(?=[A-ZÀ-Þ][a-zà-ÿ])/g, ' ');
  p = p.replace(/(?<=[A-Za-zÀ-ÿ])(?=\d)/g, ' ');
  // an acronym followed by a word: LZXstrip -> LZX strip
  p = p.replace(/(?<=[A-ZÀ-Þ])(?=[A-ZÀ-Þ][a-zà-ÿ]{2})/g, ' ');
  return collapse(p);
}

/**
 * Rewrite group-prefixed program names wherever they appear in prose: a DIZ
 * line often names the door in its filename form ("5D-Who coded by sTc/5D").
 */
export function prettifyInText(text: string, groupTags: ReadonlySet<string>): string {
  if (!text) return text;
  return text.replace(/\b([A-Za-z0-9!$^&]{1,5})[-_^!]([A-Za-z][A-Za-z0-9]{2,})/g, (whole, tag: string, rest: string) =>
    groupTags.has(tag.toUpperCase()) ? prettifyProgram(rest, groupTags) : whole
  );
}

// ─── plain-text normalisation ──────────────────────────────────────────

const ALLOWED_PUNCT = new Set(" .,:;!?'\"()[]/\\-_+&%#@*".split(''));

/**
 * Strip decoration, keep meaning. Accented letters stay ("Grüße" is a real
 * word); Latin-1 SYMBOLS go, and that includes everything below 0xC0 ('³',
 * 'µ', '·') - the range scene art draws its pillars and shades from.
 */
export function toPlain(s: string): string {
  if (!s) return s;
  const out: string[] = [];
  for (const ch of s.replace(ANSI_RE, '')) {
    const code = ch.charCodeAt(0);
    if ((code < 0x80 && /[A-Za-z0-9]/.test(ch)) || ALLOWED_PUNCT.has(ch)) {
      out.push(ch);
    } else if (ch === '×' || ch === '÷') {
      out.push(' '); // multiplication/division signs used as bullets
    } else if (code >= 0xc0 && code <= 0xff && isLatin1Letter(ch)) {
      out.push(ch);
    } else {
      out.push(' ');
    }
  }
  // Collapsed but NOT trimmed: the trailing-ornament rules below are
  // anchored at the end of the string, and a border character that became a
  // space is what stops "{o^O}" from being read as an ornamental "O" and
  // shaved off. Trimming here would strip a letter the prototype keeps.
  let t = out.join('').replace(/\s+/g, ' ');
  t = t.replace(/\s*([-/])\s*$/, '');
  // a lone trailing character is scene ornament, not a word ("Viewer ß")
  t = t.replace(/\s+[^\sA-Za-z0-9]$/, '');
  t = t.replace(/\s+([b-hj-z])$/i, '');
  return stripFrameBoth(t).trim();
}

// ─── casing ────────────────────────────────────────────────────────────
//
// Scene text inverts capitals: "aWESOME sYSOP pAGER dOOR 4 dAYdREAM".

/** Acronyms that must survive case normalisation. */
const ACRONYMS = new Set([
  'XIM', 'AIM', 'SIM', 'TIM', 'IIM', 'FIM', 'BBS', 'QWK', 'LZX', 'LHA', 'DMS', 'CRC', 'ZIP',
  'ANSI', 'ASCII', 'MSG', 'OLM', 'ID', 'FTP', 'IRC', 'CPU', 'RAM', 'ROM', 'GUI', 'MUI', 'OS',
  'PC', 'DD', 'ACP', 'UD', 'NUP', 'AGA', 'ECS', 'SX', 'X', 'II', 'III', 'IV',
]);
const MESSY_RE = /[a-zà-ÿ].*[A-ZÀ-Þ]/;

function capitalise(w: string): string {
  if (!w) return w;
  const head = w[0] === 'ß' ? 'Ss' : w[0].toUpperCase();
  return head + w.slice(1).toLowerCase();
}

function tidyWord(w: string, handles: boolean): string {
  const core = w.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (!core || ACRONYMS.has(core.toUpperCase())) return w;
  if (
    handles &&
    core.length >= 2 &&
    core.length <= 3 &&
    core.slice(1) === core.slice(1).toUpperCase() &&
    core[0] === core[0].toLowerCase()
  ) {
    // In an AUTHOR field a short token whose tail is all caps is a group
    // acronym wearing a lowercase hat: lNS -> LNS, dLT -> DLT.
    return w.toUpperCase();
  }
  for (const acr of ACRONYMS) {
    if (acr.length >= 3 && core.toUpperCase().endsWith(acr) && core.length > acr.length) {
      return w; // AmiQWK, LZXstrip: acronym inside the name
    }
  }
  if (MESSY_RE.test(w) || (w[0] === w[0].toLowerCase() && /[A-ZÀ-Þ]/.test(w))) {
    return capitalise(w);
  }
  return w;
}

/** Normalise elite/messy casing and de-shout ALL-CAPS prose. */
export function tidyCase(text: string, handles = false): string {
  if (!text) return text;
  let out = text.replace(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ']*/g, (w) => tidyWord(w, handles));
  const letters = out.match(/[A-Za-zÀ-ÿ]/g) ?? [];
  const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  if (letters.length && upper / letters.length > 0.7) {
    out = out.replace(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ']*/g, (w) =>
      ACRONYMS.has(w.replace(/[^A-Za-zÀ-ÿ]/g, '').toUpperCase()) ? w : capitalise(w)
    );
  }
  return out;
}

// ─── composing name and body ───────────────────────────────────────────

const FILLER = new Set([
  'presents', 'presentz', 'present', 'another', 'tool', 'door', 'doors', 'for', 'the', 'a', 'an',
  'new', 'brings', 'bring', 'by', 'of', 'and', 'is', 'it', 'this', 'x', 'util', 'utility', 'v',
]);

function squash(s: string): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function words(s: string): string[] {
  return s.match(/[A-Za-zÀ-ÿ0-9']+/g) ?? [];
}

/** True when the description only restates the program name. */
export function bodyAddsNothing(prog: string, body: string): boolean {
  if (!prog || !body) return false;
  const sp = squash(prog);
  const sb = squash(body);
  if (!sp || !sb.includes(sp)) return false;
  // A version number is not information either - it has its own column - so
  // "JoinCnf 4.0" still says nothing the name does not.
  const rest = words(body).filter(
    (w) => !FILLER.has(w.toLowerCase()) && !sp.includes(squash(w)) && !/^\d+$/.test(w)
  );
  return rest.length < 2;
}

/**
 * Is the program name present in the body AS WORDS? A squashed-substring
 * test gives false positives: "logon" appears inside "how would you like to
 * log on to your BBS".
 */
export function progCoveredByBody(prog: string, body: string): boolean {
  if (!prog || !body) return false;
  const bw = words(body).map(squash);
  const pw = words(prog).map(squash).filter(Boolean);
  if (!pw.length) return false;
  if (pw.every((w) => bw.includes(w))) return true;
  if (pw.length === 1) {
    for (let i = 0; i < bw.length; i++) {
      if (bw.slice(i, i + 2).join('') === pw[0]) return true;
    }
  }
  return false;
}

/**
 * Does the body already open with the program name? Then it IS the name and
 * prefixing would stutter ("Zippy Search - Zippy Search for /X").
 */
export function bodyStartsWithProg(prog: string, body: string): boolean {
  if (!prog || !body) return false;
  const bw = words(body).map(squash);
  const sp = squash(prog);
  let acc = '';
  for (const w of bw.slice(0, 4)) {
    acc += w;
    if (acc === sp) return true;
    if (acc.length > sp.length) break;
  }
  return false;
}

export function compose(prog: string, body: string): string {
  if (prog && (!body || bodyAddsNothing(prog, body))) return prog;
  if (prog && bodyStartsWithProg(prog, body)) return body;
  if (prog && body) return `${prog} - ${body}`;
  return prog || body;
}

/**
 * Remove a version glued onto the program name ("aereg 106" + 1.06), but
 * only when the digits actually match the version we extracted, so
 * "Snes-Tool 110" is not mangled when no version was found.
 */
export function stripVersionTail(prog: string, version: string): string {
  if (!prog || !version) return prog;
  const m = /\s*\d{2,4}[a-z]?$/i.exec(prog);
  if (!m) return prog;
  const digits = m[0].replace(/[^0-9]/g, '');
  const flat = version.replace(/[^0-9]/g, '');
  const flatTrim = flat.replace(/0+$/, '') || flat;
  const strip = (s: string): string => s.replace(/^0+/, '');
  if (
    digits &&
    flat &&
    (digits === flat || strip(digits) === strip(flat) || digits === flatTrim || strip(digits) === strip(flatTrim))
  ) {
    return stripFrameBoth(prog.slice(0, m.index)).trim();
  }
  return prog;
}

/**
 * An all-lowercase program name reads better capitalised (dreamstatus ->
 * Dreamstatus); names carrying deliberate casing (AmiQWK) are left alone.
 */
export function capitaliseName(prog: string): string {
  if (!prog || !/[A-Za-zÀ-ÿ]/.test(prog[0])) return prog;
  return prog === prog.toLowerCase() ? prog[0].toUpperCase() + prog.slice(1) : prog;
}

/**
 * Archive names almost always encode the version: ACC-V105 -> 1.05,
 * 5D-ED121 -> 1.21, AC092 -> 0.92. Used ONLY as a last resort, and only for
 * digit runs that read unambiguously - a single trailing digit ("5D-CS3") is
 * as likely to be a revision as a version, so it is left alone.
 */
export function versionFromFilename(archiveName: string): string {
  let stem = archiveName.replace(/\.(lha|lzx|lzh|zip|dms)$/i, '');
  stem = stem.replace(/[_\-^!]+$/, '');
  const m = /[vV]?(\d{2,3})[a-zA-Z]?$/.exec(stem);
  if (!m) return '';
  const d = m[1];
  if (d.length === 3) return `${Number(d[0])}.${d.slice(1)}`;
  return `${Number(d[0])}.${d[1]}`;
}

/** The archive's own name with its extension stripped. */
function archiveBase(archiveName: string): string {
  const dot = archiveName.lastIndexOf('.');
  return dot === -1 ? archiveName : archiveName.slice(0, dot);
}

// ─── the door's short name ─────────────────────────────────────────────
//
// The catalog's `name` is whatever the corpus builder found at the top of
// the DIZ, so for 1031 of 3301 rows it is the box border itself and for
// others it is a whole banner line. A listing needs a NAME.

const NAME_WORDS = 4;

/**
 * A value shaped like a filename rather than a name: it ends in a program
 * extension, or - the scene-signature case - it BEGINS with one.
 * "exe.-l0S-eND0S-bBS-.exe" is the catalog name AND binary_name of 41
 * archives.
 */
const FILENAME_SHAPED = /\.(exe|info|rexx|xim|aim|fim|sim|tim|iim|lha|lzx|dms)\s*$|^(?:exe|com|bat|dll)\./i;

/**
 * Is this a NAME rather than a piece of box art? The bar is lower than for a
 * description: "Bull", "DMS" and "Avail" are real door names and would fail
 * the description scorer's six-character minimum. What a name may not be is
 * decoration.
 */
export function looksLikeName(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t || t.length > 40) return false;
  if (ART_RE.test(t)) return false;
  if (!WORD_RE.test(t)) return false;
  if (highBitShare(t) > 0.3) return false;
  return alnumShare(t) > 0.5;
}

/**
 * A short label for a door: its catalog name when that reads as a name, then
 * its program name, then the archive's own name. Never box art.
 *
 * A name is ONE CELL of a box row and at most four words - past that it is a
 * sentence, and the program name reads better in a column.
 */
/** Where a door's displayed name came from - what the admin UI needs to
 * know which names are real and which are guesses from a filename. */
export type NameSource = 'catalog' | 'program' | 'archive';

export function displayName(
  name: string | null,
  binaryName: string | null,
  archiveName: string,
  groupTags: ReadonlySet<string>
): string {
  return readName(name, binaryName, archiveName, groupTags).name;
}

export function readName(
  name: string | null,
  binaryName: string | null,
  archiveName: string,
  groupTags: ReadonlySet<string>
): { name: string; source: NameSource } {
  const raw = (name ?? '').trim();
  const fromArchive = (): { name: string; source: NameSource } => ({
    name: tidyCase(toPlain(prettifyInText(archiveBase(archiveName), groupTags))),
    source: 'archive',
  });
  const prog = prettifyProgram(toPlain(binaryName ?? ''), groupTags);
  const progOk = prog.length >= 3 && (prog.match(/[A-Za-zÀ-ÿ]/g) ?? []).length >= 3 && alnumShare(prog) > 0.5;

  if (FILENAME_SHAPED.test(raw)) {
    // ...and when the program name is the same junk, the archive's own name
    // is the only honest label left.
    if (progOk && !FILENAME_SHAPED.test((binaryName ?? '').trim())) {
      return { name: tidyCase(capitaliseName(prog)), source: 'program' };
    }
    return fromArchive();
  }

  let candidate = toPlain(clean(raw));
  // A banner names the GROUP and then the door, so the door is what follows
  // it - the same split the description rules make. When nothing usable
  // follows (the rest is a date, or border), what precedes it is tried too,
  // and if neither reads as a name the archive has the last word.
  const split = splitBannerCredit(candidate);
  if (split.text !== candidate) {
    candidate = looksLikeName(split.text) ? split.text : '';
  } else if (BANNER_RE.test(candidate)) {
    // A banner word with nothing usable after it ("Ir\/ANA presents ---
    // 02/15/98"): the group and a date, and no door name anywhere in it.
    candidate = '';
  }
  for (const cell of candidate.split(CELL_SPLIT_RE)) {
    if (cell === undefined) continue;
    const cleaned = toPlain(clean(cell));
    if (looksLikeName(cleaned)) {
      candidate = cleaned;
      break;
    }
  }

  const words = candidate.split(/\s+/).filter(Boolean);
  if (looksLikeName(candidate) && words.length <= NAME_WORDS) {
    return { name: tidyCase(capitaliseName(candidate)), source: 'catalog' };
  }
  if (progOk) {
    return { name: tidyCase(capitaliseName(prog)), source: 'program' };
  }
  if (looksLikeName(candidate)) {
    return { name: tidyCase(capitaliseName(words.slice(0, NAME_WORDS).join(' '))), source: 'catalog' };
  }
  return fromArchive();
}

// ─── the whole reading ─────────────────────────────────────────────────

export interface DoorFacts {
  /** One line, at most 60 characters, of what the door is. */
  description: string;
  /** The door's own version ("1.05"), or ''. */
  version: string;
  /** Who coded it ("Killraven/Mystic"), or ''. */
  author: string;
  /** Which BBS it needs ("/X 3.38+"), or ''. */
  requiresBbs: string;
}

export interface DoorInput {
  dizText: string | null;
  name: string | null;
  archiveName: string;
  binaryName: string | null;
  catalogVersion?: string | null;
  catalogAuthor?: string | null;
}

/**
 * Read a door's four facts out of its DIZ, its catalog row and its archive
 * name, in that order of trust.
 */
export function analyseDoor(input: DoorInput, groupTags: ReadonlySet<string>): DoorFacts {
  const prettyProg = prettifyProgram(toPlain(input.binaryName ?? ''), groupTags);
  // binary_name is sometimes a stray token like "8" or "."; a program name
  // must look like a name.
  const progOk =
    prettyProg.length >= 3 && (prettyProg.match(/[A-Za-zÀ-ÿ]/g) ?? []).length >= 3 && alnumShare(prettyProg) > 0.5;
  let prog = progOk ? prettyProg : '';

  let body = describeBlock(input.dizText, 70, prog || null);
  if (!body && input.name) {
    const named = clean(input.name);
    body = score(named).score > 0 ? named : '';
  }
  if (!body) {
    // Last resort: the archive's own base name. It joins the chain HERE
    // rather than being returned at the end, so it gets the same treatment
    // as any other body - "AE_DOORS" loses its group tag and "DATELINE"
    // stops shouting.
    body = archiveBase(input.archiveName);
  }
  body = toPlain(prettifyInText(body, groupTags));

  const banner = splitBannerCredit(body);
  body = banner.text;

  const req = splitBbsRequirement(body);
  body = req.text;
  const requiresBbs = req.requires || bbsRequirementFromDiz(input.dizText);

  const ver = splitVersion(body, input.catalogVersion);
  body = ver.text;

  const auth = splitAuthor(body, input.catalogAuthor ?? banner.credit);
  body = auth.text;

  prog = capitaliseName(stripVersionTail(prog, ver.version));
  if (prog && progCoveredByBody(prog, body)) prog = '';

  let description = finalise(toPlain(compose(tidyCase(prog), tidyCase(body))));
  if (!description) {
    // Everything the DIZ offered was a credit: KDZ!LUDB.LHA's only prose
    // line is "dONE bY sERAPH - !BUGFIXED VERSION", which moves wholesale
    // into the author field and leaves nothing behind. A row with no
    // description at all is worse than one named after its archive.
    description = finalise(toPlain(tidyCase(prettifyInText(archiveBase(input.archiveName), groupTags))));
  }

  return {
    description,
    version: ver.version || versionFromFilename(input.archiveName),
    author: tidyCase(cleanAuthor(auth.author), true),
    requiresBbs,
  };
}
