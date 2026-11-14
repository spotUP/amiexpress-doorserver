/**
 * Partyline hub engine: lc_draw ported 1:1 from amiexpress-web sdk/c/examples/livechat/livechat_ui.c.
 * The C keeps its draw state in statics; the hub runs many sessions in one process, so it lives in DrawState.
 * Overlays (help, view, search, settings, modal) live in overlays.ts. The slash menu is slash.ts. Not ported yet: context popup,
 * format picker, theme and the canvas/pen picker.
 */
import { Cells, Hits, DEFAULT, BOLD, BG_DEFAULT, wrap } from './cells';
import { cover, drawOverlays, OverlayState, Rect } from './overlays';
import { drawSlash } from './slash';
import { Model, Line, Side, lineMarked, typingMarked, SIDE_HEAD, SIDE_ROOM, SIDE_USER, FOCUS_INPUT, FOCUS_SIDEBAR } from './model';

export const HIT_NONE = 0, HIT_MENU = 1, HIT_DROPDOWN = 2, HIT_SIDEBAR = 3, HIT_CHAT = 4, HIT_INPUT = 5,
  HIT_STATUS = 6, HIT_POPUP = 7, HIT_SCROLLBAR = 12; // the C lc_hit numbers
const WRAP_MAX = 24, CHAT_ROWS_MAX = 64;
export const MENU_TEXT = ' Chat v4.0.0   Tools   View   Help  ';
export const MENU_COL = [1, 15, 23, 30];
export const MENU_ITEMS: ReadonlyArray<readonly string[]> = [
  ['Help (F1)', 'Channel List (F2)', 'Next Channel (F3)', 'Join Channel...', 'Leave Channel'],
  ['Emoji (F4)', 'Files (F6)', 'Pins (F7)', 'Search (Ctrl+F)', 'Threads'],
  ['Settings (Ctrl+S)', 'Theme', 'Toggle Sidebar', 'Clear Chat'],
  ['About', 'Keyboard Shortcuts', 'Quit (Ctrl+Q)'],
];
export const MENU_LABELS = ['Chat v4.0.0', 'Tools', 'View', 'Help'];

export class DrawState {
  hits = new Hits();
  /** lc_covers: the boxes the overlays painted this frame (picture placement skips them). */
  covers: Rect[] = [];
  chatBody = 0; chatLeft = 0; chatRows = 0; chatWidth = 0;
  chatRowLine = new Int16Array(CHAT_ROWS_MAX).fill(-1);
  barBody = 0; barRows = 0; barThumb = 0; barSpan = 0;
  rewraps = 0;
  /** lc_scroll_at: the scroll (rows from the bottom) that puts the thumb under a pointer row; -1 with no scrollbar. */
  scrollAt(row: number): number {
    if (this.barRows <= 0) return -1;
    const track = this.barRows - this.barThumb;
    const pos = Math.max(0, Math.min(track, row - this.barBody - Math.trunc(this.barThumb / 2)));
    return track > 0 ? this.barSpan - Math.trunc((pos * this.barSpan + track - 1) / track) : 0;
  }
  /** Lines actually rewrapped (the per-line cache misses). */
  lineWraps = 0;
  private perLine = new WeakMap<Line, { t: string; n: number }>();
  private lineRows: number[] = [];
  private cacheGen = -1; private cacheN = -1; private cacheWidth = 0; private cacheStamps = false;
  /** draw_chat's wrap cache: pass 1 only when a line, the width or the stamps changed. */
  rows(m: Model, width: number, stamps: boolean): number[] {
    if (this.cacheGen !== m.linesGen || this.cacheN !== m.lines.length || this.cacheWidth !== width || this.cacheStamps !== stamps) {
      if (this.cacheWidth !== width) this.perLine = new WeakMap();
      // Per-line cache: rewrap only lines whose marked text changed (a new message, an edit, a reaction).
      this.lineRows = m.lines.map((l) => {
        const t = lineMarked(m, l, stamps, width), hit = this.perLine.get(l);
        if (hit && hit.t === t) return hit.n;
        const n = wrap(t, width, WRAP_MAX).length;
        this.perLine.set(l, { t, n });
        this.lineWraps++;
        return n;
      });
      this.cacheGen = m.linesGen; this.cacheN = m.lines.length; this.cacheWidth = width; this.cacheStamps = stamps;
      this.rewraps++;
    }
    return this.lineRows;
  }
}

function drawMenubar(c: Cells, m: Model): void {
  const p = m.pal, w = c.cols;
  c.bar(0, 0, w, MENU_TEXT, p.barInk, p.accent, 0);
  if (w < 60) return;
  c.pen(p.accent, p.accent, 0);
  c.fill(0, 36, 1, w - 12 - 36 + 1, 0x2f);
  if (48 <= w - 12) c.put(0, 48, 0x20);
  c.pen(p.grey, p.accent, 0);
  c.put(0, w - 11, 0x20);
  c.put(0, w - 1, 0x20);
  c.pen(p.ink, p.accent, 0);
  c.text(0, w - 10, 'LIVE CHAT', 9);
}

function drawSideItem(c: Cells, m: Model, it: Side, row: number, width: number, sel: boolean): void {
  const mark = sel ? '> ' : '  ', p = m.pal;
  let buf: string;
  if (it.kind === SIDE_HEAD) buf = '  \x01\xCC\x02' + it.label.slice(0, 38);
  else if (it.kind === SIDE_ROOM)
    buf = mark + '\x01' + String.fromCharCode(it.joined ? p.ink : it.unread > 0 ? p.ok : p.dim) + (it.open ? 'v' : '>') + ' '
      + (it.art ? '[A]' : '#') + ' ' + it.label.slice(0, 36) + (it.unread ? ` (${it.unread})` : '');
  else if (it.kind === SIDE_USER)
    buf = mark + '  \x01' + String.fromCharCode(it.status === 0 ? 2 : 1) + 'O\x04 '
      + (it.note !== '' ? it.label.slice(0, 20) + ': ' + it.note.slice(0, 14) : it.label.slice(0, 38));
  else buf = mark + '@ ' + it.label;
  c.pen(p.ink, DEFAULT, 0);
  c.marked(row, 1, buf, 0, 128, width);
}

function drawSidebar(c: Cells, m: Model, top: number, h: number, w: number): void {
  const p = m.pal;
  c.pen(p.ink, DEFAULT, 0);
  c.fill(top + 1, 1, h - 2, w - 2, 0x20);
  c.box(top, 0, h, w, m.focus === FOCUS_SIDEBAR ? p.borderFocus : p.accent, 'Sidebar', p.accent);
  for (let i = 0; i < m.side.length && i < h - 2; i++) drawSideItem(c, m, m.side[i], top + 1 + i, w - 2, i === m.sideSel);
}

function tintRow(c: Cells, m: Model, row: number, col: number, width: number): void {
  for (let k = 0; k < width; k++) {
    const i = row * c.cols + col + k, v = c.back[i];
    const flags = (v >>> 24) & ~(BG_DEFAULT | BOLD);
    c.back[i] = ((v & 0xff) | (m.pal.barInk << 8) | (m.pal.accent << 16) | (flags << 24)) >>> 0;
  }
}

function drawChat(c: Cells, m: Model, d: DrawState, top: number, h: number, left: number, w: number): void {
  const p = m.pal, stamps = m.timestamps && !m.compact, picked = m.pickIndex();
  let rows = h - 3, used = 0, total = 0, at = 0, pickAt = 0, body: number;
  const width = w - 4;
  c.pen(p.ink, DEFAULT, 0);
  c.box(top, left, h, w, picked >= 0 ? p.borderFocus : p.accent, m.paneLabel !== '' ? m.paneLabel : 'No channel', p.ink);
  if (c.cols > 40) {
    c.bar(top + 1, left + 1, w - 5, ' Chat', p.grey, p.labelBg, 0);
    c.bar(top + 1, left + w - 4, 3, '', p.labelTail, p.labelBg, 0);
    body = top + 2;
  } else { body = top + 1; rows++; }
  d.chatRows = 0;
  if (rows < 1 || width < 1) { c.fill(body, left + 1, top + h - 1 - body, w - 2, 0x20); return; }
  d.chatBody = body; d.chatLeft = left + 1; d.chatRows = Math.min(rows, CHAT_ROWS_MAX); d.chatWidth = width;
  d.hits.add(HIT_CHAT, body, left + 1, rows, w - 2);
  d.chatRowLine.fill(-1);
  const lineRows = d.rows(m, width, stamps);
  for (let i = 0; i < m.lines.length; i++) { if (i === picked) pickAt = total; total += lineRows[i]; }
  const typing = m.typing.map((t) => typingMarked(m, t));
  for (const s of typing) total += wrap(s, width, WRAP_MAX).length;
  let first = picked >= 0 ? pickAt + Math.trunc(lineRows[picked] / 2) - Math.trunc(rows / 2) : total - m.scroll - rows;
  if (first > total - rows) first = total - rows;
  if (first < 0) first = 0;
  c.pen(p.ink, DEFAULT, 0);
  const paint = (s: string, line: number): void => {
    for (const [from, to] of wrap(s, width, WRAP_MAX)) {
      const r = at - first;
      at++;
      if (r < 0 || r >= rows) continue;
      if (line >= 0 && r < CHAT_ROWS_MAX) d.chatRowLine[r] = line;
      const cols = c.marked(body + r, left + 1, s, from, to, width);
      c.fill(body + r, left + 1 + cols, 1, w - 2 - cols, 0x20);
      used = r + 1;
      if (line >= 0 && line === picked) tintRow(c, m, body + r, left + 1, width);
    }
  };
  for (let i = 0; i < m.lines.length && at < first + rows; i++) {
    if (at + lineRows[i] <= first) { at += lineRows[i]; continue; }
    paint(lineMarked(m, m.lines[i], stamps, width), i);
  }
  for (let i = 0; i < typing.length && at < first + rows; i++) paint(typing[i], -1);
  c.fill(body + used, left + 1, rows - used, w - 2, 0x20);
  if (total > rows) {
    const thumb = Math.max(1, Math.trunc(rows * rows / total)), pos = Math.trunc(first * (rows - thumb) / (total - rows));
    c.pen(p.scrollTrack, p.scrollTrack, 0);
    c.fill(body, left + w - 3, pos, 1, 0x20);
    c.fill(body + pos + thumb, left + w - 3, rows - pos - thumb, 1, 0x20);
    c.pen(p.scrollThumb, p.scrollThumb, 0);
    c.fill(body + pos, left + w - 3, thumb, 1, 0x20);
    c.pen(p.ink, DEFAULT, 0);
    d.barBody = body; d.barRows = rows; d.barThumb = thumb; d.barSpan = total - rows;
    d.hits.add(HIT_SCROLLBAR, body, left + w - 3, rows, 1);
  }
}

/** draw_input: the message box, its selection, the emoji button. Returns the caret cell. */
function drawInput(c: Cells, m: Model): { cr: number; cc: number } {
  const p = m.pal, W = c.cols, row = c.rows - 4;
  const iw = W - 6 >= 24 ? W - 6 : W, room = iw - 3, from = m.inputCur > room ? m.inputCur - room : 0;
  c.pen(p.ink, DEFAULT, 0);
  c.fill(row + 1, 1, 1, iw - 2, 0x20);
  c.box(row, 0, 3, iw, m.focus === FOCUS_INPUT ? p.borderFocus : p.accent,
    m.pick !== '' ? '[PICK MESSAGE: Up/Down, Enter, Esc]' : m.editing ? '[EDITING]' : 'Message', p.ink);
  c.text(row + 1, 1, m.input.slice(from), room);
  if (m.inputAnchor >= 0 && m.inputAnchor !== m.inputCur) {
    const a = Math.max(Math.min(m.inputAnchor, m.inputCur), from), b = Math.min(Math.max(m.inputAnchor, m.inputCur), from + room);
    if (b > a) { c.pen(p.barInk, p.ink, 0); c.text(row + 1, 1 + a - from, m.input.slice(a, b), b - a); c.pen(p.ink, DEFAULT, 0); }
  }
  if (iw < W) c.button(row, iw, 6, ':D', p.grey, p.activity);
  return { cr: row + 1, cc: 1 + m.inputCur - from };
}

/** lc_draw: menubar, sidebar, chat pane, input, status bar, open menu, then the overlays in the C order. */
export function draw(c: Cells, m: Model, d: DrawState, o?: OverlayState): { cr: number; cc: number } {
  const p = m.pal, W = c.cols, H = c.rows, sw = m.sidebarWidth(), h = H - 5;
  d.hits.reset();
  d.covers.length = 0;
  d.barRows = 0;
  drawMenubar(c, m);
  for (let i = 0; i < 4; i++) d.hits.add(HIT_MENU, 0, MENU_COL[i], 1, MENU_LABELS[i].length);
  d.hits.add(HIT_STATUS, H - 1, 0, 1, W);
  d.hits.add(HIT_INPUT, H - 4, 0, 3, W);
  if (sw > 0) { drawSidebar(c, m, 1, h, sw); d.hits.add(HIT_SIDEBAR, 2, 1, h - 2, sw - 2); }
  drawChat(c, m, d, 1, h, sw, W - sw);
  const caret = drawInput(c, m);
  c.bar(H - 1, 0, W, `@${m.handle.slice(0, 30)} | Node ${m.node} | #${m.room.slice(0, 40)} | [L] [*] | F1:Help F4:Emoji`, p.ink, DEFAULT, 0);
  if (m.menu >= 0) {
    c.pen(p.ink, DEFAULT, 0);
    const mw = c.menu(1, MENU_COL[m.menu] - 1, MENU_ITEMS[m.menu], m.menuSel, p.accent, p.ink, p.accent);
    d.hits.add(HIT_DROPDOWN, 2, MENU_COL[m.menu], MENU_ITEMS[m.menu].length, mw - 2);
    cover(d, 1, MENU_COL[m.menu] - 1, MENU_ITEMS[m.menu].length + 2, mw);
  }
  if (o) { drawSlash(c, m, d, o); drawOverlays(c, m, d, o, caret); }
  return caret;
}
