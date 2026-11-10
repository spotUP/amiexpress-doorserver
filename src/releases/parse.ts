/**
 * AquaScan BBS file-listing parser.
 *
 * The source is one long capture (`BBS_filelist (1).txt`, ~179 MB, ~2.4M lines,
 * 299,437 entries over 66 dirs, 1988–2026) that looks like a terminal transcript:
 * ornament lines, `[ File #N ]` headers, prompts, menus and login chatter around
 * the actual entries. Only the entries matter; everything else is skipped by a
 * line state machine that never holds the whole file (streaming, O(1) memory).
 *
 * Entry grammar (stable across the whole capture):
 *
 *   [ File #N ]  +  border line            <- block start, file_no = N
 *   FILENAME(13-col) FLAG SIZE DATE desc…  <- the ONE entry line; desc continues
 *     continuation lines (leading spaces) <- same paragraph / inline art DIZ
 *
 * Column layout of the entry line (measured, not guessed):
 *   - cols 0–12: filename, space-padded, MAY contain spaces ("BIBLE3 WRP")
 *   - col 13: flag letter (case-insensitive) or space = none
 *   - cols 14–20: size, right-aligned; OR a nuke reason when flag is D
 *     (`>NUKED<`, `DELETED`, `RENAMED`, `>>OLD<<`, `ONLINE!`, `------`, …)
 *   - cols 23–30: date MM-DD-YY. Century pivot: YY>=80 → 19YY else 20YY.
 *   - col 33+: first description words.
 *
 * Variants the fixed columns cannot hold (each seen in the corpus):
 *   - lowercase flag (`ABREED1.DMS  p 750777 …`)
 *   - no flag, long size (`mwi-karm.lha 16193257  09-18-01 …`, size ends col 20)
 *   - `[DELETED]` suffix instead of flag/size
 *     (`TP5-ANDR.LHA [DELETED] 12-30-95  .---…`) → flag D, size NULL
 *
 * Description-block metadata lines (parsed out, NOT fed to the extractor):
 *   - `d/L tIMES: N` → download count (newer entries only)
 *   - `Uploader >>note<<` trailer (e.g. `Bigophone >>last Belgian Trader <<`)
 *     → uploader hint. Best-effort: a line whose only `>>…<<` content matches.
 *   - Explicit credit lines → uploader, first match wins. Full-line anchored
 *     (`Sent by: X`, `Uploaded by X`, `Smashed by X`, `Supplied by X`,
 *     `Brought [to you] by X`, `Uploader: X`, all case-insensitive) plus a
 *     trailing `…upload by X` (e.g. `Another Graff-tastic upload by Graffito`).
 *     Measured 2026-09-10 over 299,437 entries: chevron 6,044 + explicit
 *     3,350 (overlap 29) ≈ 3.1% name an uploader. Deliberately NOT read:
 *     `[-nick-]` bracket runs (39,721 last-lines) and `( nick )` fills are
 *     courier/greet credits in the art, not the uploader — minting uploaders
 *     from them would be false data. `Courier:`/`Sysop:` are role labels,
 *     not uploaders, and are left in the description.
 *
 * The remaining block lines are the entry's mini file_id: single-line prose,
 * wrapped prose, or a full inline ASCII-art DIZ — the same three shapes
 * `contract/describe.ts` already reads, so the importer feeds them straight
 * to `analyseDoor`.
 */
import * as fs from 'fs';
import * as readline from 'readline';

export interface FileListEntry {
  /** 1-based dir from `Scanning dir N` (dir 1 is implicit: file starts with it). */
  dirNo: number;
  /** `[ File #N ]` number; restarts at 1 per dir. */
  fileNo: number;
  filename: string;
  /** N/P/D/F/O/X, upper-cased; '' when the column is blank. Stored raw. */
  flag: string;
  /** Byte size, or null when the size column holds a nuke reason. */
  sizeBytes: number | null;
  /** Raw size column when it is not bytes (`>NUKED<`, `DELETED`, …). */
  sizeNote: string | null;
  /** Entry date as ISO `YYYY-MM-DD`. */
  dateIso: string;
  /** `d/L tIMES:` value, or null when the block has none. */
  dlCount: number | null;
  /** `Name >>note<<` trailer, or null. */
  uploader: string | null;
  /** Description lines (first-line words + continuations), raw. */
  descLines: string[];
}

/** YY>=80 → 19YY else 20YY (owner-confirmed 2026-09-09; oldest entry is 1988). */
export function pivotYear(yy: number): number {
  return yy >= 80 ? 1900 + yy : 2000 + yy;
}

export function toIsoDate(mm: string, dd: string, yy: string): string {
  const y = pivotYear(Number(yy));
  return `${y}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

const DATE_RE = /(\d{2})-(\d{2})-(\d{2})/;
const DELETED_RE = /^(\S+(?: \S+)*?)\s*\[DELETED\]\s+(\d{2})-(\d{2})-(\d{2})\s?(.*)$/;
const FLAGLESS_RE = /^(.+?)\s+(\d[\d,]*)\s+(\d{2})-(\d{2})-(\d{2})\s?(.*)$/;
const DL_RE = /d\/L tIMES:\s*(\d+)/;
/**
 * Chevron trailer. The name may not START with `>`/`<`: art title lines like
 * `>>>>> -+- The Beast of Scoopex -+- <<<<<` (1,419 in the corpus) otherwise
 * match with the "name" being a lone `>` — measured 2026-09-10, 1,119
 * entries carried uploader `>`.
 */
const UPLOADER_RE = /^\s*([^\s<>][^<>]*?)\s*>>(.+)<<\s*$/;
/**
 * Explicit uploader credits, full-line anchored (case-insensitive). `Uploader:`
 * is the 90s email-posting header (top of block, rarely last); the rest are
 * usually the last line. `Courier:`/`Sysop:` are excluded on purpose: roles,
 * not uploaders.
 */
const EXPLICIT_UPLOADER_RES = [
  /^\s*sent\s+by\s*:?\s*(.+?)\s*$/i,
  /^\s*upload(?:ed)?\s+by\s*:?\s*(.+?)\s*$/i,
  /^\s*smashed\s+by\s*:?\s*(.+?)\s*$/i,
  /^\s*suppl(?:ied|y)\s+by\s*:?\s*(.+?)\s*$/i,
  /^\s*brought\s+(?:to\s+you\s+)?by\s*:?\s*(.+?)\s*$/i,
  /^\s*uploader\s*:\s*(.+?)\s*$/i,
];
/** Trailing `…upload by X` inside a longer line (never the anchored form). */
const TRAILING_UPLOAD_BY_RE = /upload\s+by\s+([A-Za-z0-9!_?'\/\-\\]+)\s*$/i;

/**
/** Placeholder credits that name nobody (`Uploader: unknown`, `Sent by: -`). */
const UPLOADER_JUNK_RE = /^(unknown|none|n\/a|na|\?+|-+|\.+)$/i;

/**
 * Light cleanup for uploader credits: trim, collapse whitespace, strip one
 * layer of symmetric wrapping (`*** X ***`, `---[ X ]---` → `X`). Case and
 * `!`/`.` are left alone — scene nicks are stylized (`sHANE/CRUX!`,
 * `Sonic!`) and stripping them would corrupt the name. Returns null when
 * nothing usable remains.
 */
export function normalizeUploader(raw: string): string | null {
  let s = raw.trim().replace(/\s+/g, ' ');
  if (!s || UPLOADER_JUNK_RE.test(s)) return null;
  for (;;) {
    const before = s;
    // Balanced outer pairs: [X], (X), "X", 'X'.
    const pair = s.match(/^([\[("'])(.*)([\])"'])$/);
    if (pair && pair[2].trim()) s = pair[2].trim();
    // Edge ornament runs: ***, ---, ___, ~~~, ### (+ spaces).
    s = s.replace(/^[*\-_=~#]+\s*(.*?)\s*[*\-_=~#]+$/, '$1').trim();
    if (s === before) break;
  }
  return s || null;
}

/** First explicit credit match in a line, normalized — or null. */
export function matchExplicitUploader(line: string): string | null {
  for (const re of EXPLICIT_UPLOADER_RES) {
    const m = line.match(re);
    if (m) return normalizeUploader(m[1]);
  }
  const t = line.match(TRAILING_UPLOAD_BY_RE);
  if (t) return normalizeUploader(t[1]);
  return null;
}
/**
 * Inline download-count stamp the BBS burns into art lines at a fixed column:
 * `                       DL's: 10  \  ___//…` — the same art one dir over
 * (e.g. dir 16's copy of FLT-TT2.DMS) has plain spaces there. The stamp is
 * always `DL's: NN` (zero-padded, 8 chars) after 15+ spaces, followed by 2+
 * spaces and art. Replacing it with equal spaces restores the art byte-exact
 * (proved against the unstamped twin) and yields the download count.
 * The 15-space minimum keeps a hypothetical legit DIZ line mentioning
 * downloads out of harm's way — DIZ prose never indents that deep.
 */
const DL_STAMP_RE = /^( {15,})DL's: (\d\d)(?=\s)/;

/**
 * Repair double-encoded text baked into the capture (`Â¬` for `¬`, `Ã©`
 * for `é`): some tool read Latin-1 bytes as characters and UTF-8-encoded
 * them again, so the file holds C3 82 C2 A9 where C2 A9 belongs. 607k
 * `Â`+symbol and 56k `Ã`+symbol runs measured 2026-09-10, almost all box
 * art (`Â·`, `Â¯`, `Â»`, `Ã·`, `Ã¸`).
 *
 * Only the printable range is repaired: hits decoding to C1 controls
 * (8k, e.g. `Ã\x8d`) are left alone — those are likelier art bytes than
 * text, and "fixing" them would mint control characters. A legit `Â`
 * followed by ASCII (`Âge`) or a symbol outside the range never matches.
 */
export function repairDoubleEncoded(s: string): string {
  if (!s || (s.indexOf('Â') === -1 && s.indexOf('Ã') === -1)) return s;
  return s
    .replace(/Â([\u00a0-\u00bf])/g, (_m, c: string) => String.fromCharCode((c as string).charCodeAt(0)))
    .replace(/Ã([\u00a0-\u00bf])/g, (_m, c: string) =>
      String.fromCharCode(0xc0 | ((c as string).charCodeAt(0) & 0x3f))
    );
}
/** AquaScan's own ornament (`_¸,ø*¤…_¸_`) and its date line — the next entry's
 *  header, not this entry's description. Only ever stripped from the END of a
 *  block, so identical glyphs inside real art are untouched. */
const ORNAMENT_RE = /¸,ø\*¤|^\s*¸.*\d{2}-\d{2}-\d{2}\s*$/;

export interface ParsedEntryLine {
  filename: string;
  flag: string;
  sizeField: string;
  mm: string;
  dd: string;
  yy: string;
  firstDesc: string;
}

/**
 * Parse ONE entry line. Returns null when the line is not an entry line at
 * all (ornament, prompt, continuation art). Three shapes, tried in order:
 * fixed columns → flagless fallback → `[DELETED]` fallback.
 */
export function parseEntryLine(line: string): ParsedEntryLine | null {
  const noNl = repairDoubleEncoded(line.replace(/[\r\n]+$/, ''));
  // 1. Fixed columns: 13-char name, flag letter-or-blank at col 13.
  if (noNl.length > 30) {
    const nameField = noNl.slice(0, 13);
    const flagCh = noNl[13];
    if (/[A-Za-z ]/.test(flagCh ?? '')) {
      const rest = noNl.slice(14);
      const m = rest.match(/^\s*(\S+)\s+(\d{2})-(\d{2})-(\d{2})\s*(.*)$/);
      if (m) {
        const filename = nameField.trim();
        if (filename) {
          return {
            filename,
            flag: flagCh === ' ' ? '' : flagCh.toUpperCase(),
            sizeField: m[1],
            mm: m[2],
            dd: m[3],
            yy: m[4],
            // Column padding only; art alignment lives in continuation lines.
            firstDesc: (m[5] ?? '').trim(),
          };
        }
      }
    }
  }
  // 2. `[DELETED]` suffix form: no flag, no size.
  const del = noNl.match(DELETED_RE);
  if (del) {
    return {
      filename: del[1].trim(),
      flag: 'D',
      sizeField: 'DELETED',
      mm: del[2],
      dd: del[3],
      yy: del[4],
      firstDesc: del[5] ?? '',
    };
  }
  // 3. Flagless form: name, spaces, bare size, date. A trailing single
  // letter on the name is a flag the fixed columns missed (long names).
  const less = noNl.match(FLAGLESS_RE);
  if (less) {
    let filename = less[1].trim();
    let flag = '';
    const fm = filename.match(/^(.*\S)\s+([A-Za-z])$/);
    if (fm && 'NPDFOX'.includes(fm[2].toUpperCase()) && fm[1].length <= 13) {
      filename = fm[1];
      flag = fm[2].toUpperCase();
    }
    if (filename && !filename.startsWith('[')) {
      return {
        filename,
        flag,
        sizeField: less[2],
        mm: less[3],
        dd: less[4],
        yy: less[5],
        firstDesc: (less[6] ?? '').trim(),
      };
    }
  }
  return null;
}

/** Split the size column into bytes vs. nuke-reason note. */
export function splitSize(sizeField: string): { sizeBytes: number | null; sizeNote: string | null } {
  const digits = sizeField.replace(/,/g, '');
  if (/^\d+$/.test(digits)) {
    return { sizeBytes: Number(digits), sizeNote: null };
  }
  return { sizeBytes: null, sizeNote: sizeField };
}

const BORDER_CHARS = new Set(['·', '=', ' ', '\t']);

/** A `·====·` border line (or the `===` variant in the 2026 file). */
function isBorder(line: string): boolean {
  const t = line.trim();
  if (t.length < 10) return false;
  return [...t].every((ch) => BORDER_CHARS.has(ch));
}

/**
 * Feed lines in order; `onEntry` fires once per completed entry. A new entry
 * starts at `[ File #N ]`; the entry line is the first non-blank, non-border
 * line after it. Everything until the next marker/ornament/`[ End` belongs to
 * the block as description (minus dl/uploader metadata lines).
 *
 * `Scanning dir N` sets the dir; content before the first marker is dir 1.
 * Markers past 66 (All/Upload/Hold passes) still parse — dirNo is stored raw.
 */
export async function parseLines(
  lines: Iterable<string> | AsyncIterable<string>,
  onEntry: (e: FileListEntry) => void
): Promise<{ entries: number; anomalies: string[] }> {
  let dirNo = 1;
  let fileNo = 0;
  let inBlock = false;
  let entryLine: ParsedEntryLine | null = null;
  let descLines: string[] = [];
  let entries = 0;
  const anomalies: string[] = [];

  const flush = (): void => {
    if (!inBlock || !entryLine) {
      inBlock = false;
      entryLine = null;
      descLines = [];
      return;
    }
    const { sizeBytes, sizeNote } = splitSize(entryLine.sizeField);
    let dlCount: number | null = null;
    let uploader: string | null = null;
    const kept: string[] = [];
    // A credit header can ride on the entry line itself (`TOOL.LHA …
    // Uploader: Amon HF`); it is metadata, not description.
    if (entryLine.firstDesc.trim()) {
      const firstCredit = matchExplicitUploader(entryLine.firstDesc);
      if (firstCredit) uploader = firstCredit;
      else kept.push(entryLine.firstDesc);
    }
    for (const rawDl of descLines) {
      // Strip an inline DL's stamp first; the restored spaces keep the art
      // columns identical to the unstamped twin (same file, another dir).
      let dl = rawDl;
      const sm = dl.match(DL_STAMP_RE);
      if (sm) {
        dlCount = dlCount ?? Number(sm[2]);
        dl = sm[1] + '        ' + dl.slice(sm[0].length);
        // A stamp with no art after it is metadata, not a picture line.
        if (!dl.trim()) continue;
      }
      const dm = dl.match(DL_RE);
      if (dm) {
        // The explicit d/L line wins over a stamp when both exist.
        dlCount = Number(dm[1]);
        continue;
      }
      // Explicit credits first (more specific), then the chevron trailer.
      // First match wins across both: courier/greet art never matches the
      // anchored forms, so this cannot steal a real credit line.
      if (uploader === null) {
        const explicit = matchExplicitUploader(dl);
        if (explicit) {
          uploader = explicit;
          continue;
        }
      }
      const um = dl.match(UPLOADER_RE);
      // Route through the same cleanup as explicit credits: wrapping and
      // placeholder values (`unknown`, `-`) fall through to the description
      // instead of minting junk uploaders.
      if (um && uploader === null && !/[|¦]/.test(dl)) {
        const chevron = normalizeUploader(um[1]);
        if (chevron) {
          uploader = chevron;
          continue;
        }
      }
      kept.push(dl);
    }
    // Drop the next entry's ornament/date lines off the end of the block.
    while (kept.length && (ORNAMENT_RE.test(kept[kept.length - 1]) || !kept[kept.length - 1].trim())) {
      kept.pop();
    }
    // The entry line's own row was trimmed to column 0 while its siblings
    // kept their source indent. Lift it to the first content sibling (any
    // sibling at 4+, art or prose — ragged prose titles like
    // `Hillsea Lido …[1/2]` over an 8-space `(c) …` line read as broken
    // otherwise); single-space offsets pass through untouched.
    if (kept.length >= 2 && !kept[0].startsWith(' ')) {
      const next = kept.slice(1).find((l) => l.trim());
      if (next) {
        const indent = next.length - next.trimStart().length;
        if (indent >= 4) {
          kept[0] = ' '.repeat(indent) + kept[0];
        }
      }
    }
    // Strip BBS column padding: when the shallowest content line still sits
    // at 30+, the whole block rode in on the listing's indent column, which
    // shoves pictures right for no reason. Cut the minimum off every line;
    // deeper outliers (titles, signatures) keep their relative offset and
    // shallower overhangs floor to 0 rather than slicing into content.
    // Ragged shallow blocks keep their source shape, first-line pad included.
    {
      let min = Infinity;
      for (const l of kept) {
        if (!l.trim()) continue;
        min = Math.min(min, l.length - l.trimStart().length);
      }
      if (min !== Infinity && min >= 30) {
        for (let i = 0; i < kept.length; i++) {
          if (!kept[i].trim()) {
            kept[i] = '';
            continue;
          }
          const ind = kept[i].length - kept[i].trimStart().length;
          kept[i] = ind >= min ? kept[i].slice(min) : kept[i].trimStart();
        }
      }
    }
    onEntry({
      dirNo,
      fileNo,
      filename: entryLine.filename,
      flag: entryLine.flag,
      sizeBytes,
      sizeNote,
      dateIso: toIsoDate(entryLine.mm, entryLine.dd, entryLine.yy),
      dlCount,
      uploader,
      descLines: kept,
    });
    entries++;
    inBlock = false;
    entryLine = null;
    descLines = [];
  };

  const endBlock = (line: string): void => {
    if (inBlock && !entryLine) {
      anomalies.push(`dir ${dirNo} file #${fileNo}: no entry line in block: ${line.slice(0, 80)}`);
    }
    flush();
  };

  for await (const raw of lines) {
    const line = repairDoubleEncoded((raw as string).replace(/[\r\n]+$/, ''));
    const scan = line.match(/^Scanning dir (\d+)/);
    if (scan) {
      flush();
      dirNo = Number(scan[1]);
      continue;
    }
    const fno = line.match(/^\[ File #(\d+)/);
    if (fno) {
      flush();
      inBlock = true;
      fileNo = Number(fno[1]);
      entryLine = null;
      descLines = [];
      continue;
    }
    if (!inBlock) continue;
    if (line.includes('[ End of File List ]')) {
      endBlock(line);
      continue;
    }
    if (!entryLine) {
      if (!line.trim() || isBorder(line)) continue;
      const parsed = parseEntryLine(line);
      if (parsed) {
        entryLine = parsed;
      } else {
        anomalies.push(`dir ${dirNo} file #${fileNo}: no entry line after marker: ${line.slice(0, 80)}`);
        inBlock = false;
      }
      continue;
    }
    // Inside the description block: a new ornament date or marker ends it
    // (the next [ File #] / Scanning dir / [ End flushes via the branches).
    descLines.push(line);
  }
  flush();
  return { entries, anomalies };
}

/** Parse a whole file from disk (streaming). */
export async function parseFilelist(
  filePath: string,
  onEntry: (e: FileListEntry) => void
): Promise<{ entries: number; anomalies: string[] }> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    return await parseLines(rl as unknown as AsyncIterable<string>, onEntry);
  } finally {
    rl.close();
  }
}
