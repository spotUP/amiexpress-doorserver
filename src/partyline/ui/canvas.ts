/**
 * The shared /draw canvas of an art room: a 1:1 port of livechat.c dr_* / draw_key / draw_mouse,
 * livechat_ui.c lc_draw_canvas and sdk/c/src/ui_paint.c (strokes, undo/redo, the shape tools).
 * The cells live in the hub's chat_canvas row (store.ts getCanvas / applyCanvasOps); this class
 * holds only the caller's copy, its dirty cells and the rev it is based on.
 *
 * Beyond the C, from the TS LIVECHAT drawing-canvas.ts (the web door the test sheet drives):
 * V also steps the background and [ ] step the pen character.
 * Not ported: the H pen picker (lc_pick); H prints a note naming [ and ] instead.
 */
import { CANVAS_COLS, CANVAS_ROWS, encodeOps, parseOps, parseRow, sameCell } from '../../chat/canvas-wire-codec.generated';
import type { Cell } from '../../chat/canvas-wire-codec.generated';
import { DEFAULT } from './cells';
import type { Cells } from './cells';
import type { DrawState } from './draw';
import { TK_ACCENT, TK_INK } from './model';

export const HIT_CANVAS = 17, HIT_CANVAS_TOOLS = 18;
const K_UP = 1000, K_DOWN = 1001, K_PGUP = 1002, K_PGDN = 1003, K_HOME = 1004, K_END = 1005, K_ENTER = 1006, K_ESC = 1007, K_LEFT = 1008, K_RIGHT = 1009;

export const DT_DRAW = 0, DT_LINE = 1, DT_BOX = 2, DT_BOXF = 3, DT_ELL = 4, DT_ELLF = 5, DT_FILL = 6, DT_PICK = 7, DT_TEXT = 8, DT_CLEAR = 9;
export const TOOLS = ['Draw', 'Line', 'Box', 'Filled Box', 'Ellipse', 'Filled Ellipse', 'Fill', 'Pick Colour', 'Text', 'Clear Canvas'];

const blank = (): Cell => ({ char: ' ', fg: 7, bg: 0, blink: false });
const idx = (x: number, y: number): number => y * CANVAS_COLS + x;

/** What the canvas asks of the hub: the snapshot and a post, or the error text. */
export interface CanvasHost {
  fetch(): { rev: number; rows: [number, string][] } | string;
  post(base: number, ops: string): { rev: number } | string;
}

interface Stroke { cells: Map<number, { prev: Cell; now: Cell }> }

export class DrawCanvas {
  on = false;
  grid: Cell[][] = [];
  rev = 0;
  x = 0; y = 0; left = 0; top = 0;
  fg = 15; bg = 0; ch = '#';
  down = false;
  tool = DT_DRAW;
  anchor = false; ax = 0; ay = 0;
  note = '';
  /** The 't' tool popup: -1 closed, else the selected row. */
  pop = -1;
  private dirty = new Set<number>();
  private open: Stroke | null = null;
  private undos: Stroke[] = [];
  private redos: Stroke[] = [];
  private vw = 80; private vh = 24;

  constructor(private readonly host: CanvasHost) { this.wipe(); }

  private wipe(): void { this.grid = Array.from({ length: CANVAS_ROWS }, () => Array.from({ length: CANVAS_COLS }, blank)); }

  /** dr_enter */
  enter(): void {
    this.wipe();
    this.undos = []; this.redos = []; this.open = null;
    this.dirty.clear();
    this.rev = 0;
    this.fetch();
    this.on = true;
    this.x = this.y = this.left = this.top = 0;
    this.fg = 15; this.bg = 0; this.ch = '#';
    this.down = false;
    this.pop = -1;
    this.note = '';
    this.setTool(DT_DRAW);
  }

  /** dr_leave */
  leave(): void {
    this.paintEnd();
    this.flush();
    this.on = false;
    this.pop = -1;
    this.down = false;
  }

  private fetch(): void {
    const r = this.host.fetch();
    if (typeof r === 'string') { this.note = `Not loaded: ${r}`; return; }
    this.wipe();
    for (const [y, enc] of r.rows) for (const w of parseRow(y, enc)) this.grid[w.y][w.x] = { ...blank(), ...w.cell };
    this.rev = r.rev;
  }

  private setTool(t: number): void { this.tool = t; this.anchor = false; }

  /** dr_flush: the dirty cells as ops chunks based on rev; a rev jump means someone else posted, so refetch. */
  flush(): void {
    if (this.dirty.size === 0) return;
    const chunks = encodeOps(this.grid, this.dirty);
    this.dirty.clear();
    let resync = false;
    for (const ops of chunks) {
      const r = this.host.post(this.rev, ops);
      if (typeof r === 'string') { this.note = `Not sent: ${r}`; return; }
      if (r.rev !== this.rev + 1) resync = true;
      this.rev = r.rev;
    }
    if (resync) this.fetch();
  }

  /** The main loop's idle flush (a freehand stroke posts when the keys stop). True when something was sent. */
  idle(): boolean {
    if (!this.on || this.dirty.size === 0) return false;
    this.flush();
    return true;
  }

  /** dr_event: a canvas event of this room. */
  event(ref: string, ops: string): void {
    const n = Number(ref);
    if (!this.on || !(n > this.rev)) return;
    if (n !== this.rev + 1) { this.fetch(); return; }
    let parsed;
    try { parsed = parseOps(ops); } catch { this.fetch(); return; }
    if (parsed.clear) this.wipe();
    for (const w of parsed.writes) this.grid[w.y][w.x] = { ...blank(), ...w.cell };
    this.rev = n;
  }

  /** dr_clear: a hub op (room owner or op), so the canvas only clears when the hub took it. */
  private clear(): void {
    const r = this.host.post(this.rev, 'X');
    if (typeof r === 'string') { this.note = `Not sent: ${r}`; return; }
    this.wipe();
    this.undos = []; this.redos = []; this.open = null;
    this.dirty.clear();
    this.rev = r.rev;
  }

  // ---- ui_paint.c ----

  private pen(): Cell { return { char: this.ch, fg: this.fg, bg: this.bg, blink: false }; }

  private paintBegin(): void { if (this.open) return; this.open = { cells: new Map() }; this.redos = []; }
  private paintEnd(): void {
    if (!this.open) return;
    if (this.open.cells.size > 0) this.undos.push(this.open);
    this.open = null;
  }
  /** One tool call: inside the open stroke, or its own stroke when none is open. */
  private stroke(fn: () => void): void {
    const own = !this.open;
    if (own) this.paintBegin();
    fn();
    if (own) this.paintEnd();
  }
  private set(x: number, y: number, c: Cell): void {
    if (x < 0 || y < 0 || x >= CANVAS_COLS || y >= CANVAS_ROWS) return;
    const old = this.grid[y][x];
    if (sameCell(old, c)) return;
    const i = idx(x, y), s = this.open;
    if (s) { const e = s.cells.get(i); if (e) e.now = c; else s.cells.set(i, { prev: old, now: c }); }
    this.grid[y][x] = c;
    this.dirty.add(i);
  }
  private put(x: number, y: number, c: Cell): void { this.grid[y][x] = c; this.dirty.add(idx(x, y)); }

  /** ui_paint_undo_step: a cell comes back only where the canvas still shows what this stroke left. -1 while a stroke is open. */
  undo(): number { return this.step(this.undos, this.redos, true); }
  redo(): number { return this.step(this.redos, this.undos, false); }
  private step(from: Stroke[], to: Stroke[], back: boolean): number {
    if (this.open) return -1;
    const s = from.pop();
    if (!s) return 0;
    for (const [i, e] of s.cells) {
      const x = i % CANVAS_COLS, y = Math.floor(i / CANVAS_COLS);
      if (sameCell(this.grid[y][x], back ? e.now : e.prev)) this.put(x, y, back ? e.prev : e.now);
    }
    to.push(s);
    return 1;
  }

  dot(x: number, y: number, c: Cell): void { this.stroke(() => this.set(x, y, c)); }

  line(x0: number, y0: number, x1: number, y1: number, c: Cell): void {
    this.stroke(() => {
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        this.set(x0, y0, c);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    });
  }

  box(x0: number, y0: number, x1: number, y1: number, c: Cell, filled: boolean): void {
    const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
    this.stroke(() => {
      for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) if (filled || y === t || y === b || x === l || x === r) this.set(x, y, c);
    });
  }

  /** ui_paint_ellipse: the ellipse inside the box of two corners (midpoint, integer decisions). */
  ellipse(x0: number, y0: number, x1: number, y1: number, c: Cell, filled: boolean): void {
    const cx = Math.floor((x0 + x1) / 2), cy = Math.floor((y0 + y1) / 2);
    const rx = Math.min(Math.floor(Math.abs(x1 - x0) / 2), 140), ry = Math.min(Math.floor(Math.abs(y1 - y0) / 2), 140);
    if (rx === 0 || ry === 0) { if (filled) this.box(cx - rx, cy - ry, cx + rx, cy + ry, c, true); else this.line(cx - rx, cy - ry, cx + rx, cy + ry, c); return; }
    const rx2 = rx * rx, ry2 = ry * ry;
    this.stroke(() => {
      if (filled) {
        for (let y = -ry; y <= ry; y++) {
          let w = 0;
          while (w < rx && !((w + 1) * (w + 1) * ry2 > rx2 * (ry2 - y * y))) w++;
          for (let x = -w; x <= w; x++) this.set(cx + x, cy + y, c);
        }
        return;
      }
      const plot = (x: number, y: number): void => { this.set(cx + x, cy + y, c); this.set(cx - x, cy + y, c); this.set(cx + x, cy - y, c); this.set(cx - x, cy - y, c); };
      let x = 0, y = ry;
      let d1 = 4 * ry2 - 4 * rx2 * ry + rx2, dx = 0, dy = 8 * rx2 * y;
      while (dx < dy) {
        plot(x, y);
        x++; dx += 8 * ry2;
        if (d1 < 0) d1 += dx + 4 * ry2;
        else { y--; dy -= 8 * rx2; d1 += dx - dy + 4 * ry2; }
      }
      let d2 = ry2 * (2 * x + 1) * (2 * x + 1) + 4 * rx2 * (y - 1) * (y - 1) - 4 * rx2 * ry2;
      while (y >= 0) {
        plot(x, y);
        y--; dy -= 8 * rx2;
        if (d2 > 0) d2 += 4 * rx2 - dy;
        else { x++; dx += 8 * ry2; d2 += dx - dy + 4 * rx2; }
      }
    });
  }

  /** ui_paint_fill: span flood fill of the cells that match the start cell exactly. */
  fill(x: number, y: number, c: Cell): void {
    if (x < 0 || y < 0 || x >= CANVAS_COLS || y >= CANVAS_ROWS) return;
    const target = this.grid[y][x];
    if (sameCell(target, c)) return;
    this.stroke(() => {
      const todo: [number, number][] = [[x, y]];
      while (todo.length > 0) {
        const [px, py] = todo.pop() as [number, number];
        if (!sameCell(this.grid[py][px], target)) continue;
        let l = px, r = px;
        while (l > 0 && sameCell(this.grid[py][l - 1], target)) l--;
        while (r < CANVAS_COLS - 1 && sameCell(this.grid[py][r + 1], target)) r++;
        for (let i = l; i <= r; i++) {
          this.set(i, py, c);
          if (py > 0 && sameCell(this.grid[py - 1][i], target)) todo.push([i, py - 1]);
          if (py < CANVAS_ROWS - 1 && sameCell(this.grid[py + 1][i], target)) todo.push([i, py + 1]);
        }
      }
    });
  }

  // ---- livechat.c ----

  private move(x: number, y: number): void {
    this.x = Math.max(0, Math.min(CANVAS_COLS - 1, x));
    this.y = Math.max(0, Math.min(CANVAS_ROWS - 1, y));
    // dr_scroll: the view follows the cursor
    if (this.x < this.left) this.left = this.x; else if (this.x >= this.left + this.vw) this.left = this.x - this.vw + 1;
    if (this.y < this.top) this.top = this.y; else if (this.y >= this.top + this.vh) this.top = this.y - this.vh + 1;
  }

  /** dr_act: Space runs the tool at the cursor. */
  private act(): void {
    const pen = this.pen(), { x, y } = this;
    switch (this.tool) {
      case DT_DRAW: this.dot(x, y, pen); break;
      case DT_FILL: this.fill(x, y, pen); break;
      case DT_PICK: { const p = this.grid[y][x]; this.fg = p.fg; this.bg = p.bg; if (p.char !== ' ') this.ch = p.char; break; }
      case DT_LINE: case DT_BOX: case DT_BOXF: case DT_ELL: case DT_ELLF:
        if (!this.anchor) { this.ax = x; this.ay = y; this.anchor = true; this.note = 'Move to the other corner, Space'; break; }
        this.anchor = false;
        this.note = '';
        if (this.tool === DT_LINE) this.line(this.ax, this.ay, x, y, pen);
        else if (this.tool === DT_BOX || this.tool === DT_BOXF) this.box(this.ax, this.ay, x, y, pen, this.tool === DT_BOXF);
        else this.ellipse(this.ax, this.ay, x, y, pen, this.tool === DT_ELLF);
        break;
      default: break;
    }
  }

  private pickTool(i: number): void {
    this.pop = -1;
    if (i === DT_CLEAR) this.clear(); else if (i >= 0 && i < TOOLS.length) this.setTool(i);
  }

  /** draw_key. Returns 'quit' for Ctrl+Q (the screen opens its quit modal) and 'left' after Esc left the canvas. */
  key(k: number): 'quit' | 'left' | null {
    this.note = '';
    if (this.pop >= 0) {
      if (k === K_UP) this.pop = (this.pop + TOOLS.length - 1) % TOOLS.length;
      else if (k === K_DOWN) this.pop = (this.pop + 1) % TOOLS.length;
      else if (k === K_ENTER) this.pickTool(this.pop);
      else this.pop = -1;
      return null;
    }
    if (k === 17) { this.leave(); return 'quit'; }
    const { x, y } = this;
    if (this.tool === DT_TEXT && k >= 32 && k < 127) {
      this.stroke(() => this.set(x, y, { ...this.pen(), char: String.fromCharCode(k) }));
      this.move(x + 1, y);
      this.flush();
      return null;
    }
    let moved = false;
    switch (k) {
      case K_UP: this.move(x, y - 1); moved = true; break;
      case K_DOWN: this.move(x, y + 1); moved = true; break;
      case K_LEFT: this.move(x - 1, y); moved = true; break;
      case K_RIGHT: this.move(x + 1, y); moved = true; break;
      case K_HOME: this.move(0, y); moved = true; break;
      case K_END: this.move(CANVAS_COLS - 1, y); moved = true; break;
      case K_PGUP: this.move(x, y - 8); moved = true; break;
      case K_PGDN: this.move(x, y + 8); moved = true; break;
      case 0x20: this.act(); break;
      case 0x63: case 0x43: this.fg = (this.fg + 1) & 15; break;
      case 0x62: case 0x42: case 0x76: case 0x56: this.bg = (this.bg + 1) & 15; break;
      case 0x5b: this.ch = String.fromCharCode(this.ch.charCodeAt(0) <= 0x20 ? 0xff : this.ch.charCodeAt(0) - 1); break;
      case 0x5d: this.ch = String.fromCharCode(this.ch.charCodeAt(0) >= 0xff ? 0x20 : this.ch.charCodeAt(0) + 1); break;
      case 0x68: case 0x48: this.note = 'Pen character: [ and ]'; break;
      case 0x75: case 0x55: if (this.undo() < 0) this.note = 'Lift the pen first (P)'; break;
      case 0x72: case 0x52: if (this.redo() < 0) this.note = 'Lift the pen first (P)'; break;
      case 0x70: case 0x50:
        this.down = !this.down;
        if (this.down) { this.paintBegin(); this.dot(x, y, this.pen()); } else this.paintEnd();
        break;
      case 0x74: case 0x54: this.pop = this.tool; break;
      case 0x78: case 0x58: this.clear(); break;
      case K_ESC:
        if (this.tool === DT_TEXT) this.setTool(DT_DRAW);
        else if (this.anchor) { this.anchor = false; }
        else if (this.down) { this.down = false; this.paintEnd(); }
        else { this.leave(); return 'left'; }
        break;
      default: break;
    }
    if (moved && this.down && this.tool === DT_DRAW) { this.dot(this.x, this.y, this.pen()); return null; } // freehand: posted on idle
    this.flush();
    return null;
  }

  /** draw_mouse: b is the SGR button code, row/col 0-based, press false on release. */
  mouse(b: number, row: number, col: number, press: boolean, d: DrawState): void {
    if (!press) { if (!this.down) this.paintEnd(); this.flush(); return; }
    const h = d.hits.at(row, col);
    if (this.pop >= 0) {
      if (b >= 32) { if (h.id === HIT_CANVAS_TOOLS) this.pop = h.dr; return; }
      if (h.id === HIT_CANVAS_TOOLS) this.pickTool(h.dr); else this.pop = -1;
      return;
    }
    // the canvas area by geometry, not the last frame's hits: a report can arrive before the first canvas frame
    if (h.id === HIT_CANVAS_TOOLS || row >= this.vh || col >= this.vw || (b & 3) !== 0) return;
    if (b >= 32) { // motion with the left button held
      if (this.tool !== DT_DRAW) return;
      this.move(col + this.left, row + this.top);
      this.dot(this.x, this.y, this.pen());
      return;
    }
    this.move(col + this.left, row + this.top);
    if (this.tool === DT_DRAW && !this.down) this.paintBegin();
    this.act();
    if (this.tool !== DT_DRAW) this.flush();
  }

  /** lc_draw_canvas: the canvas at left/top, the status bar on the last row, then the tool popup. Returns the caret. */
  render(c: Cells, d: DrawState): { cr: number; cc: number } {
    const W = c.cols, H = c.rows;
    this.vw = Math.min(W, CANVAS_COLS); this.vh = Math.min(H - 1, CANVAS_ROWS);
    d.hits.reset();
    d.covers = [];
    c.pen(7, DEFAULT, 0);
    c.fill(0, 0, H, W, 0x20);
    for (let r = 0; r < this.vh; r++) {
      for (let k = 0; k < this.vw; k++) {
        const cell = this.grid[r + this.top]?.[k + this.left];
        if (!cell) continue;
        c.pen(cell.fg, cell.bg === 0 ? DEFAULT : cell.bg, 0);
        const code = cell.char.charCodeAt(0);
        c.put(r, k, code < 32 ? 0x20 : code);
      }
    }
    d.hits.add(HIT_CANVAS, 0, 0, this.vh, this.vw);
    const status = `${TOOLS[this.tool].slice(0, 12)} | pen ${this.ch} fg ${this.fg} bg ${this.bg} | ${this.x},${this.y} | ${this.note || 'Space paint, T tools, H pen, Esc back'}`;
    c.bar(H - 1, 0, W, status, TK_INK, DEFAULT, 0);
    if (this.pop >= 0) {
      const w = c.menu(1, 2, TOOLS, this.pop, TK_ACCENT, TK_INK, TK_ACCENT);
      d.hits.add(HIT_CANVAS_TOOLS, 2, 3, TOOLS.length, w - 2);
    }
    return { cr: this.y - this.top, cc: this.x - this.left };
  }
}
