/** Canvas wire grammar (parseOps / encodeCells): round trips, error offsets, caps. */
import { applyParsed, blankCanvas, CanvasGrammarError, encodeRow, parseOps, readCell, writeCell, CANVAS_COLS } from '../src/chat/canvas-codec';
import { CHAT_LIMITS } from '../contract/chat-types';

const MAX = CHAT_LIMITS.canvasCellsMax;

function offsetOf(ops: string): number {
  try { parseOps(ops, MAX); } catch (e) { if (e instanceof CanvasGrammarError) return e.offset; throw e; }
  throw new Error('expected a grammar error');
}

describe('canvas codec', () => {
  it('round trips every byte 0x00-0xFF with every pen shape through encodeRow', () => {
    for (const pen of [{ fg: 7, bg: 0, blink: false }, { fg: 4, bg: 1, blink: false }, { fg: 15, bg: 9, blink: true }]) {
      const blob = blankCanvas();
      for (let ch = 0; ch < 256; ch++) writeCell(blob, ch % CANVAS_COLS, 5 + Math.floor(ch / CANVAS_COLS), { char: String.fromCharCode(ch), ...pen });
      for (const y of [5, 6, 7, 8]) {
        const enc = encodeRow(blob, y);
        expect(enc).not.toMatch(/[|!\r\n]/);
        const back = blankCanvas();
        applyParsed(back, parseOps(`@0,${y}:${enc}`, MAX));
        for (let x = 0; x < CANVAS_COLS; x++) expect(readCell(back, x, y)).toEqual(readCell(blob, x, y));
      }
    }
  });

  it('escapes a literal B right after a non-blink pen', () => {
    const blob = blankCanvas();
    writeCell(blob, 0, 0, { char: String.fromCharCode(0x42), fg: 4, bg: 0, blink: false });
    const enc = encodeRow(blob, 0);
    expect(enc.startsWith('^40~42')).toBe(true);
    const p = parseOps(`@0,0:${enc}`, MAX);
    expect(p.writes[0].cell).toEqual({ char: String.fromCharCode(0x42), fg: 4, bg: 0, blink: false });
  });

  it('reads the blink flag and both hex cases', () => {
    const p = parseOps('@1,2:^aFBx^0f y', MAX);
    expect(p.writes[0]).toEqual({ x: 1, y: 2, cell: { char: String.fromCharCode(0x78), fg: 10, bg: 15, blink: true } });
    expect(p.writes[1].cell).toEqual({ char: String.fromCharCode(0x20), fg: 0, bg: 15, blink: false });
  });

  it('X clears only as the first byte; later it is a letter', () => {
    expect(parseOps('X', MAX).clear).toBe(true);
    const p = parseOps('@0,0:aX', MAX);
    expect(p.clear).toBe(false);
    expect(p.writes[1].cell.char).toBe('X');
  });

  it('reports the byte offset of each grammar error', () => {
    expect(offsetOf('a')).toBe(0); // cell before any run
    expect(offsetOf('@80,0:a')).toBe(0);
    expect(offsetOf('@0,24:a')).toBe(0);
    expect(offsetOf('@0,0:ab|')).toBe(7);
    expect(offsetOf('@0,0:a\x01')).toBe(6);
    expect(offsetOf('@0,0:^4')).toBe(5);
    expect(offsetOf('@0,0:~zz')).toBe(5);
    expect(offsetOf('@0,0:*3;')).toBe(5); // repeat with no previous cell
    expect(offsetOf('@0,0:a*0;')).toBe(6);
    expect(offsetOf('@78,0:ab*5;')).toBe(8); // runs off the right edge
    expect(offsetOf('@0,0:Ā')).toBe(5);
  });

  it('caps a post at canvasCellsMax cells', () => {
    const rows = (n: number): string => Array.from({ length: n }, (_, y) => `@0,${y}:a*79;`).join('');
    expect(parseOps(rows(24), MAX).writes).toHaveLength(MAX);
    expect(() => parseOps(`${rows(24)}@0,0:a`, MAX)).toThrow(CanvasGrammarError);
    expect(() => parseOps('@0,0:a*5;', 5)).toThrow(CanvasGrammarError);
    expect(parseOps('@0,0:a*4;', 5).writes).toHaveLength(5);
  });
});
