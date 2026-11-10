/**
 * GENERATED FILE -- DO NOT EDIT BY HAND.
 *
 * Mirror of amiexpress-web sdk/engines/ui/ansi-editor/core/wire-codec.ts.
 * Regenerate with: npx tsx scripts/gen-canvas-codec.ts
 */

/**
 * Wire codec for the shared /draw canvas (plan 2026-11-10-ansi-editor-c-port, T3, decision D9).
 *
 * The one TypeScript codec for the canvas wire encoding of the chat hub (docs/CHAT-API.md,
 * "Canvas wire encoding"; hub reference: amiexpress-doorserver src/chat/canvas-codec.ts). Its twin
 * in C is sdk/c/src/ui_canvas.c; sdk/tests/unit/canvas-wire-codec.test.ts runs the same cases as
 * sdk/c/tests/test_ui_canvas.c so the three agree. Nothing else in this repo may carry a copy.
 *
 * The grammar of an ops string (Latin-1 only; the output never holds | ! CR LF):
 *   X          clear the whole canvas; only as the first byte
 *   @x,y:      start a run at column x, row y (decimal); cells follow left to right
 *   ^fb[B]     pen: foreground and background, one hex digit each; a capital B straight after = blink
 *   <char>     one cell in the pen; any char 0x20-0xFF except | ! ^ ~ * @
 *   ~hh        one cell with the byte hh (reserved chars and controls)
 *   *n;        the previous cell again, n more times (n >= 1)
 * The pen starts as 7 on 0 without blink and lasts to the end of the string.
 */

/** The cell the codec reads and writes (the subset of the SDK Cell it uses). */
export interface Cell {
  char: string;
  fg: number;
  bg: number;
  blink?: boolean;
}

export const CANVAS_COLS = 80;
export const CANVAS_ROWS = 24;
export const CANVAS_CELLS = CANVAS_COLS * CANVAS_ROWS;
/** The hub refuses a post whose ops are longer than this (413). */
export const CANVAS_OPS_MAX = 512;
/** The hub refuses a post that writes more cells than this (422). */
export const CANVAS_CELLS_MAX = CANVAS_CELLS;

export class CanvasGrammarError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(message);
  }
}

export interface CanvasWrite {
  x: number;
  y: number;
  cell: Cell;
}

export interface ParsedOps {
  clear: boolean;
  writes: CanvasWrite[];
}

export type CanvasApplyResult =
  | { status: 'ok'; clear: boolean; writes: CanvasWrite[] }
  | { status: 'long'; offset: number }
  | { status: 'bad'; offset: number; message: string };

const RESERVED = new Set([0x7c, 0x21, 0x5e, 0x7e, 0x2a, 0x40]); // | ! ^ ~ * @

function hexVal(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

function mkCell(ch: number, fg: number, bg: number, blink: boolean): Cell {
  return { char: String.fromCharCode(ch), fg, bg, blink };
}

/**
 * Parse an ops string. With `rowY` the string is one snapshot row: it starts inside the run
 * `@0,rowY:` and takes no leading X. Throws CanvasGrammarError with the byte offset; nothing is
 * returned half done.
 */
export function parseOps(ops: string, maxCells: number = CANVAS_CELLS_MAX, rowY?: number): ParsedOps {
  const out: ParsedOps = { clear: false, writes: [] };
  let i = 0;
  if (rowY === undefined && ops[0] === 'X') {
    out.clear = true;
    i = 1;
  }
  let pen = { fg: 7, bg: 0, blink: false };
  let run: { x: number; y: number } | null = rowY === undefined ? null : { x: 0, y: rowY };
  let prev: Cell | null = null;
  let cells = 0;

  const put = (cell: Cell, at: number): void => {
    if (!run) throw new CanvasGrammarError('a cell before any @x,y: run', at);
    if (run.x >= CANVAS_COLS) throw new CanvasGrammarError('run passes the right edge', at);
    cells += 1;
    if (cells > maxCells) throw new CanvasGrammarError(`more than ${maxCells} cells`, at);
    out.writes.push({ x: run.x, y: run.y, cell });
    run.x += 1;
    prev = cell;
  };

  while (i < ops.length) {
    const at = i;
    const code = ops.charCodeAt(i);
    if (code > 0xff) throw new CanvasGrammarError('character above U+00FF', at);
    if (code === 0x40) {
      const m = /^@(\d{1,3}),(\d{1,3}):/.exec(ops.slice(i, i + 12));
      if (!m) throw new CanvasGrammarError('bad @x,y: run start', at);
      const x = Number(m[1]);
      const y = Number(m[2]);
      if (x >= CANVAS_COLS || y >= CANVAS_ROWS) throw new CanvasGrammarError('run start outside the canvas', at);
      run = { x, y };
      prev = null;
      i += m[0].length;
    } else if (code === 0x5e) {
      const f = hexVal(ops.charCodeAt(i + 1));
      const b = hexVal(ops.charCodeAt(i + 2));
      if (f < 0 || b < 0) throw new CanvasGrammarError('bad ^fb pen', at);
      const blink = ops[i + 3] === 'B';
      pen = { fg: f, bg: b, blink };
      i += blink ? 4 : 3;
    } else if (code === 0x7e) {
      const h = hexVal(ops.charCodeAt(i + 1));
      const l = hexVal(ops.charCodeAt(i + 2));
      if (h < 0 || l < 0) throw new CanvasGrammarError('bad ~hh escape', at);
      put(mkCell(h * 16 + l, pen.fg, pen.bg, pen.blink), at);
      i += 3;
    } else if (code === 0x2a) {
      const m = /^\*(\d{1,4});/.exec(ops.slice(i, i + 7));
      if (!m || Number(m[1]) < 1) throw new CanvasGrammarError('bad *n; repeat', at);
      if (!prev) throw new CanvasGrammarError('repeat with no previous cell', at);
      const again: Cell = prev;
      for (let k = Number(m[1]); k > 0; k--) put({ ...again }, at);
      i += m[0].length;
    } else if (code < 0x20 || RESERVED.has(code)) {
      throw new CanvasGrammarError(`byte 0x${code.toString(16)} must be written ~hh`, at);
    } else {
      put(mkCell(code, pen.fg, pen.bg, pen.blink), at);
      i += 1;
    }
  }
  return out;
}

/**
 * Check and parse `ops` the way the hub does before it applies a post: over 512 bytes is
 * 'long' (413), bad grammar or too many cells is 'bad' (422, with the byte offset). Pure: it
 * returns what to write and leaves the canvas to the caller, so a host that tracks undo can route
 * each write through its own setter.
 */
export function applyOps(ops: string, maxCells: number = CANVAS_CELLS_MAX): CanvasApplyResult {
  if (ops.length > CANVAS_OPS_MAX) return { status: 'long', offset: CANVAS_OPS_MAX };
  try {
    const p = parseOps(ops, maxCells);
    return { status: 'ok', clear: p.clear, writes: p.writes };
  } catch (e) {
    if (e instanceof CanvasGrammarError) return { status: 'bad', offset: e.offset, message: e.message };
    throw e;
  }
}

// ---- encoding ----

interface Pen {
  fg: number;
  bg: number;
  blink: boolean;
}

/** Two cells show the same thing (blink undefined equals false). */
export function sameCell(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.fg === b.fg && a.bg === b.bg && Boolean(a.blink) === Boolean(b.blink);
}

function charCode(c: Cell): number {
  const n = c.char.charCodeAt(0);
  return Number.isNaN(n) || n > 0xff ? 0x3f : n; // a char Latin-1 cannot carry goes out as '?'
}

function token(ch: number, afterPlainPen: boolean): string {
  const raw = ch >= 0x20 && !RESERVED.has(ch) && !(afterPlainPen && ch === 0x42);
  return raw ? String.fromCharCode(ch) : `~${ch.toString(16).padStart(2, '0')}`;
}

/** The pen change for c ('' when none), and whether a plain (non-blink) pen was just written. */
function penChange(pen: Pen, c: Cell): { text: string; plain: boolean } {
  const blink = Boolean(c.blink);
  if (pen.fg === c.fg && pen.bg === c.bg && pen.blink === blink) return { text: '', plain: false };
  pen.fg = c.fg;
  pen.bg = c.bg;
  pen.blink = blink;
  return {
    text: `^${(c.fg & 15).toString(16).toUpperCase()}${(c.bg & 15).toString(16).toUpperCase()}${blink ? 'B' : ''}`,
    plain: !blink,
  };
}

/** One row as ops without the `@0,y:` prefix (implied by a snapshot row). Identical cells become `*n;`. */
export function encodeRow(cells: readonly Cell[]): string {
  const pen: Pen = { fg: 7, bg: 0, blink: false };
  let out = '';
  let i = 0;
  while (i < cells.length) {
    const c = cells[i];
    let n = 1;
    while (i + n < cells.length && sameCell(cells[i + n], c)) n += 1;
    const pc = penChange(pen, c);
    out += pc.text + token(charCode(c), pc.plain);
    if (n > 1) out += `*${n - 1};`;
    i += n;
  }
  return out;
}

/**
 * One chunk of ops for the dirty cells (indices y * 80 + x) from `pos` on, at most `cap` bytes
 * (never above 512). Returns the ops and the index to continue from. A cap too small for even one
 * cell throws RangeError.
 */
export function encodeOpsChunk(
  canvas: readonly (readonly Cell[])[],
  dirty: ReadonlySet<number>,
  pos: number,
  cap: number = CANVAS_OPS_MAX,
): { ops: string; pos: number } {
  const limit = Math.min(cap, CANVAS_OPS_MAX);
  const pen: Pen = { fg: 7, bg: 0, blink: false };
  let out = '';
  let p = pos;
  let runX = -1;
  let runY = -1;
  const at = (i: number): Cell => canvas[Math.floor(i / CANVAS_COLS)][i % CANVAS_COLS];
  while (p < CANVAS_CELLS) {
    if (!dirty.has(p)) {
      p += 1;
      continue;
    }
    const x = p % CANVAS_COLS;
    const y = Math.floor(p / CANVAS_COLS);
    const c = at(p);
    let run = 1;
    while (x + run < CANVAS_COLS && dirty.has(p + run) && sameCell(at(p + run), c)) run += 1;
    const saved = { ...pen };
    let piece = runY === y && runX === x ? '' : `@${x},${y}:`;
    const pc = penChange(pen, c);
    piece += pc.text + token(charCode(c), pc.plain);
    if (run > 1) piece += `*${run - 1};`;
    if (out.length + piece.length > limit) {
      Object.assign(pen, saved);
      break;
    }
    out += piece;
    runY = y;
    runX = x + run;
    p += run;
  }
  if (out.length === 0 && p < CANVAS_CELLS) throw new RangeError('a dirty cell does not fit in the ops cap');
  return { ops: out, pos: p };
}

/** All dirty cells as ops strings of at most 512 bytes each (a post carries one). */
export function encodeOps(canvas: readonly (readonly Cell[])[], dirty: ReadonlySet<number>, cap: number = CANVAS_OPS_MAX): string[] {
  const chunks: string[] = [];
  let pos = 0;
  while (pos < CANVAS_CELLS) {
    const r = encodeOpsChunk(canvas, dirty, pos, cap);
    if (r.ops) chunks.push(r.ops);
    pos = r.pos;
  }
  return chunks;
}

// ---- canvas.txt reply ----

export interface CanvasRow {
  y: number;
  /** The row in the wire encoding, without the `@0,y:` prefix. */
  cells: string;
}

export interface CanvasReply {
  rev: number;
  rows: CanvasRow[];
}

/**
 * Parse a canvas.txt reply body: `CANVAS|1|rev|count` then `y|cells` lines (LF or CRLF). Returns
 * null when the reply is malformed (version, count, short body, bad row); no row is applied then.
 */
export function parseCanvasReply(body: string): CanvasReply | null {
  const lines = body.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const head = /^CANVAS\|1\|(\d+)\|(\d+)$/.exec(lines[0] ?? '');
  if (!head) return null;
  const want = Number(head[2]);
  if (want > CANVAS_ROWS) return null;
  const rows: CanvasRow[] = [];
  for (let k = 1; k <= want; k++) {
    const line = lines[k];
    if (line === undefined) return null;
    const m = /^(\d{1,2})\|(.*)$/s.exec(line);
    if (!m || Number(m[1]) >= CANVAS_ROWS) return null;
    try {
      parseOps(m[2], CANVAS_COLS, Number(m[1]));
    } catch (e) {
      if (e instanceof CanvasGrammarError) return null;
      throw e;
    }
    rows.push({ y: Number(m[1]), cells: m[2] });
  }
  return { rev: Number(head[1]), rows };
}

/** The writes of one snapshot row (`rowY`, cells without the run prefix). Throws CanvasGrammarError. */
export function parseRow(rowY: number, cells: string): CanvasWrite[] {
  return parseOps(cells, CANVAS_COLS, rowY).writes;
}
