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
const UPLOADER_RE = /^\s*(\S[^<>]*?)\s*>>(.+)<<\s*$/;

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
  const noNl = line.replace(/[\r\n]+$/, '');
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
    if (entryLine.firstDesc.trim()) kept.push(entryLine.firstDesc);
    for (const dl of descLines) {
      const dm = dl.match(DL_RE);
      if (dm && dlCount === null) {
        dlCount = Number(dm[1]);
        continue;
      }
      const um = dl.match(UPLOADER_RE);
      if (um && uploader === null && !/[|¦]/.test(dl)) {
        uploader = um[1].trim();
        continue;
      }
      kept.push(dl);
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
    const line = (raw as string).replace(/[\r\n]+$/, '');
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
