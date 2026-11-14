/**
 * Partyline hub engine: the text overlays of lc_draw, ported 1:1 from amiexpress-web
 * sdk/c/examples/livechat/livechat_ui.c (draw_help, draw_view, draw_modal, draw_search, draw_settings,
 * lc_progress_bar/bytes, lc_settings_layout). Grid-tested against the C in tests/partyline-ui-overlays.test.ts.
 */
import { Cells, DEFAULT, wrap } from './cells';
import { Model, TK_BASE, T_BAR } from './model';
import type { DrawState } from './draw';

export const HIT_YES = 8, HIT_NO = 9, HIT_OK = 10, HIT_MODAL = 11,
  HIT_SEARCH = 17, HIT_SEARCH_Q = 18, HIT_SEARCH_USER = 19, HIT_SEARCH_ROW = 20, HIT_SETTINGS = 21, HIT_SETTINGS_ROW = 22;

export const MODAL_NONE = 0, MODAL_MESSAGE = 1, MODAL_QUIT = 2, MODAL_PROMPT = 3, MODAL_RECONNECT = 4, MODAL_PROGRESS = 5;
export const SEARCH_MAX = 20, VIEW_MAX = 40;

export const SET_LOGINS = 0, SET_FILES = 1, SET_DOORS = 2, SET_MESSAGES = 3, SET_ANNOUNCE = 4, SET_MUTE = 5,
  SET_TYPING = 6, SET_STAMPS = 7, SET_ONLINE = 8, SET_AWAY = 9, SET_BUSY = 10, SET_DND = 11, SET_CLOSE = 12, SET_ITEMS = 13;
export const SETTINGS_LABELS = ['Show User Logins/Logouts', 'Show File Uploads/Downloads', 'Show Door Activity',
  'Show New Messages', 'Show System Announcements', 'Mute Sounds', 'Show Typing Indicators', 'Show Timestamps',
  'Online', 'Away', 'Busy', 'Do Not Disturb', 'Close'];

/** The TS door's help (board/Doors/livechat help content), voice section left out as in the C. */
export const HELP_TEXT: readonly string[] = [
  '=== LIVECHAT v4.0 - DESKTOP-LEVEL BBS CHAT ===', 'A full-featured multi-user chat system with neo-blessed UI', '',
  '--- KEYBOARD SHORTCUTS ---', 'Navigation:', '  Tab              Next channel', '  Shift+Tab        Previous channel',
  '  PageUp           Scroll chat up', '  PageDown         Scroll chat down', '  Escape           Close dialogs / Return to input',
  'Chat:', '  Enter            Send message', '  Ctrl+N           New message prompt', '  Ctrl+R           Room menu (join room)',
  '  Ctrl+S           Open settings', '  F1               Show this help', 'Window Controls:',
  '  F2               Toggle sidebar visibility', '  F3               Switch sidebar tab (Channels/Users)',
  '  F4 / Ctrl+E      Open emoji picker', '  F5               Format selected text (colors/effects)',
  '  F6               File sharing browser', '  Tab              Cycle focus between panels',
  '  Ctrl+Q           Quit (with confirmation)', 'Text Formatting:', '  Shift+Arrow      Select text in input box',
  '  F5               Open format picker (with text selected)', '  Right-click      Open format picker (with text selected)', '',
  '--- COMMANDS ---', 'Room Commands:', '  /join <room>     Join a channel', '  /leave           Leave current channel',
  '  /create <name>   Create new channel', '  /topic <text>    Set channel topic', '  /rooms           List all rooms',
  'User Commands:', '  /who             List online users', '  /whois <user>    User information',
  '  /dm <user> <msg> Send direct message', '  /ignore <user>   Ignore a user', '  /unignore <user> Unignore a user',
  'Status Commands:', '  /away [msg]      Set away status', '  /back            Return from away',
  '  /status <status> Set status (online/away/busy/dnd)', 'Other Commands:', '  /me <action>     Send action message',
  '  /clear           Clear chat window', '  /draw <channel>  Open drawing whiteboard', '  /files           Open file sharing browser',
  '  /emoji [search]  Open emoji picker or search', '  /events [type]   Manage event notifications',
  '  /react [emoji] <msg-id>, /thread <msg-id> message', '  /help            Show this help',
];

/** The overlay state lc_model carries (help, view, modal, search, settings). */
export class OverlayState {
  help = false; helpTop = 0;
  view = false; viewTop = 0; viewTitle = ''; viewText: string[] = [];
  modal = MODAL_NONE; modalTitle = ''; modalText = ''; modalAttempt = 0; modalMax = 0;
  upReceived = 0; upTotal = 0;
  prompt = '';
  search = false; searchField = 0; searchQ = ''; searchUser = ''; searchSel = 0; searchTop = 0; searchRows: string[] = [];
  settings = false; settingsSel = 0; settingsVal = [false, false, false, false, false, false, false, false]; settingsStatus = 0;
  /** The "/" menu (lc_model slash_*): selected match, first visible, Esc hid it until the next key. */
  slashSel = 0; slashTop = 0; slashOff = false;
  /** The format/emoji picker is shown (lc_model fmt). */
  fmt = false;
  /** The emoji picker (lc_model fmt_*): its entries, category, selected item, first visible item, and which pane has the keys. */
  pickItems: { code: string; face: string; cat: number }[] = [];
  pickCat = 0; pickItem = 0; pickTop = 0; pickPane = 0;
  /** The last frame's settings interior row -> SET_* (-1 a gap); lc_hit reads it. */
  setItemAt = new Int8Array(64).fill(-1);
}

export interface Rect { row: number; col: number; rows: number; cols: number }
export const COVER_MAX = 8;

export function cover(d: DrawState, row: number, col: number, rows: number, cols: number): void {
  if (d.covers.length === COVER_MAX) { d.covers[COVER_MAX - 1] = { row: 0, col: 0, rows: 1000, cols: 1000 }; return; }
  d.covers.push({ row, col, rows, cols });
}

function modal(c: Cells, d: DrawState, h: number, w: number, borderFg: number, label: string, labelFg: number): { top: number; left: number } {
  const r = c.modal(h, w, borderFg, label, labelFg);
  cover(d, r.top, r.left, Math.min(h, c.rows), Math.min(w, c.cols));
  return r;
}

function centre(c: Cells, row: number, left: number, width: number, text: string): void {
  const at = Math.max(0, (width - text.length) / 2 | 0);
  c.text(row, left + at, text, width);
}

export function progressBar(done: number, total: number, width: number): string {
  let fill = 0, pct = 0;
  if (width > 60) width = 60;
  if (total > 0) {
    done = Math.min(Math.max(done, 0), total);
    if (total > 20000000) { done = Math.trunc(done / 1024); total = Math.trunc(total / 1024); }
    pct = done >= total ? 100 : Math.min(100, Math.trunc(done * 100 / total));
    fill = Math.trunc(pct * width / 100);
  }
  let out = '[';
  for (let i = 0; i < width; i++) out += i < fill ? '#' : '.';
  out += ']';
  return total > 0 ? out + ` ${String(pct).padStart(3)}%` : out;
}

function bytesText(b: number): string {
  if (b >= 1048576) return `${Math.trunc(b / 1048576)}.${Math.trunc((Math.trunc(b / 1024) % 1024) * 10 / 1024)} MB`;
  if (b >= 1024) return `${Math.trunc(b / 1024)} KB`;
  return `${b < 0 ? 0 : b} B`;
}
export const progressBytes = (done: number, total: number): string =>
  total > 0 ? `${bytesText(done)} of ${bytesText(total)}` : bytesText(done);

function drawText(c: Cells, m: Model, d: DrawState, title: string, lines: readonly string[], from: number, strip: boolean): void {
  const p = m.pal, h = c.rows - 2, w = Math.min(c.cols - 4, 76);
  c.pen(p.ink, DEFAULT, 0);
  const { top, left } = modal(c, d, h, w, p.accent, title, p.ink);
  for (let i = 0; i < h - 2 && from + i < lines.length; i++) {
    const t = lines[from + i], head = t[0] === '=' || (!strip && t[0] === '-');
    c.pen(head ? p.accent : p.ink, DEFAULT, head ? 1 : 0);
    c.text(top + 1 + i, left + 2, strip && head ? t.slice(1) : t, w - 4);
  }
  c.pen(p.ink, DEFAULT, 0);
}

function drawModal(c: Cells, m: Model, d: DrawState, o: OverlayState, caret: { cr: number; cc: number }): void {
  const p = m.pal;
  let w = 50;
  c.pen(p.ink, DEFAULT, 0);
  if (o.modal === MODAL_PROMPT) {
    const { top, left } = modal(c, d, 7, w, p.accent, 'Message', p.ink);
    if (w > c.cols) w = c.cols;
    centre(c, top + 2, left + 1, w - 2, o.modalTitle);
    c.text(top + 4, left + 3, '> ', 2);
    const field = w - 9, from = o.prompt.length > field ? o.prompt.length - field : 0;
    c.text(top + 4, left + 5, o.prompt.slice(from), field + 1);
    caret.cr = top + 4; caret.cc = left + 5 + o.prompt.length - from;
    return;
  }
  if (o.modal === MODAL_PROGRESS) {
    const { top, left } = modal(c, d, 9, w, p.accent, 'Uploading picture', p.ink);
    if (w > c.cols) w = c.cols;
    centre(c, top + 2, left + 1, w - 2, o.modalText);
    centre(c, top + 4, left + 1, w - 2, progressBar(o.upReceived, o.upTotal, 32));
    centre(c, top + 5, left + 1, w - 2, progressBytes(o.upReceived, o.upTotal));
    c.pen(p.dim, DEFAULT, 0);
    centre(c, top + 7, left + 1, w - 2, 'Esc cancels');
    c.pen(p.ink, DEFAULT, 0);
    d.hits.add(HIT_MODAL, top, left, 9, w);
    return;
  }
  if (o.modal === MODAL_RECONNECT) {
    const { top, left } = modal(c, d, 12, w, p.accent, 'Connection Error', p.ink);
    if (w > c.cols) w = c.cols;
    c.pen(p.alert, DEFAULT, 0);
    centre(c, top + 2, left + 1, w - 2, 'Lost connection to server');
    c.pen(p.ink, DEFAULT, 0);
    centre(c, top + 4, left + 1, w - 2, o.modalText);
    centre(c, top + 6, left + 1, w - 2, `Attempt ${o.modalAttempt}/${o.modalMax}`);
    c.button(top + 8, left + 12, 9, '[ Retry ]', p.ok, p.ok);
    c.button(top + 8, left + 29, 10, '[ Cancel ]', p.alert, p.alert);
    d.hits.add(HIT_MODAL, top, left, 12, w);
    d.hits.add(HIT_YES, top + 8, left + 12, 3, 9);
    d.hits.add(HIT_NO, top + 8, left + 29, 3, 10);
    return;
  }
  const { top, left } = modal(c, d, 12, w, p.accent, 'Message', p.ink);
  if (w > c.cols) w = c.cols;
  centre(c, top + 3, left + 1, w - 2, o.modalTitle);
  const parts = wrap(o.modalText, w - 4, 3), row = parts.length >= 2 ? top + 4 : top + 5;
  parts.forEach(([a, b], k) => centre(c, row + k, left + 1, w - 2, o.modalText.slice(a, b)));
  if (o.modal === MODAL_QUIT) {
    c.button(top + 7, left + 12, 9, '[ Yes ]', p.accent, p.ink);
    c.button(top + 7, left + 29, 8, '[ No ]', p.accent, p.ink);
    d.hits.add(HIT_MODAL, top, left, 12, w);
    d.hits.add(HIT_YES, top + 7, left + 12, 3, 9);
    d.hits.add(HIT_NO, top + 7, left + 29, 3, 8);
  } else {
    const bx = left + ((w - 10) / 2 | 0);
    c.button(top + 7, bx, 10, '[ OK ]', p.accent, p.ink);
    d.hits.add(HIT_MODAL, top, left, 12, w);
    d.hits.add(HIT_OK, top + 7, bx, 3, 10);
  }
}

function drawSearch(c: Cells, m: Model, d: DrawState, o: OverlayState, caret: { cr: number; cc: number }): void {
  const p = m.pal, h = c.rows * 9 / 10 | 0, w = c.cols * 9 / 10 | 0;
  c.pen(p.ink, DEFAULT, 0);
  const { top, left } = modal(c, d, h, w, p.accent, 'Message Search', p.ink);
  d.hits.add(HIT_SEARCH, top, left, h, w);
  const fw = ((w - 4) / 2 | 0) - 1, ux = left + (w / 2 | 0);
  for (let i = 0; i < 2; i++) {
    const x = i === 0 ? left + 2 : ux, text = i === 0 ? o.searchQ : o.searchUser, focus = o.searchField === i;
    c.pen(p.ink, DEFAULT, 0);
    c.box(top + 1, x, 3, fw, p.ink, i === 0 ? 'Query' : 'Username (optional)', p.ink);
    c.pen(p.ink, focus ? p.labelBg : DEFAULT, 0);
    c.fill(top + 2, x + 1, 1, fw - 2, 0x20);
    c.text(top + 2, x + 1, text, fw - 3);
    d.hits.add(i === 0 ? HIT_SEARCH_Q : HIT_SEARCH_USER, top + 1, x, 3, fw);
    if (focus) { caret.cr = top + 2; caret.cc = x + 1 + text.length; }
  }
  const rt = top + 5, rh = h - 8, rw = w - 4;
  c.pen(p.ink, DEFAULT, 0);
  c.box(rt, left + 2, rh, rw, p.ink, 'Results', p.ink);
  for (let i = 0; i < rh - 2 && o.searchTop + i < o.searchRows.length; i++) {
    const k = o.searchTop + i, sel = k === o.searchSel;
    c.pen(p.ink, sel ? p.labelBg : DEFAULT, 0);
    if (sel) c.fill(rt + 1 + i, left + 3, 1, rw - 2, 0x20);
    c.text(rt + 1 + i, left + 3, o.searchRows[k], rw - 2);
  }
  d.hits.add(HIT_SEARCH_ROW, rt + 1, left + 3, rh - 2, rw - 2);
  c.pen(p.accent, DEFAULT, 0);
  c.text(top + h - 2, left + 2, 'Enter: Search | Tab: Next field | Esc: Close', w - 4);
  c.pen(p.ink, DEFAULT, 0);
}

export interface SettingsLayout { h: number; w: number; row: number[]; head: number; rule: number; status: number }

/** lc_settings_layout: the TS row offsets, gaps given up last-listed first when the screen is short. */
export function settingsLayout(cols: number, rows: number): SettingsLayout {
  const w = Math.min(Math.min(Math.max(cols - 4, 20), 72), cols), h = Math.min(Math.min(Math.max(rows - 4, 18), 22), rows);
  const ih = h - 2, row = new Array<number>(SET_ITEMS).fill(0);
  let extra = Math.max(ih - 16, 0);
  const take = (n: number): number => { const v = Math.min(extra, n); extra -= v; return v; };
  const padBottom = take(1), gapRadio = take(1), gapEv = take(1), gapRule = take(1), padTop = take(2), gapPref = take(2);
  let r = padTop;
  const head = r++;
  for (let i = SET_LOGINS; i <= SET_ANNOUNCE; i++) row[i] = r++;
  r += gapEv;
  row[SET_MUTE] = r++; if (gapPref > 0) r++;
  row[SET_TYPING] = r++; if (gapPref > 1) r++;
  row[SET_STAMPS] = r++;
  r += gapRule;
  const rule = r++, status = r++;
  r += gapRadio;
  for (let i = SET_ONLINE; i <= SET_DND; i++) row[i] = r++;
  row[SET_CLOSE] = ih - 1 - padBottom;
  return { h, w, row, head, rule, status };
}

function drawSettings(c: Cells, m: Model, d: DrawState, o: OverlayState): void {
  const p = m.pal, L = settingsLayout(c.cols, c.rows), { h, w, row } = L;
  c.pen(p.ink, DEFAULT, 0);
  let { top, left } = modal(c, d, h, w, p.accent, 'Settings', p.ink);
  d.hits.add(HIT_SETTINGS, top, left, h, w);
  o.setItemAt.fill(-1);
  top++; left++;
  const l = left + 2;
  c.pen(p.accent, DEFAULT, 0);
  c.text(top + L.head, l, 'BBS Events:', w - 6);
  for (let i = 0; i < SET_ITEMS; i++) {
    const x = i <= SET_ANNOUNCE ? l + 2 : l, sel = o.settingsSel === i;
    if (i === SET_CLOSE) {
      const bx = left + ((w - 2 - 12) / 2 | 0);
      c.pen(p.ink, sel ? p.accent : p.tone(TK_BASE + T_BAR), 0);
      c.fill(top + row[i], bx, 1, 12, 0x20);
      c.text(top + row[i], bx, SETTINGS_LABELS[i], 12);
    } else {
      const t = i <= SET_STAMPS ? `[${o.settingsVal[i] ? 'X' : ' '}] ${SETTINGS_LABELS[i]}`
        : `(${o.settingsStatus === i - SET_ONLINE ? 'O' : ' '}) ${SETTINGS_LABELS[i]}`;
      c.pen(p.ink, sel ? p.labelBg : DEFAULT, 0);
      c.text(top + row[i], x, t, w - 2 - (x - left));
    }
    if (row[i] >= 0 && row[i] < 64) o.setItemAt[row[i]] = i;
  }
  c.pen(p.dim, DEFAULT, 0);
  c.fill(top + L.rule, l, 1, w - 6, 0x2d);
  c.pen(p.accent, DEFAULT, 0);
  c.text(top + L.status, l, 'Status:', 20);
  d.hits.add(HIT_SETTINGS_ROW, top, left, h - 2, w - 2);
  c.pen(p.ink, DEFAULT, 0);
}

export const PICK_CATS = ['Emotions', 'Actions', 'Symbols', 'Special'];
const PICK_H = 14;
/** The C lc_hit numbers of the picker rects. */
export const HIT_FMT = 13, HIT_FMT_CAT = 14, HIT_FMT_ITEM = 15, HIT_FMT_CLOSE = 16;
export const pickRows = (): number => PICK_H - 4;
export const pickList = (o: OverlayState): { code: string; face: string }[] => o.pickItems.filter((e) => e.cat === o.pickCat);

/** lc_fmt_move: Up/Down walk the focused pane; a new category starts at the top. */
export function pickMove(o: OverlayState, delta: number): void {
  if (o.pickPane === 0) {
    const k = Math.max(0, Math.min(PICK_CATS.length - 1, o.pickCat + delta));
    if (k !== o.pickCat) { o.pickCat = k; o.pickItem = o.pickTop = 0; }
    return;
  }
  const k = Math.max(0, Math.min(pickList(o).length - 1, o.pickItem + delta));
  o.pickItem = k;
  if (k < o.pickTop) o.pickTop = k;
  if (k >= o.pickTop + pickRows()) o.pickTop = k - pickRows() + 1;
}

/** draw_fmt for the emoji picker: bottom right above the input, categories left, items right (face in a 16 column, then the code). */
function drawPicker(c: Cells, m: Model, d: DrawState, o: OverlayState): void {
  const p = m.pal, W = c.cols, H = PICK_H, rows = pickRows();
  const w = Math.min(52, Math.max(20, W - 2)), y = c.rows - 7;
  let top = y - H - 1;
  if (top < 0) top = y + 1;
  const left = Math.max(0, W - w), catw = Math.max(8, Math.min(14, w - 24)), ix = left + 1 + catw, iw = w - 2 - catw;
  const items = pickList(o);
  c.pen(p.ink, DEFAULT, 0);
  c.fill(top + 1, left + 1, H - 2, w - 2, 0x20);
  c.box(top, left, H, w, p.accent, ' Emoji Picker [Tab | Enter] ', p.ink);
  cover(d, top, left, H, w);
  c.box(top + 1, left + 1, H - 4, catw, p.ok, ' Category ', p.ink);
  PICK_CATS.forEach((n, i) => {
    const sel = i === o.pickCat;
    c.pen(sel ? p.barInk : p.ink, sel ? p.ok : DEFAULT, 0);
    c.fill(top + 2 + i, left + 2, 1, catw - 2, 0x20);
    c.text(top + 2 + i, left + 3, n, catw - 3);
  });
  c.pen(p.ink, DEFAULT, 0);
  c.box(top + 1, ix, H - 2, iw, p.accent, ` ${PICK_CATS[o.pickCat]} `, p.ink);
  for (let i = 0; i < rows && o.pickTop + i < items.length; i++) {
    const k = o.pickTop + i;
    c.pen(k === o.pickItem ? p.barInk : p.ink, k === o.pickItem ? p.accent : DEFAULT, 0);
    c.fill(top + 2 + i, ix + 1, 1, iw - 2, 0x20);
    const e = items[k];
    c.text(top + 2 + i, ix + 2, iw - 3 <= 16 ? e.face : e.face.padEnd(16) + e.code, iw - 3);
  }
  d.hits.add(HIT_FMT, top, left, H, w);
  d.hits.add(HIT_FMT_CAT, top + 2, left + 2, PICK_CATS.length, catw - 2);
  d.hits.add(HIT_FMT_ITEM, top + 2, ix + 1, Math.min(rows, items.length - o.pickTop), iw - 2);
  d.hits.add(HIT_FMT_CLOSE, top + 1, left + w - 5, 1, 3);
  c.pen(p.alert, DEFAULT, 0);
  c.text(top + 1, left + w - 5, '[X]', 3);
  c.pen(p.ink, DEFAULT, 0);
}

/** The overlays lc_draw paints last, in the C order (help, view, search, settings, modal). */
export function drawOverlays(c: Cells, m: Model, d: DrawState, o: OverlayState, caret: { cr: number; cc: number }): void {
  if (o.help) drawText(c, m, d, 'Help', HELP_TEXT, o.helpTop, false);
  if (o.view) drawText(c, m, d, o.viewTitle, o.viewText, o.viewTop, true);
  if (o.search) drawSearch(c, m, d, o, caret);
  if (o.settings) drawSettings(c, m, d, o);
  if (o.modal !== MODAL_NONE) drawModal(c, m, d, o, caret);
  if (o.fmt) drawPicker(c, m, d, o);
}
