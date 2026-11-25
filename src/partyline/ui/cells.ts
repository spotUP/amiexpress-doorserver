/**
 * Partyline hub cell grid: a 1:1 port of the C SDK's ui_cells (sdk/c/src/ui_cells.c in amiexpress-web).
 *
 * One cell is a 32-bit word laid out exactly as the C struct reads through memcpy on a little-endian host:
 * ch | fg << 8 | bg << 16 | flags << 24. Keeping the same word keeps the FNV hashes the scroll detector
 * votes with identical to the C, so the hub emits the same scroll decisions LIVECHAT68 does.
 *
 * Strings are latin1 JS strings: one char code 0..255 per byte, markers included (\x01..\x06).
 * The flush output is a latin1 string too; Buffer.from(out, 'latin1') gives the wire bytes.
 */

export const BOLD = 1;
export const BG_DEFAULT = 2;
export const WIDE = 4;
export const WIDE_TAIL = 8;
export const UNDERLINE = 16;
export const ITALIC = 32;
export const REVERSE = 64;
const UNKNOWN_FLAGS = 0x80;

export const DEFAULT = -1;

export const M_FG = 1;
export const M_BOLD = 2;
export const M_PLAIN = 3;
export const M_BASE = 4;
export const M_WIDE = 5;
export const M_ATTR = 6;
export const A_UNDERLINE = 1;
export const A_ITALIC = 2;
export const A_REVERSE = 4;

const SCROLL_ROWS = 128;
const HIT_MAX = 32;
const STYLE_FLAGS = BOLD | BG_DEFAULT | UNDERLINE | ITALIC | REVERSE;
const ATTR_FLAGS = BOLD | UNDERLINE | ITALIC | REVERSE;

export const cellCh = (w: number): number => w & 0xff;
export const cellFg = (w: number): number => (w >>> 8) & 0xff;
export const cellBg = (w: number): number => (w >>> 16) & 0xff;
export const cellFlags = (w: number): number => w >>> 24;

function makeCell(ch: number, fg: number, bg: number, bold: number): number {
  const flags = (bold ? BOLD : 0) | (bg < 0 ? BG_DEFAULT : 0);
  return ((ch & 0xff) | ((fg < 0 ? 7 : fg & 0xff) << 8) | ((bg < 0 ? 0 : bg & 0xff) << 16) | (flags << 24)) >>> 0;
}
const withCh = (pen: number, ch: number): number => ((pen & 0xffffff00) | (ch & 0xff)) >>> 0;
const orFlags = (w: number, f: number): number => (w | (f << 24)) >>> 0;

function sameBg(a: number, b: number): boolean {
  if ((cellFlags(a) ^ cellFlags(b)) & BG_DEFAULT) return false;
  return (cellFlags(a) & BG_DEFAULT) !== 0 || cellBg(a) === cellBg(b);
}
function sameStyle(a: number, b: number): boolean {
  return cellFg(a) === cellFg(b) && (cellFlags(a) & ATTR_FLAGS) === (cellFlags(b) & ATTR_FLAGS) && sameBg(a, b);
}
function blankFits(pen: number, p: number): boolean {
  return cellCh(p) === 0x20 && !((cellFlags(pen) | cellFlags(p)) & (UNDERLINE | REVERSE | WIDE | WIDE_TAIL)) && sameBg(pen, p);
}
function colour(base: number, bright: number, ext: number, v: number): string {
  if (v < 8) return String(base + v);
  if (v < 16) return String(bright + v - 8);
  return `${ext};5;${v}`;
}
function sgr(p: number): string {
  const f = cellFlags(p);
  let s = '\x1b[0;';
  if (f & BOLD) s += '1;';
  if (f & ITALIC) s += '3;';
  if (f & UNDERLINE) s += '4;';
  if (f & REVERSE) s += '7;';
  s += f & BG_DEFAULT ? '49' : colour(40, 100, 48, cellBg(p));
  return s + ';' + colour(30, 90, 38, cellFg(p)) + 'm';
}
function sgrTo(have: boolean, pen: number, p: number): string {
  if (!have || (cellFlags(pen) & ATTR_FLAGS & ~cellFlags(p))) return sgr(p);
  const add = cellFlags(p) & ~cellFlags(pen) & ATTR_FLAGS;
  const parts: string[] = [];
  if (add & BOLD) parts.push('1');
  if (add & ITALIC) parts.push('3');
  if (add & UNDERLINE) parts.push('4');
  if (add & REVERSE) parts.push('7');
  if (!sameBg(pen, p)) parts.push(cellFlags(p) & BG_DEFAULT ? '49' : colour(40, 100, 48, cellBg(p)));
  if (cellFg(pen) !== cellFg(p)) parts.push(colour(30, 90, 38, cellFg(p)));
  return '\x1b[' + parts.join(';') + 'm';
}
function firstDiff(a: Uint32Array, ai: number, b: Uint32Array, bi: number, n: number): number {
  let i = 0;
  while (i < n && a[ai + i] === b[bi + i]) i++;
  return i;
}

export function isMarker(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return (c >= M_FG && c <= M_BASE) || c === M_ATTR;
}

export interface HitRect { id: number; top: number; left: number; rows: number; cols: number }
export class Hits {
  r: HitRect[] = [];
  reset(): void { this.r.length = 0; }
  add(id: number, top: number, left: number, rows: number, cols: number): void {
    if (this.r.length >= HIT_MAX || rows < 1 || cols < 1) return;
    this.r.push({ id, top, left, rows, cols });
  }
  at(row: number, col: number): { id: number; dr: number; dc: number } {
    for (let i = this.r.length - 1; i >= 0; i--) {
      const h = this.r[i];
      if (row < h.top || row >= h.top + h.rows || col < h.left || col >= h.left + h.cols) continue;
      return { id: h.id, dr: row - h.top, dc: col - h.left };
    }
    return { id: -1, dr: 0, dc: 0 };
  }
}

/**
 * The width Cells.menu draws: the longest item plus "> " and the borders, and room for the title as box()
 * paints it (".- Title -.", six cells around it). A padded LIVECHAT label (' Channel ') is trimmed, box() pads it.
 */
export function menuWidth(items: readonly string[], label: string | null): number {
  let wide = 0;
  for (const it of items) if (it.length > wide) wide = it.length;
  return Math.max(wide + 4, label === null ? 0 : label.trim().length + 6);
}

export class Cells {
  back: Uint32Array;
  front: Uint32Array;
  full = true;
  fg = 7;
  bg = DEFAULT;
  bold = 0;
  attr = 0;
  /** What the terminal holds: cursor, last SGR, caret shown (-1 unknown). */
  tRow = -1; tCol = -1; tHave = false; tStyle = 0; tShow = -1;
  scTop = 0; scBot = 0; scLeft = 0; scRight = 0;
  scrolled = 0;
  sent = 0;
  wide: readonly (string | null)[] = [];

  constructor(readonly cols: number, readonly rows: number) {
    const n = cols * rows;
    this.back = new Uint32Array(n).fill(makeCell(0x20, 7, -1, 0));
    this.front = this.back.slice();
  }

  forget(): void { this.tRow = this.tCol = -1; this.tHave = false; this.tShow = -1; }
  invalidate(): void { this.full = true; this.forget(); }
  wideTable(glyphs: readonly (string | null)[]): void { this.wide = glyphs; this.full = true; }
  pen(fg: number, bg: number, bold: number): void { this.fg = fg; this.bg = bg; this.bold = bold; }

  put(row: number, col: number, ch: number): void {
    if (row < 0 || col < 0 || row >= this.rows || col >= this.cols) return;
    this.back[row * this.cols + col] = makeCell(ch, this.fg, this.bg, this.bold);
  }

  text(row: number, col: number, s: string, max = -1): number {
    if (max < 0) max = this.cols - col;
    const ok = row >= 0 && row < this.rows;
    const pen = makeCell(0x20, this.fg, this.bg, this.bold);
    let n = 0;
    for (; n < s.length && n < max; n++) {
      const k = col + n;
      if (ok && k >= 0 && k < this.cols) this.back[row * this.cols + k] = withCh(pen, s.charCodeAt(n));
    }
    return n;
  }

  fill(row: number, col: number, h: number, w: number, ch: number): void {
    let r0 = row < 0 ? 0 : row;
    const r1 = row + h > this.rows ? this.rows : row + h;
    const k0 = col < 0 ? 0 : col, k1 = col + w > this.cols ? this.cols : col + w;
    if (h <= 0 || w <= 0 || r0 >= r1 || k0 >= k1) return;
    const cell = makeCell(ch, this.fg, this.bg, this.bold);
    for (; r0 < r1; r0++) this.back.fill(cell, r0 * this.cols + k0, r0 * this.cols + k1);
  }

  box(top: number, left: number, h: number, w: number, borderFg: number, label: string | null, labelFg: number): void {
    const fg = this.fg, bold = this.bold;
    if (h < 2 || w < 2) return;
    this.fg = borderFg; this.bold = 0;
    this.put(top, left, 0x2e);
    this.fill(top, left + 1, 1, w - 2, 0x2d);
    this.put(top, left + w - 1, 0x2e);
    this.fill(top + 1, left, h - 2, 1, 0x7c);
    this.fill(top + 1, left + w - 1, h - 2, 1, 0x7c);
    this.put(top + h - 1, left, 0x60);
    this.fill(top + h - 1, left + 1, 1, w - 2, 0x2d);
    this.put(top + h - 1, left + w - 1, 0x27);
    if (label && w > 6) {
      this.fg = labelFg;
      this.put(top, left + 2, 0x20);
      const at = 3 + this.text(top, left + 3, label, w - 6);
      this.put(top, left + at, 0x20);
    }
    this.fg = fg; this.bold = bold;
  }

  modal(h: number, w: number, borderFg: number, label: string | null, labelFg: number): { top: number; left: number } {
    if (w > this.cols) w = this.cols;
    if (h > this.rows) h = this.rows;
    let l = ((this.cols - w) / 2 | 0) - 1;
    if (l < 0) l = 0;
    const t = (this.rows - h) / 2 | 0;
    this.fill(t + 1, l + 1, h - 2, w - 2, 0x20);
    this.box(t, l, h, w, borderFg, label, labelFg);
    return { top: t, left: l };
  }

  menu(top: number, left: number, items: readonly string[], sel: number, borderFg: number, fg: number, selFg: number, label: string | null = null): number {
    const pen = this.fg, lab = label === null ? null : label.trim(), w = menuWidth(items, label);
    this.fill(top + 1, left + 1, items.length, w - 2, 0x20);
    this.box(top, left, items.length + 2, w, borderFg, lab, fg);
    items.forEach((it, i) => {
      this.fg = i === sel ? selFg : fg;
      this.text(top + 1 + i, left + 1, i === sel ? '> ' : '  ', 2);
      this.text(top + 1 + i, left + 3, it, w - 4);
    });
    this.fg = pen;
    return w;
  }

  private markedPen(): number {
    return orFlags(makeCell(0x20, this.fg, this.bg, this.bold), this.attr << 4);
  }

  marked(row: number, col: number, s: string, from = 0, to = 0x7fffffff, max = 0x7fffffff): number {
    const baseFg = this.fg, baseBold = this.bold, baseAttr = this.attr;
    const ok = row >= 0 && row < this.rows, at = row * this.cols;
    let pen = this.markedPen(), n = 0;
    const len = s.length;
    for (let i = 0; i < len && i < to; i++) {
      const ch = s.charCodeAt(i);
      if (ch === M_WIDE) {
        if (i + 1 >= len) continue;
        if (i++ < from) continue;
        if (n + 2 > max) break;
        const k = col + n;
        if (ok && k >= 0 && k + 1 < this.cols) {
          this.back[at + k] = orFlags(withCh(pen, s.charCodeAt(i)), WIDE);
          this.back[at + k + 1] = orFlags(pen, WIDE_TAIL);
        }
        n += 2;
        continue;
      }
      if (ch === M_ATTR && i + 1 < len) { this.attr = (s.charCodeAt(++i) - 0x40) & 7; pen = this.markedPen(); continue; }
      if (ch >= 1 && ch <= M_BASE) {
        if (ch === M_FG && i + 1 < len) { this.fg = s.charCodeAt(++i); pen = this.markedPen(); continue; }
        if (ch === M_BOLD) { this.bold = 1; pen = this.markedPen(); continue; }
        if (ch === M_PLAIN) { this.bold = 0; pen = this.markedPen(); continue; }
        if (ch === M_BASE) { this.fg = baseFg; this.bold = baseBold; this.attr = baseAttr; pen = this.markedPen(); continue; }
      }
      if (i < from) continue;
      if (n >= max) break;
      const k = col + n;
      if (ok && k >= 0 && k < this.cols) this.back[at + k] = withCh(pen, ch);
      n++;
    }
    this.fg = baseFg; this.bold = baseBold; this.attr = baseAttr;
    return n;
  }

  bar(row: number, col: number, w: number, text: string | null, fg: number, bg: number, bold: number): void {
    const pfg = this.fg, pbg = this.bg, pbold = this.bold;
    let n = 0;
    this.pen(fg, bg, bold);
    if (text !== null) n = this.text(row, col, text, w);
    if (n < w) this.fill(row, col + n, 1, w - n, 0x20);
    this.pen(pfg, pbg, pbold);
  }

  button(top: number, left: number, w: number, text: string, borderFg: number, fg: number): void {
    const pfg = this.fg;
    if (w < 3) return;
    this.box(top, left, 3, w, borderFg, null, 0);
    this.fg = fg;
    this.fill(top + 1, left + 1, 1, w - 2, 0x20);
    let at = (w - 2 - text.length) / 2 | 0;
    if (at < 0) at = 0;
    this.text(top + 1, left + 1 + at, text, w - 2);
    this.fg = pfg;
  }

  scrollArea(top: number, bot: number, left: number, right: number): void {
    if (top < 0) top = 0;
    if (bot > this.rows - 1) bot = this.rows - 1;
    if (left < 0) left = 0;
    if (right > this.cols) right = this.cols;
    if (bot - top < 2 || right <= left || bot - top > SCROLL_ROWS) { this.scBot = 0; return; }
    this.scTop = top; this.scBot = bot; this.scLeft = left; this.scRight = right;
  }

  /** ui_cells_flush: the terminal state is unknown before and after. */
  flush(): string {
    this.forget();
    const out = this.flushCells();
    this.forget();
    return out;
  }

  /** ui_cells_present: scroll, cell diff, then the caret. */
  present(caret: boolean, cr: number, cc: number): string {
    const show = caret ? 1 : 0;
    let out = this.tryScroll();
    out += this.flushCells();
    if (this.tShow !== show) { out += caret ? '\x1b[?25h' : '\x1b[?25l'; this.tShow = show; }
    if (caret && (this.tRow !== cr || this.tCol !== cc)) {
      out += `\x1b[${cr + 1};${cc + 1}H`;
      this.tRow = cc < this.cols ? cr : -1; this.tCol = cc;
    }
    return out;
  }

  // shortcut: no ansi_buf cap, overflow or drain callback; the hub builds one string per present.
  private flushCells(): string {
    const { back, front, cols } = this;
    const n = cols * this.rows, last = n - 1, full = this.full;
    let i = 0, curRow = this.tRow, curCol = this.tCol, have = this.tHave, style = this.tStyle;
    let nextRow = 0, nextCol = 0, done = -1;
    const out: string[] = [];
    this.sent = 0;
    while (i < last) {
      if (!full) {
        const skip = firstDiff(back, i, front, i, last - i);
        if (skip > 0) {
          i += skip;
          if (i >= last) break;
          nextCol += skip;
          if (nextCol >= cols) { nextRow += (nextCol / cols) | 0; nextCol %= cols; }
        }
      }
      if (i > 0 && i - 1 > done && (cellFlags(back[i - 1]) & WIDE)) {
        i--;
        if (nextCol === 0) { nextCol = cols - 1; nextRow--; } else nextCol--;
      }
      const p = back[i];
      const row = nextRow, col = nextCol;
      if (++nextCol === cols) { nextCol = 0; nextRow++; }
      let wide: string | null = null;
      if (cellFlags(p) & WIDE) {
        const id = cellCh(p);
        if (col + 1 < cols && i + 1 < last && (cellFlags(back[i + 1]) & WIDE_TAIL) && id >= 1 && id <= this.wide.length) wide = this.wide[id - 1] ?? null;
      }
      if (row !== curRow || col !== curCol) {
        const gap = row === curRow ? col - curCol : 0;
        let k = 0;
        if (gap > 0 && gap <= 4 && have) {
          const q = i - gap;
          while (k < gap && !(cellFlags(back[q + k]) & (WIDE | WIDE_TAIL)) && (sameStyle(style, back[q + k]) || blankFits(style, back[q + k]))) k++;
          if (k === gap) for (k = 0; k < gap; k++) out.push(String.fromCharCode(cellCh(back[q + k])));
          else k = 0;
        }
        if (k > 0) { /* bridged */ }
        else if (gap > 0) out.push(gap > 1 ? `\x1b[${gap}C` : '\x1b[C');
        else out.push(col > 0 ? `\x1b[${row + 1};${col + 1}H` : `\x1b[${row + 1}H`);
      }
      if (!have || !(sameStyle(style, p) || blankFits(style, p))) {
        out.push(sgrTo(have, style, p));
        style = (p & ~((~STYLE_FLAGS & 0xff) << 24)) >>> 0;
        have = true;
      }
      if (wide !== null) {
        out.push(wide);
        front[i] = p;
        front[i + 1] = back[i + 1];
        i += 2;
        if (++nextCol === cols) { nextCol = 0; nextRow++; }
        this.sent += 2;
        curRow = row; curCol = col + 2;
      } else {
        out.push(String.fromCharCode(cellFlags(p) & (WIDE | WIDE_TAIL) ? 0x20 : cellCh(p)));
        front[i] = p;
        i++;
        this.sent++;
        curRow = row; curCol = col + 1;
      }
      done = i - 1;
      if (curCol >= cols) curRow = -1;
    }
    front[n - 1] = back[n - 1];
    this.tRow = curRow; this.tCol = curCol; this.tStyle = style; this.tHave = have;
    this.full = false;
    return out.join('');
  }

  private rowCost(rb: number, rf: number): number {
    const n = this.cols;
    if (rf < this.scTop || rf >= this.scBot) return n;
    let k = 0, at = 0;
    while (at < n) {
      at += firstDiff(this.back, rb * n + at, this.front, rf * n + at, n - at);
      if (at < n) { k++; at++; }
    }
    return k;
  }
  private shiftCost(s: number): number {
    let k = 0;
    for (let r = this.scTop; r < this.scBot; r++) k += this.rowCost(r, r + s);
    return k;
  }

  private tryScroll(): string {
    const top = this.scTop, h = this.scBot - this.scTop, cols = this.cols;
    const base = top * cols, span = h * cols;
    this.scrolled = 0;
    if (this.scBot === 0 || this.full) return '';
    if (firstDiff(this.back, base, this.front, base, span) >= span) return '';
    const hb = new Uint32Array(h), hf = new Uint32Array(h), blank = new Uint8Array(h);
    for (let r = 0; r < h; r++) {
      const b = base + r * cols;
      let x = 2166136261, y = 2166136261, same = 1;
      const b0 = this.back[b + this.scLeft];
      for (let k = this.scLeft; k < this.scRight; k++) {
        const w = this.back[b + k];
        if (w !== b0) same = 0;
        x = Math.imul((x ^ w) >>> 0, 16777619) >>> 0;
        y = Math.imul((y ^ this.front[b + k]) >>> 0, 16777619) >>> 0;
      }
      hb[r] = x; hf[r] = y; blank[r] = same;
    }
    let score0 = 0, best = 0, bestScore = 0;
    for (let r = 0; r < h; r++) if (!blank[r] && hb[r] === hf[r]) score0++;
    for (let s = -(h - 1); s < h; s++) {
      if (s === 0) continue;
      let score = 0;
      for (let r = 0; r < h; r++) if (r + s >= 0 && r + s < h && !blank[r] && hb[r] === hf[r + s]) score++;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best === 0 || bestScore <= score0) return '';
    if (this.shiftCost(best) + 16 >= this.shiftCost(0)) return '';
    const abs = best < 0 ? -best : best;
    const out = `\x1b[${top + 1};${this.scBot}r\x1b[${abs > 1 ? abs : ''}${best > 0 ? 'S' : 'T'}\x1b[r`;
    const unknown = (UNKNOWN_FLAGS << 24) >>> 0;
    if (best > 0) {
      this.front.copyWithin(base, base + best * cols, base + h * cols);
      this.front.fill(unknown, base + (h - best) * cols, base + h * cols);
    } else {
      this.front.copyWithin(base - best * cols, base, base + (h + best) * cols);
      this.front.fill(unknown, base, base - best * cols);
    }
    this.tRow = this.tCol = -1;
    this.scrolled = best;
    return out;
  }
}

/** ui_cells_marked_cols: the columns a marked string fills. */
export function markedCols(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === M_FG || c === M_ATTR) { if (i + 1 < s.length) i++; continue; }
    if (c === M_BOLD || c === M_PLAIN || c === M_BASE) continue;
    if (c === M_WIDE) { if (i + 1 < s.length) { i++; n += 2; } continue; }
    n++;
  }
  return n;
}

/** ui_cells_wrap: [start, end) byte ranges of each wrapped row; at least one row. */
export function wrap(s: string, width: number, max: number): Array<[number, number]> {
  const rows: Array<[number, number]> = [];
  const len = s.length;
  let i = 0;
  if (width < 1) width = 1;
  while (i < len && rows.length < max) {
    let cols = 0, j = i, brk = -1, brkNext = -1;
    for (;;) {
      const ch = j < len ? s.charCodeAt(j) : 0;
      if (ch > 0x20) { if (cols === width) break; cols++; j++; continue; }
      if (ch === 0) break;
      if (isMarker(s, j)) { j += ((ch === M_FG || ch === M_ATTR) && j + 1 < len) ? 2 : 1; continue; }
      if (ch === M_WIDE && j + 1 < len) { if (cols + 2 > width && cols > 0) break; cols += 2; j += 2; continue; }
      if (ch === 0x0a) break;
      if (ch === 0x20) { brk = j; brkNext = j + 1; }
      if (cols === width) break;
      cols++; j++;
    }
    const cj = j < len ? s.charCodeAt(j) : 0;
    if (cj === 0) { rows.push([i, j]); break; }
    if (cj === 0x0a) { rows.push([i, j]); i = j + 1; continue; }
    if (cj === 0x20) { brk = j; brkNext = j + 1; }
    if (brk <= i) { brk = j; brkNext = j; }
    rows.push([i, brk]);
    i = brkNext;
  }
  if (rows.length === 0 && max > 0) rows.push([0, 0]);
  return rows;
}
