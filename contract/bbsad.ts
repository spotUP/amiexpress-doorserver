/**
 * BBS text-ad field extractor.
 *
 * Reads structured facts out of Demozoo BBS text ads (ASCII/ANSI art with
 * embedded contact lines): phone numbers, node counts, staff handles and
 * group affiliations. Built for the 10,554-ad corpus in data/bbs_ads.db,
 * tuned against hand-checked fixtures in contract/bbsad-fixtures.json.
 *
 * Contract rules (same as contract/describe.ts, which this sits beside):
 * pure text processing, NO imports - the BBS vendors this file standalone
 * and proves identity through the shared fixture corpus. A rule change that
 * moves an output fails tests/bbsad.test.ts: regenerate the fixtures and
 * bump BBSAD_CONTRACT_VERSION.
 *
 * What it deliberately does NOT do: staff lines without markers
 * ("Muad'Dib - Lightning - Eurobyte"), prose description, or anything
 * requiring layout understanding. Those are follow-ups, not gaps in this
 * contract.
 */

export const BBSAD_CONTRACT_VERSION = '1';

export interface ParsedAd {
  /** Phone-number strings exactly as printed, in first-seen order. */
  phones: string[];
  /** Node count (first explicit count wins), or null when unstated. */
  nodes: number | null;
  /** nick^group / nick/group handles, original case, first-seen order. */
  handles: string[];
  /** "group WHQ/EHQ/HQ/GHQ" affiliations, lowercased, first-seen order. */
  groups: string[];
}

/** ANSI colour sequences are invisible in a terminal but break matching. */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b/g;

/**
 * Box-drawing and ornament code points carry no words. Kept deliberately
 * narrow: letters (incl. Latin-1), digits and the punctuation phones and
 * handles need (+ - . / ( ) ^ ! ' &) survive; everything else is a space.
 * Matches the spirit of describe.ts toPlain without importing it.
 */
function plainLine(line: string): string {
  const out: string[] = [];
  for (const ch of line.replace(ANSI_RE, '')) {
    const code = ch.charCodeAt(0);
    if (
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0xc0 && code <= 0xff && ch.toLowerCase() !== ch.toUpperCase()) ||
      ch === ' ' || ch === '+' || ch === '-' || ch === '.' || ch === '/' ||
      ch === '(' || ch === ')' || ch === '^' || ch === '!' || ch === '&' ||
      ch === "'" || ch === ':' || ch === ',' || ch === 'x' || ch === 'X'
    ) {
      out.push(ch);
    } else {
      out.push(' ');
    }
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

const PHONE_RES: RegExp[] = [
  // +49 (0)30 123456 / +1-800-ASK-TRSI (letters allowed at the tail)
  /\+\d{1,3}[\s\-./()]*\d[\d\s\-./()]*\d[A-Za-z]*/,
  // 071-1234567 / (404) 452-7387 / 408-251-6220 - but never starting
  // mid-number (8346349 must not yield 46349): no digit, dot or dash
  // immediately before, no digit immediately after.
  /(?<![\d.\-])\(?\d{2,5}\)?[\s\-.]\d{2,8}([\s\-.]\d{1,8})?(?!\d)/,
  // 31-340-889-039 / 46-0243-87645
  /\b\d{2,4}[.\-]\d{2,4}[.\-]\d{3,6}\b/,
];

/** A phone candidate must carry at least 7 digits - fewer is a date, a
 * version, or a counter (30.7.95, v1.4, 0/1). */
function digits(n: string): number {
  return (n.match(/\d/g) ?? []).length;
}

/**
 * Modem speeds and years glue themselves onto numbers through the
 * separator-tolerant phone patterns ("+46-239610 28800", "...420 1992").
 * Peel them off the tail before masking - a real subscriber block never
 * looks exactly like a speed or a year.
 */
const TAIL_JUNK_RE = /[\s\-./()]+(300|1200|2400|4800|9600|14400|19200|28800|33600|56000|57600|64000|115200|128000|19[789]\d|20[0-3]\d)$/;

function trimPhoneTail(span: string): string {
  let s = span.trimEnd();
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(TAIL_JUNK_RE, '');
  }
  return s.trimEnd();
}

const NODE_RES: RegExp[] = [
  /(\d{1,3})\s*nodes?\b/i,
  /(\d{1,3})[\s\-]*node[\s\-]*system/i,
];

/** "arcade whq", "MySTiC Dutch hQ": one or two words before the role.
 * A trailing ! belongs to the NAME ("CoCaIne! hQ"), never to a preceding
 * word ("sTAff! CoCaIne! hQ" is one group, not two): the two-word form
 * requires clean endings, the one-word form tolerates one trailing !. */
const GW = String.raw`[A-Za-z0-9&'\-]{1,18}`;
const GW2 = String.raw`[A-Za-z0-9&'\-]{2,18}`;
const GROUP_RE = new RegExp(`\\b(${GW}(?:\\s+${GW2})?)\\s*!*\\s*(whq|ehq|hq|ghq|dhq|shq)\\b`, 'gi');

/** nick^group / nick/group. Shape-checked below (speeds, versions and
 * platform pairs wear the same clothes). */
const HANDLE_RE = /\b([A-Za-zÀ-ÿ0-9!._-]{2,20})[\^/]([A-Za-zÀ-ÿ0-9!._-]{2,20})\b/g;

const PLATFORMS = new Set(
  ['amiga', 'pc', 'c64', 'console', 'vhs', 'pal', 'ntsc', 'aga', 'ecs', 'dos'].map((w) => w.toLowerCase())
);

/**
 * Ordinary words that wear the nick/group shape in section lists and labels
 * ("Time/Date Uploaded", "consoles/amiga/graffiti/ascii", "analoge/isdn").
 * Whole-part match only - a handle merely CONTAINING one still counts.
 */
const HANDLE_STOPWORDS = new Set(
  [
    'time', 'date', 'info', 'mail', 'text', 'file', 'bbs',
    'consoles', 'console', 'amiga', 'graffiti', 'ascii', 'hiphop', 'hiphopmp3',
    'mp3', 'pc', 'classicgames', 'linux', 'drugs', 'telnet', 'analoge', 'isdn',
  ].map((w) => w.toLowerCase())
);

function isHandle(a: string, b: string): boolean {
  // Both sides need a letter (kills 2400/9600, 14.4/19.2, 486/4Omhz),
  // neither side a bare number, neither side a platform, a stopword, or a
  // section noun.
  if (!/[A-Za-z]/.test(a) || !/[A-Za-z]/.test(b)) return false;
  if (/^\d[\d.]*$/.test(a) || /^\d[\d.]*$/.test(b)) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (PLATFORMS.has(al) || PLATFORMS.has(bl)) return false;
  if (HANDLE_STOPWORDS.has(al) || HANDLE_STOPWORDS.has(bl)) return false;
  return /^[A-Za-zÀ-ÿ0-9!._-]{2,20}\s*[\^/]\s*[A-Za-zÀ-ÿ0-9!._-]{2,20}$/.test(`${a}/${b}`);
}

export function parseAd(text: string | null): ParsedAd {  const phones: string[] = [];
  const handles: string[] = [];
  const groups: string[] = [];
  let nodes: number | null = null;
  if (!text) return { phones, nodes, handles, groups };

  for (const raw of text.split('\n')) {
    const line = plainLine(raw);
    if (line.length < 4) continue;

    for (const re of PHONE_RES) {
      const m = re.exec(line);
      if (m) {
        const span = trimPhoneTail(m[0]);
        if (digits(span) >= 7 && !phones.includes(span.trim()) && span.trim()) {
          phones.push(span.trim());
          break;
        }
      }
    }

    if (nodes === null) {
      for (const re of NODE_RES) {
        const m = re.exec(line);
        if (m) {
          nodes = parseInt(m[1], 10);
          break;
        }
      }
    }

    for (const m of line.matchAll(GROUP_RE)) {
      const g = `${m[1]} ${m[2]}`.toLowerCase().replace(/\s+/g, ' ');
      if (!groups.includes(g)) groups.push(g);
    }

    for (const m of line.matchAll(HANDLE_RE)) {
      if (isHandle(m[1], m[2]) && !handles.includes(m[0])) handles.push(m[0]);
    }
  }

  return { phones, nodes, handles, groups };
}

/**
 * Mask a phone number for storage and display: keep country + area code
 * (up to 6 digits), mask the subscriber part. The final run is always
 * masked, and everything after the keep-cut (digits AND vanity letters)
 * becomes `*`. Separators and shape survive so the number still reads as
 * a number:
 *
 *   +31-(0)-204-930-420 -> +31-(0)-204-***-***
 *   713-460-8217        -> 713-460-****
 *   (404) 452-7387      -> (404) 452-****
 */
export function maskPhone(phone: string): string {
  const runs: Array<{ start: number; end: number }> = [];
  for (const m of phone.matchAll(/\d+/g)) {
    runs.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  if (runs.length === 0) return phone;
  let kept = 0;
  let cut = 0;
  for (let i = 0; i < runs.length - 1; i++) {
    if (kept >= 6) break;
    const len = runs[i].end - runs[i].start;
    // Never show more than 6 digits (country + area), and a single long
    // opening run (1234567-89, or a closed-plan +47 63903364) is cut to
    // what the budget allows instead of smuggling the subscriber past it.
    const take = Math.min(len, (kept === 0 ? 4 : 6) - kept);
    if (take <= 0) break;
    kept += take;
    cut = runs[i].start + take;
  }
  let out = '';
  for (let i = 0; i < phone.length; i++) {
    const ch = phone[i];
    out += i < cut ? ch : /[A-Za-z0-9]/.test(ch) ? '*' : ch;
  }
  return out;
}

/**
 * Mask every phone-number-looking span in free text (same detection rule
 * parseAd uses: a PHONE_RES hit with at least 7 digits). Any future
 * display path for ad text must go through here - stored phones_json is
 * masked, but the raw text column is not.
 */
export function maskPhonesInText(text: string | null): string | null {
  if (!text) return text;
  return text
    .split('\n')
    .map((line) => {
      let out = line;
      for (const re of PHONE_RES) {
        out = out.replace(new RegExp(re.source, 'gi'), (m) => {
          const span = trimPhoneTail(m);
          return digits(span) >= 7 ? maskPhone(span) : m;
        });
      }
      return out;
    })
    .join('\n');
}
