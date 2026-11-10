/**
 * Hub storage for the shared /draw canvas: an 80x24 grid kept as a 3-byte-per-cell blob.
 *
 * The byte grammar that carries edits and snapshot rows (docs/CHAT-API.md, "Canvas wire encoding")
 * is NOT defined here. It lives once, in the amiexpress-web SDK, and arrives as the generated
 * mirror ./canvas-wire-codec.generated.ts (scripts/gen-canvas-codec.ts; staleness test
 * tests/chat-canvas-wire-mirror.test.ts). This file only maps that codec's Cell objects to and
 * from the stored blob.
 */
import { CANVAS_COLS, CANVAS_ROWS, CanvasGrammarError, encodeRow as encodeCells, parseOps, type Cell, type ParsedOps } from './canvas-wire-codec.generated';

export { CANVAS_COLS, CANVAS_ROWS, CanvasGrammarError, parseOps };
export type { Cell, ParsedOps };

export const CANVAS_BYTES_PER_CELL = 3;
export const CANVAS_BYTES = CANVAS_COLS * CANVAS_ROWS * CANVAS_BYTES_PER_CELL;

export const BLANK_CELL: Cell = { char: ' ', fg: 7, bg: 0, blink: false };

/** The stored blob: 3 bytes per cell, char / fg<<4|bg / flags (bit 0 = blink). */
export function blankCanvas(): Buffer {
  const b = Buffer.alloc(CANVAS_BYTES);
  for (let i = 0; i < CANVAS_COLS * CANVAS_ROWS; i++) {
    b[i * 3] = BLANK_CELL.char.charCodeAt(0);
    b[i * 3 + 1] = (BLANK_CELL.fg << 4) | BLANK_CELL.bg;
  }
  return b;
}

export function readCell(blob: Buffer, x: number, y: number): Cell {
  const o = (y * CANVAS_COLS + x) * CANVAS_BYTES_PER_CELL;
  return { char: String.fromCharCode(blob[o]), fg: blob[o + 1] >> 4, bg: blob[o + 1] & 15, blink: (blob[o + 2] & 1) === 1 };
}

export function writeCell(blob: Buffer, x: number, y: number, c: Cell): void {
  const o = (y * CANVAS_COLS + x) * CANVAS_BYTES_PER_CELL;
  blob[o] = c.char.charCodeAt(0);
  blob[o + 1] = (c.fg << 4) | c.bg;
  blob[o + 2] = c.blink ? 1 : 0;
}

export function encodeRow(blob: Buffer, y: number): string {
  const cells: Cell[] = [];
  for (let x = 0; x < CANVAS_COLS; x++) cells.push(readCell(blob, x, y));
  return encodeCells(cells);
}

/** Apply parsed ops to the blob in place: clear first, then writes in order (last writer wins). */
export function applyParsed(blob: Buffer, p: ParsedOps): void {
  if (p.clear) blankCanvas().copy(blob);
  for (const w of p.writes) writeCell(blob, w.x, w.y, w.cell);
}
