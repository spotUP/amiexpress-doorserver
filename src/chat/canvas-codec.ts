/**
 * The shared /draw canvas: an 80x24 grid of text cells and the byte grammar
 * that carries edits and snapshot rows over slow 68K links (docs/CHAT-API.md,
 * "Canvas wire encoding"). Latin-1 only; the output never contains `|`, `!`,
 * CR or LF, so it survives the .txt escaper unchanged.
 *
 * Grammar (ops string):
 *   X           clear the whole canvas; only as the first byte
 *   @x,y:       start a run at column x, row y (decimal); cells follow left to right
 *   ^fb         set the pen: f, b one hex digit each (0-15); persists to the end of the string
 *   ^fbB        the same pen with blink (a capital B straight after the pair)
 *   <byte>      one cell with that char in the pen; any byte 0x20-0xFF except | ! ^ ~ * @
 *   ~hh         one cell with the byte hh (the reserved bytes and controls)
 *   *n;         the previous cell again, n more times (n >= 1)
 * The pen starts as 7 on 0 without blink.
 */

export const CANVAS_COLS = 80;
export const CANVAS_ROWS = 24;
export const CANVAS_BYTES_PER_CELL = 3;
export const CANVAS_BYTES = CANVAS_COLS * CANVAS_ROWS * CANVAS_BYTES_PER_CELL;

export interface CanvasCell {
  ch: number;
  fg: number;
  bg: number;
  blink: boolean;
}

export const BLANK_CELL: CanvasCell = { ch: 0x20, fg: 7, bg: 0, blink: false };

export class CanvasGrammarError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(message);
  }
}

export interface ParsedOps {
  clear: boolean;
  writes: { x: number; y: number; cell: CanvasCell }[];
}

const RESERVED = new Set([0x7c, 0x21, 0x5e, 0x7e, 0x2a, 0x40]); // | ! ^ ~ * @

function hexVal(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

export function parseOps(ops: string, maxCells: number): ParsedOps {
  const out: ParsedOps = { clear: false, writes: [] };
  let i = 0;
  if (ops[0] === 'X') {
    out.clear = true;
    i = 1;
  }
  let pen = { fg: 7, bg: 0, blink: false };
  let run: { x: number; y: number } | null = null;
  let prev: CanvasCell | null = null;
  let cells = 0;

  const put = (cell: CanvasCell, at: number): void => {
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
      put({ ch: h * 16 + l, ...pen }, at);
      i += 3;
    } else if (code === 0x2a) {
      const m = /^\*(\d{1,4});/.exec(ops.slice(i, i + 7));
      if (!m || Number(m[1]) < 1) throw new CanvasGrammarError('bad *n; repeat', at);
      if (!prev) throw new CanvasGrammarError('repeat with no previous cell', at);
      const again = prev;
      for (let k = Number(m[1]); k > 0; k--) put(again, at);
      i += m[0].length;
    } else if (code < 0x20 || RESERVED.has(code)) {
      throw new CanvasGrammarError(`byte 0x${code.toString(16)} must be written ~hh`, at);
    } else {
      put({ ch: code, ...pen }, at);
      i += 1;
    }
  }
  return out;
}

function sameCell(a: CanvasCell, b: CanvasCell): boolean {
  return a.ch === b.ch && a.fg === b.fg && a.bg === b.bg && a.blink === b.blink;
}

function cellToken(ch: number, afterPenWithoutBlink: boolean): string {
  const raw = ch >= 0x20 && !RESERVED.has(ch) && !(afterPenWithoutBlink && ch === 0x42);
  return raw ? String.fromCharCode(ch) : `~${ch.toString(16).padStart(2, '0')}`;
}

/** One row as ops without the `@0,y:` prefix (implied). Runs of identical cells become `*n;`. */
export function encodeCells(cells: CanvasCell[]): string {
  let out = '';
  let pen = { fg: 7, bg: 0, blink: false };
  let afterPen = false;
  let i = 0;
  while (i < cells.length) {
    const c = cells[i];
    let n = 1;
    while (i + n < cells.length && sameCell(cells[i + n], c)) n += 1;
    if (c.fg !== pen.fg || c.bg !== pen.bg || c.blink !== pen.blink) {
      out += `^${c.fg.toString(16).toUpperCase()}${c.bg.toString(16).toUpperCase()}${c.blink ? 'B' : ''}`;
      pen = { fg: c.fg, bg: c.bg, blink: c.blink };
      afterPen = !c.blink;
    }
    out += cellToken(c.ch, afterPen);
    afterPen = false;
    if (n > 1) out += `*${n - 1};`;
    i += n;
  }
  return out;
}

/** The stored blob: 3 bytes per cell, char / fg<<4|bg / flags (bit 0 = blink). */
export function blankCanvas(): Buffer {
  const b = Buffer.alloc(CANVAS_BYTES);
  for (let i = 0; i < CANVAS_COLS * CANVAS_ROWS; i++) {
    b[i * 3] = BLANK_CELL.ch;
    b[i * 3 + 1] = (BLANK_CELL.fg << 4) | BLANK_CELL.bg;
  }
  return b;
}

export function readCell(blob: Buffer, x: number, y: number): CanvasCell {
  const o = (y * CANVAS_COLS + x) * CANVAS_BYTES_PER_CELL;
  return { ch: blob[o], fg: blob[o + 1] >> 4, bg: blob[o + 1] & 15, blink: (blob[o + 2] & 1) === 1 };
}

export function writeCell(blob: Buffer, x: number, y: number, c: CanvasCell): void {
  const o = (y * CANVAS_COLS + x) * CANVAS_BYTES_PER_CELL;
  blob[o] = c.ch;
  blob[o + 1] = (c.fg << 4) | c.bg;
  blob[o + 2] = c.blink ? 1 : 0;
}

export function encodeRow(blob: Buffer, y: number): string {
  const cells: CanvasCell[] = [];
  for (let x = 0; x < CANVAS_COLS; x++) cells.push(readCell(blob, x, y));
  return encodeCells(cells);
}

/** Apply parsed ops to the blob in place: clear first, then writes in order (last writer wins). */
export function applyParsed(blob: Buffer, p: ParsedOps): void {
  if (p.clear) blankCanvas().copy(blob);
  for (const w of p.writes) writeCell(blob, w.x, w.y, w.cell);
}
