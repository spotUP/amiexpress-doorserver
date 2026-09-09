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

/**
 * Bumped whenever a rule change moves any fixture's output.
 *
 * The BBS vendors a generated mirror of this file and runs the same rules over
 * the same committed fixtures; this version is what the two sides compare so a
 * stale mirror is caught as a mismatch rather than as a silent divergence in
 * what a caller reads about a door.
 */
export const DESCRIBE_CONTRACT_VERSION = '6';

/** Frame punctuation: decoration at either end of a cell. Isolated high-bit art like Ü/Û/ß/±²³ also counts as frame. */
const FRAME = " :-*()[]|_=+~<>.,'\"`^¦¬·°#!?/\\ÜÛßÝÞ±²³";

const ART_RE = /^[\s_\-=*#~/\\|:.,+()[\]<>'"`^¦°·;!?%$&@ÜÛßÝÞ±²³]*$/;
const BANNER_RE = /\b(presents?|brings?|proudly|releases?|bringing|presenting)\b/i;

/** Credits, distribution notes and dates: never a description. */
const JUNK_RE =
  /passed\s+thr|courier|released?\s+(on|at|by)|\bthanx|greets?\b|\bdate\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|^\s*(by|coded\s+by|written\s+by)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*,?\s*\d/i;

/** A copyright/credit line: attribution, not a description. */
const COPYRIGHT_RE = /©|\(c\)/i;

/** A handle on a line of its own: "sNoW^5D", "Jordan/5D". */
const HANDLE_RE = /^[A-Za-z0-9!._-]{2,20}\s*[\^/]\s*[A-Za-z0-9!._-]{2,20}$/;

/** Is this line a person's handle rather than a door's name? */
export function looksLikeHandle(text: string): boolean {
  return HANDLE_RE.test((text ?? '').trim());
}

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
  /\b(?:now\s+work(?:s|ing)|works?\s+(?:only\s+)?(?:with|on)|requires?|needs?)\b.{0,12}\b(?:\/?X|amiexpress|fame|daydream|tempest|cnet|\d)/i;

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
    // Prefer to cut at a sentence boundary only when it keeps most of the cap.
    // Cutting at the first sentence (e.g. 65/120) would discard a whole wrapped
    // paragraph that follows; word-boundary keeps more content for multiline DIZs.
    const cut = out.slice(0, cap);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (sentenceEnd > cap * 0.65) {
      out = cut.slice(0, sentenceEnd + 1);
    } else {
      out = cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
    }
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

function plainForScoring(s: string): string {
  return toPlain(s);
}

function score(line: string): Scored {
  const c = clean(line);
  if (!c || ART_RE.test(c)) return { score: -99, text: c };
  const p = plainForScoring(c);
  if (!p || ART_RE.test(p)) return { score: -99, text: c };
  if (!WORD_RE.test(p)) return { score: -99, text: c };
  if (highBitShare(c) > 0.3) return { score: -99, text: c };
  if (alnumShare(c) < 0.5) return { score: -99, text: c };
  // Frame-density early reject: a line that is >40% frame punctuation + high-bit art
  // with very few real words is a border, even if one word slipped through.
  const frameChars = (p.match(/[_\-=*#~\/\\|:.,+()[\]<>'"`^¦°·;!?%$&@]/g) ?? []).length;
  if (p.length > 10 && frameChars / p.length > 0.4) {
    const w = p.match(/[A-Za-zÀ-ÿ]{3,}/g) ?? [];
    if (w.length <= 1) return { score: -99, text: c };
  }
  if (c.length < 6) return { score: -50, text: c };
  let s = 0;
  // JUNK/COPYRIGHT/COMPAT are tested on the cleaned form `c` so "©" and "courier"
  // are not missed after plain conversion. Courier as a BBS name is not junk in
  // the sense of a distribution note — penalise it less so a wrapped sentence
  // like "S!X and Courier clones. Since I was..." does not split the paragraph.
  const isCourierOnly = /\bcourier\b/i.test(c) && !/passed\s+thr|released?\s+(on|at|by)|\bthanx|greets?\b|\bdate\b|\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b|^\s*(by|coded\s+by|written\s+by)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*,?\s*\d/i.test(c);
  if (isCourierOnly) s -= 8;
  else if (JUNK_RE.test(c)) s -= 40;
  if (COPYRIGHT_RE.test(c)) s -= 40;
  if (COMPAT_RE.test(c)) s -= 8;
  if (HANDLE_RE.test(c)) s -= 40;
  if (VERSIONISH_RE.test(p)) s += 12;
  if (DOORISH_RE.test(p)) s += 8;
  const words = p.match(/[A-Za-zÀ-ÿ]{3,}/g) ?? [];
  s += Math.min(words.length, 6) * 3;
  if (p.length > 55) s -= 4;
  if (p.split(/\s+/).length <= 2 && p.length < 20) s -= 2;
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
    const p = plainForScoring(s.text);
    const isHandle = HANDLE_RE.test(p.trim());
    const prose = s.score > 0 && !isHandle;
    if (prose) {
      if (!cur.length) starts.push(i);
      cur.push(s);
    } else if (cur.length) {
      blocks.push(cur);
      cur = [];
    }
  });
  if (cur.length) blocks.push(cur);
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
  // DEBUG
  // console.log("chosen block", chosen.map(x=>x.text), "cap", cap);
  parts[0] = parts[0].replace(/^(presents?|brings?|proudly|releases?|presenting|bringing)\b[\s:.-]*/i, '');
  parts[0] = stripFrameBoth(parts[0].replace(/^\d{1,2}[.)]\s+/, '')).trim();
  // DIZ feature lists are bulleted ("o Totally NEW Lay-Out"); the bullet is
  // decoration, and joining two bulleted lines must not read "Lay-Out o
  // Manages up to 256 Cnfs".
  parts = parts.map((p) => finalise(p.replace(/^[o*·+]\s+/, ''), cap)).filter((p) => p.length > 0);
  // console.log("parts after finalise", parts);
  if (!parts.length) return '';

  // A first line that already stands on its own IS the description - only
  // keep appending while it is too short to mean anything by itself.
  // Improved: allow wrapping when the next line is clearly a continuation:
  // next starts lowercase (wrapped mid-sentence, e.g. KCL's "all the other
  // utils..."), or the *original* DIZ line ended with comma/hyphen (so the
  // cleaned text lost it, e.g. "for /X," -> "for /X"), even if already >=30.
  const chosenIdx = blocks.indexOf(chosen);
  const chosenStart = starts[chosenIdx] ?? 0;
  let text = parts[0];
  for (let idx = 1; idx < parts.length; idx++) {
    const next = parts[idx];
    const rawPrevLine = (lines[chosenStart + idx - 1] ?? '').trim();
    const rawPrevEndsCommaHyphen = /[,\-]\s*$/.test(rawPrevLine);
    const nextStartsLower = /^[a-zà-ÿ]/.test(next.trim());
    const textEndsCommaHyphen = /[,\-]$/.test(text.trim());
    const shouldJoin = text.length < 30 || textEndsCommaHyphen || rawPrevEndsCommaHyphen || nextStartsLower;
    if (!shouldJoin) break;
    if (text.endsWith('-') && /^[A-Za-zÀ-ÿ]/.test(next)) {
      text = text + next;
    } else {
      // Fix broken words split across lines without hyphen: "requester" + "s," -> "requesters,"
      const broken = next.match(/^([a-zA-Z]{1,3})([.,]?)(\s+.*)?$/);
      const prevLastWord = text.split(/\s+/).pop() || '';
      // Debug for BBSG203
      // if (prevLastWord === 'requester' && broken) console.log("broken", broken, "prev", prevLastWord, "next", JSON.stringify(next.slice(0,20)));
      if (
        broken &&
        prevLastWord.length >= 4 &&
        /^[a-z]{1,3}$/i.test(broken[1]) &&
        /^(s|es|ed|ing|ers|est|ly|en|ion|ions|er|or|ment)$/i.test(broken[1]) &&
        !/^[.!?]$/.test(text.trim().slice(-1))
      ) {
        const frag = broken[1];
        const punct = broken[2] || '';
        const rest = (broken[3] || '').trim();
        const combined = prevLastWord + frag;
        if (combined.length >= 5 && !prevLastWord.toLowerCase().endsWith('s') && frag.toLowerCase() === 's') {
          const words = text.split(/\s+/);
          words[words.length - 1] = combined + punct;
          text = words.join(' ') + (rest ? ' ' + rest : '');
        } else if (frag.length <= 3) {
          if (broken[1].length <= 2 && rest.length > 0) {
            const w2 = text.split(/\s+/);
            w2[w2.length - 1] = combined + punct;
            const candidate = w2.join(' ') + (rest ? ' ' + rest : '');
            if (/^[a-z]/.test(rest) || rest === '') {
              text = candidate;
            } else {
              text = `${text} ${next}`;
            }
          } else {
            text = `${text} ${next}`;
          }
        } else {
          text = `${text} ${next}`;
        }
      } else {
        text = `${text} ${next}`;
      }
    }
    if (text.length >= cap) break;
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
const BBS_CONTEXT_RE = /(?:\/X|amiexpress|ami|s!x|fame|daydream|tempest|cnet|for)\s*$/i;

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
  '/x': 'AmiExpress',
  x: 'AmiExpress',
  amiexpress: 'AmiExpress',
  ae: 'AmiExpress',
  's!x': 'System-X',
  sx: 'System-X',
  fame: 'FAME',
  daydream: 'DayDream',
  dd: 'DayDream',
  dreamdoor: 'DayDream',
  tempest: 'Tempest',
  cnet: 'CNet',
};

const BBS_REQ_RE =
  /(?:\b(?:for|only\s+for|requires?|required|needs?|works?\s+(?:only\s+)?(?:with|on)|coded\s+for|written\s+for|compatible\s+with)\b\s*[:-]?\s*)?(?<![A-Za-zÀ-ÿ0-9])(\/X|Ami-?Express|S!X|FAME|DayDream|Tempest|CNet|AE|X)\s*(?:v(?:er(?:sion)?)?\.?\s*)?(\d{1,2}(?:[.,](?:[0-9]{1,3}[a-z]?|[xX]{1,3}))?\+?)/i;

/**
 * A bare BBS-name mention with no version attached - "for /X", "AmiExpress
 * or compatibilities", "col Dor for /X, S-EXPRES". BBS_REQ_RE needs a
 * trailing version number to anchor a match, which most such mentions
 * never give it, but the mention alone is enough to know which BBS a door
 * targets (the version simply isn't stated). "AE" and bare "X" are left
 * out here - both are common short tokens with no distinctive shape when
 * unversioned, so unlike "/X" or "FAME" they would false-positive constantly.
 */
const BARE_BBS_RE = /\/X\b|\bAmi-?Express\b|\bS!X\b|\bFAME\b|\bDayDream\b|\bTempest\b|\bCNet\b/i;

/**
 * `ver` is accepted (and ignored) for backward compatibility with callers
 * that still extract a version alongside the name - filtering by "which
 * BBS" never needs the specific point release (unlike the door's own
 * version, which stays exact elsewhere): "/X 3.x", "/X 4.x" and bare
 * "AmiExpress" are all the same requirement, and fragmenting the "Any BBS
 * version" filter by point release just turns it into a wall of
 * near-duplicates of the same handful of entries.
 */
export function normaliseRequirement(name: string, _ver: string): string {
  const key = name.toLowerCase().replace(/-/g, '');
  return BBS_NAMES[key] ?? name;
}

function stripBbsMatch(
  desc: string,
  m: RegExpExecArray,
  requires: string
): { text: string; requires: string } {
  const rest = stripFrameBoth(collapse(`${desc.slice(0, m.index)} ${desc.slice(m.index + m[0].length)}`)).trim();
  // A row that says nothing BUT which BBS it needs keeps saying it: the
  // requirement is then all the description has.
  if (!/[A-Za-zÀ-ÿ]{3}/.test(rest)) return { text: desc, requires };
  return { text: rest, requires };
}

export function splitBbsRequirement(desc: string): { text: string; requires: string } {
  if (!desc) return { text: desc, requires: '' };
  const m = BBS_REQ_RE.exec(desc);
  if (m) return stripBbsMatch(desc, m, normaliseRequirement(m[1], m[2]));
  const bare = BARE_BBS_RE.exec(desc);
  if (bare) return stripBbsMatch(desc, bare, normaliseRequirement(bare[0], ''));
  return { text: desc, requires: '' };
}

/**
 * The requirement is a property of the ARCHIVE, not of the one line that got
 * picked as the description - "XIM - /X 3.38+" often sits in the bottom
 * border of the box, which no description would ever quote.
 */
export function bbsRequirementFromDiz(diz: string | null): string {
  if (!diz) return '';
  // Raw, minus control codes only: every tidy-up in this module strips
  // frame characters off the ends, and "/X 3.38+" sits flush against the
  // box border - so the "+", the whole difference between "3.38" and
  // "3.38 or later", would be stripped as decoration.
  const lines = diz
    .replace(/\r/g, '')
    .split('\n')
    .map((raw) => raw.replace(ANSI_RE, '').replace(/[\x00-\x1f\x7f]/g, ' '));
  for (const line of lines) {
    const m = BBS_REQ_RE.exec(line);
    if (m) return normaliseRequirement(m[1], m[2]);
  }
  // Versioned match failed for every line - try a bare mention before
  // giving up. A second pass, not folded into the loop above, so a late
  // bare "/X" never wins over an earlier versioned "FAME 1.30" elsewhere
  // in the same DIZ.
  for (const line of lines) {
    const bare = BARE_BBS_RE.exec(line);
    if (bare) return normaliseRequirement(bare[0], '');
  }
  return '';
}

// ─── author ────────────────────────────────────────────────────────────

const AUTHOR_RE = /\s*[-,]?\s*\b(?:coded|written|programmed|created|made|done)?\s*by\s+(.+)$/i;
/** Trailing clauses that are not part of a handle: "for /X", "v1.0", "1996",
 *  and "On 30/11/95" (a DD/MM/YY date after On gloms onto the author). */
const AUTHOR_TAIL_RE =
  /\s+(?:for|fuer|fur)\b.*$|\s+v?\d+[.,]\d+.*$|\s+(?:19|20)\d{2}.*$|\s+[Oo]n\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b.*$/i;
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
/**
 * Split art-joined words where a high-bit pillar sits between two letter runs.
 * e.g. "LightúBar" -> "Light Bar" but "Grüße" stays. Heuristic: the join is art
 * when the high-bit char is between an upper+lower boundary or between two
 * distinct capitalised words; legitimate German ü/ä/ö sits inside a single
 * lowercase-run word. We normalise the narrow case that leaks into descriptions:
 * a high-bit char flanked by a word-char on both sides where either side
 * triggers a case transition (upper↔lower) is treated as a separator.
 */
function splitArtJoinedWords(s: string): string {
  // Isolated high-bit art pillars like "Ü", "ß", "Û", "±²" that are not part of a word:
  // "Ü ß User-Setting Door" -> "  User-Setting Door", "full.lightbar.driven Û Û ctl" -> "full lightbar driven   ctl"
  // Keep legitimate German "Grüße" where ü/ß are inside a word, not isolated.
  let out = s.replace(/\b[ÜÛßÝÞ±²³]{1,3}\b/g, ' ');
  // Dots and ",." used as word separators in DIZ art: "full.lightbar.driven" -> "full lightbar driven",
  // "driven,.x/y" -> "driven, x/y", "color.configuration-file" already handled, but ",." -> ", "
  out = out.replace(/,\s*\.\s*/g, ', ');
  out = out.replace(/\.\s*,\s*/g, ', ');
  // Dots used as word separators in DIZ art: "full.lightbar.driven" -> "full lightbar driven"
  // Keep version dots like "v0.63" (digit dot digit) and "v1.01".
  out = out.replace(/(?<=[A-Za-zÀ-ÿ])\.(?=[A-Za-zÀ-ÿ])/g, ' ');
  return out.replace(/(?<=[A-Za-zÀ-ÿ])[\u0080-\u00ff](?=[A-Za-zÀ-ÿ])/g, (m, _off, full) => {
    const before = full[_off - 1] ?? '';
    const after = full[_off + m.length] ?? '';
    const beforeIsUpper = before === before.toUpperCase() && before !== before.toLowerCase();
    const afterIsUpper = after === after.toUpperCase() && after !== after.toLowerCase();
    // "LightúBar" : T (upper/lower mix) -> B upper => split
    // "Grüße" : r lower -> ß (non-ASCII) lower => keep
    if (beforeIsUpper !== afterIsUpper) return ' ';
    // Between two capitals is always a separator in this corpus
    if (beforeIsUpper && afterIsUpper) return ' ';
    return m;
  });
}

export function toPlain(s: string): string {
  if (!s) return s;
  let src = splitArtJoinedWords(s);
  const out: string[] = [];
  for (const ch of src.replace(ANSI_RE, '')) {
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
  '5TH', 'PWS',
  // Amiga door/BBS
  'XIM', 'AIM', 'SIM', 'TIM', 'IIM', 'FIM', 'BBS', 'QWK', 'LZX', 'LHA', 'DMS', 'CRC', 'ZIP',
  'ANSI', 'ASCII', 'MSG', 'OLM', 'ID', 'FAME', 'DIZ', 'NFO', 'DOC', 'TXT', 'CFG',
  'UL', 'DL', 'LF', 'CR', 'BS', 'ESC', 'NAK', 'ACK', 'SOH', 'STX', 'ETX', 'EOT',
  // Hardware / platform
  'CPU', 'RAM', 'ROM', 'GUI', 'MUI', 'OS', 'PC', 'DD', 'ACP', 'UD', 'AGA', 'ECS', 'SX',
  'NTSC', 'PAL', 'A1200', 'A500', 'A600', 'CD32', 'CDTV', 'VGA', 'SVGA', 'HAM', 'EHB',
  'OCS', 'RTG', 'RTG', 'ISA', 'IDE', 'SCSI', 'ATA', 'SATA', 'USB', 'NMI',
  'II', 'III', 'IV', 'IX', 'XL', 'XT', 'AT', 'DX', 'SX',
  // Networking / comms
  'FTP', 'IRC', 'TCP', 'IP', 'UDP', 'SSH', 'SSL', 'TLS', 'HTTP', 'HTTPS', 'URL', 'URI',
  'DNS', 'DHCP', 'LAN', 'WAN', 'WIFI', 'MODEM', 'BPS', 'CTS', 'RTS', 'DTR', 'DSR', 'DCD',
  'RAS', 'SLIP', 'PPP', 'UUCP', 'FIDO', 'FREQ',
  // File / disk
  'HD', 'DD', 'SS', 'DS', 'MB', 'KB', 'GB', 'TB', 'BPS', 'RPM',
  'FAT', 'NTFS', 'HFS', 'EXT', 'ISO', 'UDF',
  // Software / general computing
  'API', 'SDK', 'IDE', 'OS', 'DOS', 'BIOS', 'CMOS', 'ROM', 'RAM', 'VRAM',
  'ALU', 'FPU', 'MMU', 'DMA', 'IRQ', 'IO', 'POS', 'COM', 'LPT', 'PRN',
  'DPI', 'CRT', 'LCD', 'LED', 'OLED', 'HDTV',
  'HTML', 'CSS', 'XML', 'JSON', 'SQL', 'CSV', 'TSV', 'PDF', 'PNG', 'GIF', 'JPG', 'JPEG', 'BMP',
  'BBS', 'FIDONET', 'Internet', 'Usenet',
  'DB', 'DBA', 'DBMS', 'RDBMS', 'ACID',
  'AI', 'ML', 'VR', 'AR', 'CAD', 'CAM', 'CAI', 'CBE',
  'MP3', 'MP4', 'AVI', 'WAV', 'OGG', 'FLAC', 'AAC',
  'CD', 'DVD', 'BD', 'CDR', 'CDRW', 'DVDR',
  'DIY', 'FAQ', 'RTFM', 'GFDL', 'GPL', 'LGPL', 'MIT', 'BSD',
  'ALSA', 'JCL', 'TCL', 'PERL', 'AWK', 'SED',
  'NMI', 'CLI', 'GUI', 'TUI', 'CUI', 'NUI',
]);
const MESSY_RE = /[a-zà-ÿ][A-ZÀ-Þ]|[A-ZÀ-Þ].*[a-zà-ÿ]|[a-z0-9].*[A-Z]|[A-Z].*[a-z0-9]/;
/**
 * CamelCase / PascalCase: capital + lowercase (at least 3 letters), then one or more
 * internal capital+lowercase subwords of at least 3 letters. These are intentional
 * product names like SmokeySmallStats, SplitChat, FileThing - NOT messy caps like
 * "FiNe" (2+2) or "Thiz" which are elite, not CamelCase. Requiring 3+ letters per
 * hump keeps "FiNe" from being preserved as-is.
 */
const CAMEL_RE = /^[A-ZÀ-Þ][a-zà-ÿ]{2,}(?:[A-ZÀ-Þ][a-zà-ÿ]{2,})+$/;

const LEET_MAP: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };
function deLeet(word: string): string {
  // Handle "Thiz" -> "This" (z for s) – common elite for "This", "is", "as", etc. where z replaces s at end
  if (/^Thiz$/i.test(word)) return word[0] === 'T' ? 'This' : word.replace(/z$/i, 's');
  // Never translate a leading digit: "1oo", "5TH", "3D" are names/ordinals, not leet
  if (/^[0-9]/.test(word)) return word;
  // Don't translate trailing version-like digits: "beta3", "Bu1", "C120" is a version, not leet
  const trailingDigits = word.match(/[0-9]+$/);
  const hasTrailingVersionDigits = trailingDigits && word.replace(/[0-9]+$/, '').length >= 1;
  if (hasTrailingVersionDigits && trailingDigits[0].length <= 4 && !/[A-Za-z].*[0-9].*[A-Za-z]/.test(word)) {
    if (/^[A-Za-z]+[0-9]+$/i.test(word)) return word;
  }
  if (!/[A-Za-z]/.test(word) || !/[0-9]/.test(word)) {
    if (/^[A-Za-z]+z$/i.test(word) && word.length <= 5) {
      const lower = word.toLowerCase();
      if (['thiz', 'l0z', 'coz', 'cuz', 'plz'].includes(lower)) return lower === 'thiz' ? 'This' : word.slice(0, -1) + (word.endsWith('z') ? 's' : 'S');
    }
    return word;
  }
  if (/^v?\d+(\.\d+)?$/i.test(word)) return word;
  return word.replace(/[0134578]/g, (c) => LEET_MAP[c] ?? c);
}

function capitalise(w: string): string {
  if (!w) return w;
  const head = w[0] === 'ß' ? 'Ss' : w[0].toUpperCase();
  return head + w.slice(1).toLowerCase();
}

function tidyWord(w: string, handles: boolean): string {
  // Keep "5TH" (5th) and "PWs" (passwords) canonical – don't de-leet or re-case them
  if (/^5TH$/i.test(w)) return '5TH';
  if (/^PWS$/i.test(w)) return 'PWs';
  // Ordinals/group tags like "5D", "4DOS", "3D" are names, not leet – leave exactly as is
  if (/^[0-9]+[A-Za-z]+$/.test(w)) return w;
  // De-leet common elite digits inside words like d00R -> door, Sh0W -> Show, but keep version-like tokens
  const deLeeted = deLeet(w);
  const effective = deLeeted !== w && /[A-Za-z]/.test(deLeeted) ? deLeeted : w;
  const core = effective.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (!core) return w;
  if (ACRONYMS.has(core.toUpperCase())) {
    // If we de-leeted, return the de-leeted and cased form, not the original digits
    if (effective !== w) {
      const cap = core === core.toUpperCase() || core.length < 2 ? effective : effective.replace(/[A-Za-zÀ-ÿ]/g, (c) => c.toUpperCase());
      // For de-leeted words, just capitalise the de-leeted form
      if (core !== core.toUpperCase() && effective !== w) return capitalise(effective);
    }
    // An acronym survives normalisation in its canonical form: "BBS" stays
    // "BBS", and scene-cased "bBS" is rewritten "BBS" - never left half-shouted.
    // Single letters are exempt: lowercase "x" in "v4.x" is a placeholder, not
    // the /X BBS software wearing a hat.
    return core === core.toUpperCase() || core.length < 2
      ? w
      : w.replace(/[A-Za-zÀ-ÿ]/g, (c) => c.toUpperCase());
  }
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
  // A word shouted in ALL CAPS inside otherwise mixed text is shouting, not
  // a product name: "The BEST & FASTEST door" -> "The Best & Fastest door".
  // The whole-string de-shout below only fires when MOST of the text is
  // caps, so shouted words used to hide in mixed-case strings. Single
  // letters are exempt ("4 U"); known acronyms never reach here.
  if (core.length >= 2 && core === core.toUpperCase() && core !== core.toLowerCase()) {
    return capitalise(effective);
  }
  if (MESSY_RE.test(effective) || (effective[0] === effective[0].toLowerCase() && /[A-ZÀ-Þ]/.test(effective))) {
    if (CAMEL_RE.test(effective)) return w; // SmokeySmallStats, SplitChat - keep as-is (on effective, not w, so de-leeted still checked)
    // For de-leeted words like d00R->dooR, capitalise the de-leeted form to get Door, not D00r
    if (effective !== w) return capitalise(effective);
    return capitalise(w);
  }
  // If we de-leeted (d00R -> door) but it wasn't considered messy, still return the de-leeted lowercased form
  // e.g. "d00R" de-leeted to "door" should become "door" lower, then later sentence-cased to "Door"
  if (effective !== w) {
    // Preserve the de-leeted letters but keep original casing for now; the outer tidyCase will handle sentence case
    // For "d00R" -> "dooR" -> we want "door" lower, which capitalise will later make "Door" via sentence case
    // So return effective lowercased
    return effective.toLowerCase();
  }
  return w;
}

/** Normalise elite/messy casing and de-shout ALL-CAPS prose. */
export function tidyCase(text: string, handles = false): string {
  if (!text) return text;
  // Include digits inside words so leet like "d00R" and "Sh0W" is treated as one token, not "d" + "R"
  let out = text.replace(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9']*/g, (w) => tidyWord(w, handles));
  const letters = out.match(/[A-Za-zÀ-ÿ]/g) ?? [];
  const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  if (letters.length && upper / letters.length > 0.7) {
    out = out.replace(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9']*/g, (w) =>
      ACRONYMS.has(w.replace(/[^A-Za-zÀ-ÿ0-9]/g, '').toUpperCase()) ? w : capitalise(w)
    );
  }
  return out;
}

/** Normalise casing for the "fix casing" button: sentence case with whitespace cleanup. */
export function fixCasing(text: string): string {
  if (!text) return text;

  // Protect ANSI escape sequences (Esc[XXm) from all processing.
  const ansi: string[] = [];
  let out = text.replace(/\x1b\[[0-9;]*m/g, (m) => { ansi.push(m); return `\x00ANSI${ansi.length - 1}\x00`; });
  // Also protect literal "Esc[XXm" representations used in plain-text DIZ files.
  out = out.replace(/Esc\[\d{0,3}m/gi, (m) => { ansi.push(m); return `\x00ANSI${ansi.length - 1}\x00`; });

  // Strip box-art borders: pipes, colons used as borders, leading/trailing dashes
  out = out.replace(/[|]/g, ' ');

  // Strip ASCII-art decoration: sequences of 3+ slashes/backslashes
  // (with optional spaces between) that form box-drawing art.
  // Protects legitimate content like "/X" (single slash + letter).
  out = out.replace(/[/\\](?:\s*[/\\]){2,}/g, ' ');

  // Strip trailing dashes left over from box-art borders (e.g. "text!!!-")
  out = out.replace(/[-]{1,3}\s*$/g, '');

  // Collapse multiple lines/whitespace to single line
  out = out.replace(/\s+/g, ' ').trim();

  // Strip excessive punctuation: !!!! → !, ??? → ?, ... (trailing or excessive) → .
  out = out.replace(/!{2,}/g, '!');
  out = out.replace(/\?{2,}/g, '?');
  out = out.replace(/\.{4,}/g, '...');
  // Strip trailing ellipsis noise (e.g. "text! ...")
  out = out.replace(/\s*\.{3}\s*$/g, '');

  // Space after commas in lists: "TXT,DMS,LZX" → "TXT, DMS, LZX"
  out = out.replace(/,(\S)/g, ', $1');

  // Spacing around & : "node&time" → "node & time"
  out = out.replace(/(\w)&(\w)/g, '$1 & $2');

  // Remove space before ! and !! (and other punctuation)
  out = out.replace(/\s+([!?])/g, '$1');

  // De-shout ALL-CAPS text first - but preserve words containing acronyms
  const letters = out.match(/[A-Za-zÀ-ÿ]/g) ?? [];
  const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  if (letters.length && upper / letters.length > 0.7) {
    out = out.replace(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ']*/g, (w) => {
      const core = w.replace(/[^A-Za-zÀ-ÿ]/g, '').toUpperCase();
      if (ACRONYMS.has(core)) return w;
      for (const acr of ACRONYMS) {
        if (acr.length >= 3 && core.endsWith(acr) && core.length > acr.length) return w;
      }
      return w.toLowerCase();
    });
  }

  // Fix individual words: canonicalise acronyms, lowercase everything else
  // Include digits so leet "d00R" is one token, not "d" + "R"
  out = out.replace(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9']*/g, (w) => {
    const core = w.replace(/[^A-Za-zÀ-ÿ0-9]/g, '');
    if (!core) return w;
    if (core.length < 2) return w;
    if (ACRONYMS.has(core.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I'))) {
      return core === core.toUpperCase() ? w : core.toUpperCase();
    }
    for (const acr of ACRONYMS) {
      if (acr.length >= 3 && core.toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').endsWith(acr) && core.length > acr.length) return w;
    }
    return w.toLowerCase();
  });

  // Apply sentence case: capitalise first letter, and first letter after sentence-ending punctuation
  out = out.replace(/(^|[.!?]\s+)([a-zà-ÿ])/g, (match, sep, letter) => {
    return sep + letter.toUpperCase();
  });

  // Restore ANSI escape sequences.
  out = out.replace(/\x00ANSI(\d+)\x00/g, (_, i) => ansi[Number(i)]);

  return out;
}

/** Words that stay lowercase in title case unless they're the first word. */
const TITLE_CASE_LOWERCASE = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'yet', 'so',
  'at', 'by', 'in', 'of', 'on', 'to', 'up', 'as', 'is', 'vs',
]);

/**
 * Title case for door names: capitalise most words, keep small words
 * lowercase unless they're the first word. Like This Example.
 */
export function fixTitleCasing(text: string): string {
  if (!text) return text;

  // Start with fixCasing to normalise whitespace, acronyms, etc.
  let out = fixCasing(text);

  // Apply title case: capitalise every word, then lowercase the small words
  out = out.replace(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9']*/g, (w) => {
    const core = w.replace(/[^A-Za-zÀ-ÿ0-9]/g, '');
    if (!core) return w;
    // Always capitalise acronyms
    if (ACRONYMS.has(core.toUpperCase().replace(/0/g, 'O'))) {
      return core.toUpperCase();
    }
    return capitalise(w);
  });

  // Now lowercase the small words, but not the first word
  let first = true;
  out = out.replace(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9']*/g, (w) => {
    const core = w.replace(/[^A-Za-zÀ-ÿ0-9]/g, '').toLowerCase();
    if (first) { first = false; return w; }
    if (TITLE_CASE_LOWERCASE.has(core)) {
      return core;
    }
    return w;
  });

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

/** Door-type tokens that are metadata, not description. PPe/PPE is the
 *  PCBoard door type and appears as "PPe v1.o" in many DIZs; it should not
 *  stay in the description after the version is stripped. */
const DOOR_TYPE_TOKENS = new Set(['ppe', 'xim', 'aim', 'fim', 'tim', 'iim', 'rexx', 'exe', 'lha', 'lzh', 'lzx', 'dms', 'zip']);
export function stripDoorTypeTokens(desc: string): string {
  if (!desc) return desc;
  // Remove standalone PPe/PPE etc. when they appear as a separate word,
  // especially trailing or before end. Keep it when it's part of a larger
  // phrase like "LHA tester" – but "PPe" alone at end is junk.
  // For now, strip any standalone token that is exactly a door type and
  // is at the end or followed only by punctuation, and also strip "PPe"
  // anywhere it appears as a separate word that looks like a type tag
  // (e.g. "Enhancer PPe" -> "Enhancer").
  let out = desc;
  // First, handle "PPe" specifically: remove " PPe" (case-insensitive) as a whole word
  out = out.replace(/\s+PPe\b/gi, (m) => {
    // Keep it if it's clearly part of description like "PPe door" – but
    // "PPe" is almost never descriptive, it's the door kind.
    // The user's report: file_ids have PPe from release group, not description.
    return '';
  });
  // General door types at end: " ... XIM" or " ... PPE"
  out = out.replace(new RegExp(`\\s+(${Array.from(DOOR_TYPE_TOKENS).join('|')})\\s*$`, 'i'), '');
  return collapse(out);
}

export function ensureEndsWithPunctuation(s: string): string {
  if (!s) return s;
  const t = s.trim();
  if (!t) return t;
  if (/[.!?]$/.test(t)) return t;
  if (/\.\.\.$/.test(t)) return t;
  return t + '.';
}

export function ensureCapitalized(s: string): string {
  if (!s) return s;
  const t = s.trim();
  if (!t) return t;
  // Preserve elite/mixed-case openers like "fUCKLHA" or "eBay": only capitalize
  // a plain lowercase start, never re-case a word that already carries capitals
  const firstWord = t.split(/\s+/)[0] ?? '';
  if (/[A-ZÀ-Þ]/.test(firstWord.slice(1))) return t;
  return t[0].toUpperCase() + t.slice(1);
}

/** Strip a leading prog name that duplicated the separate `name` column.
 *  e.g. "Bbsguard . One of the best..." -> "One of the best...",
 *  "Bbsguard - One of..." -> "One of...",  "Kclhaad LHA tester..." -> "LHA tester..."
 *  Uses squash (alphanumeric only, lowercased) so "BBS Guard" matches "Bbsguard"
 *  and "Adi Menu" matches "AdiMenu". Handles " - ", " . ", ".", ":", etc. */
export function stripLeadingProg(desc: string, prog: string): string {
  if (!desc || !prog) return desc;
  const progTrim = prog.trim();
  if (!progTrim) return desc;
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const progSquash = squash(progTrim);
  if (!progSquash) return desc;
  const descSquash = squash(desc);
  // Exact prog alone – don't strip (bodyAddsNothing case)
  if (descSquash === progSquash) return desc;
  if (!descSquash.startsWith(progSquash)) return desc;
  // Also require word-boundary: the prog prefix must be followed by a word break in desc,
  // otherwise "BBS" would strip from "BBSize" incorrectly. Check that the character after
  // prog in desc is not a letter/digit (or desc is longer).
  // Find where prog ends in desc by counting words that squash to prog.
  const progWords = progTrim.split(/\s+/).filter(Boolean);
  const descWords = desc.split(/\s+/);
  // Try word-wise first (handles "Adi Menu" -> "Adi Menu Handles...")
  let wordMatch = true;
  for (let i = 0; i < progWords.length; i++) {
    if (squash(descWords[i] || '') !== squash(progWords[i])) {
      wordMatch = false;
      break;
    }
  }
  if (wordMatch) {
    if (descWords.length === progWords.length) return desc;
    return descWords.slice(progWords.length).join(' ').trim().replace(/^[.\-:\s]+/, '').trim();
  }
  // Fallback: squash prefix match (handles "BBS Guard" vs "Bbsguard")
  // Find the split point in desc where squash reaches prog length
  let acc = '';
  let splitIdx = -1;
  for (let i = 0; i < descWords.length; i++) {
    acc += squash(descWords[i]);
    if (acc === progSquash) {
      splitIdx = i;
      break;
    }
    if (acc.length > progSquash.length) break;
  }
  if (splitIdx !== -1) {
    return descWords.slice(splitIdx + 1).join(' ').trim().replace(/^[.\-:\s]+/, '').trim();
  }
  // Last resort: regex with optional space/punctuation (handles "Bbsguard . One...")
  const esc = progTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixed = new RegExp(`^${esc}\\s*[\\-\\.:]*\\s*`, 'i');
  if (prefixed.test(desc)) {
    const stripped = desc.replace(prefixed, '').trim();
    if (stripped) return stripped;
  }
  return desc;
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
  /**
   * One line, at most 60 characters, of what the door is. null when the
   * DIZ is just an ASCII art banner with no real description - in that
   * case the UI shows nothing rather than the program's title or
   * group credit (which would be misleading).
   */
  description: string | null;
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
 * Scan the whole DIZ for a version, preferring one near the program name/title.
 * Falls back to splitVersion on the description body when the DIZ scan finds nothing.
 */
export function versionFromDizWhole(diz: string | null, prog?: string | null): string {
  if (!diz) return '';
  const lines = diz.replace(/\r/g, '').split('\n').map((l) => l.replace(ANSI_RE, '').replace(/[\x00-\x1f\x7f]/g, ' '));
  let best: { ver: string; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Try version regexes on this line
    for (const re of [VER_RE, BARE_VER_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (BBS_CONTEXT_RE.test(line.slice(0, m.index))) continue;
        const ver = normaliseVersion(m[1] ?? m[2]);
        let sc = 10;
        // Bonus if near program name or title on same line or adjacent
        if (prog && line.toLowerCase().includes(prog.toLowerCase().slice(0, 4))) sc += 8;
        if (i < 3) sc += 3; // title area
        if (best === null || sc > best.score) best = { ver, score: sc };
        break; // one per line is enough
      }
      if (best && best.score >= 18) break;
    }
  }
  return best?.ver ?? '';
}

export function authorFromDizWhole(diz: string | null): string {
  if (!diz) return '';
  const lines = diz.replace(/\r/g, '').split('\n').map((l) => l.replace(ANSI_RE, '').replace(/[\x00-\x1f\x7f]/g, ' '));
  for (const line of lines) {
    const p = toPlain(clean(line));
    const m = AUTHOR_RE.exec(p);
    if (m) {
      const raw = stripFrameBoth(m[1] ?? '').trim();
      const cand = collapse(stripFrameBoth(raw.replace(AUTHOR_TAIL_RE, '')).trim());
      if (cand && cand.length <= 40 && (cand.match(/[A-Za-z0-9]/g) ?? []).length >= 2) {
        return cand;
      }
    }
  }
  return '';
}

/**
 * Read a door's four facts out of its DIZ, its catalog row and its archive
 * name, in that order of trust.
 */
export function analyseDoor(input: DoorInput, groupTags: ReadonlySet<string>): DoorFacts {
  const prettyProg = prettifyProgram(toPlain(input.binaryName ?? ''), groupTags);
  const progOk =
    prettyProg.length >= 3 && (prettyProg.match(/[A-Za-zÀ-ÿ]/g) ?? []).length >= 3 && alnumShare(prettyProg) > 0.5;
  let prog = progOk ? prettyProg : '';

  // Use a 250-char cap for the body reconstruction so wrapped paragraphs are not truncated.
  // The manifest's list.txt slice (src/manifest.ts:438) still caps at 120 for Amiga clients.
  let body = describeBlock(input.dizText, 250, prog || null);
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

  // Whole-DIZ scans for version/author — these see lines outside the chosen paragraph.
  const dizVer = versionFromDizWhole(input.dizText, prog || input.name);
  const dizAuthor = authorFromDizWhole(input.dizText);

  const ver = splitVersion(body, dizVer || input.catalogVersion);
  body = ver.text;

  const auth = splitAuthor(body, dizAuthor || (input.catalogAuthor ?? banner.credit));
  body = auth.text;

  const originalProgForStrip = prog;
  prog = capitaliseName(stripVersionTail(prog, ver.version));
  if (prog && progCoveredByBody(prog, body)) prog = '';

  // 250-char cap: a wrapped DIZ paragraph is often 120-200 chars; 60/120 truncated mid-sentence
  // (e.g. "Additional", "so", "Walls" at 119, KCL's "and I really" at 119). 250 keeps the full
  // paragraph for the JSON manifest and web UI; list.txt still does its own 120-char slice.
  let composed = finalise(toPlain(compose(tidyCase(prog), tidyCase(body))), 250);
  // Strip leading prog name – the name is already a separate column, so
  // "Bbsguard . One of the best..." should be just "One of the best...".
  // Use original prog (before progCoveredByBody cleared it) so "Adi Menu
  // Handles..." where body already starts with prog is also stripped.
  const progForStrip = tidyCase(originalProgForStrip || prog);
  let description: string | null = composed ? stripLeadingProg(composed, progForStrip) : null;
  // Also try stripping the catalog name when prog was empty (e.g. KCL where
  // binaryName is null but DIZ starts with "Kclhaad")
  if (description && input.name) {
    const nameForStrip = tidyCase(toPlain(input.name));
    const alt = stripLeadingProg(description, nameForStrip);
    if (alt !== description && alt) description = alt;
  }
  if (description && input.archiveName) {
    const baseForStrip = tidyCase(toPlain(archiveBase(input.archiveName)));
    const alt2 = stripLeadingProg(description, baseForStrip);
    if (alt2 !== description && alt2 && alt2.length >= 20) description = alt2;
  }
  // Strip door-type tokens like PPe/PPE that are metadata, not description.
  // e.g. "Light Bar Enhancer PPe" -> "Light Bar Enhancer"
  if (description) description = stripDoorTypeTokens(description);
  // Ensure description starts with capital and ends with punctuation.
  if (description) description = ensureCapitalized(description);
  if (description) description = ensureEndsWithPunctuation(description);
  if (!description) {
    // Everything the DIZ offered was a credit (KDZ!LUDB.LHA's only
    // prose line is "dONE bY sERAPH - !BUGFIXED VERSION", which moves
    // wholesale into the author field) or a banner with no real
    // description. Rather than fall back to the program name and
    // mislead the UI into showing a title, return null - the field
    // simply has no description.
    description = null;
  }

  return {
    description,
    version: ver.version || versionFromFilename(input.archiveName),
    author: tidyCase(cleanAuthor(auth.author), true),
    requiresBbs,
  };
}
