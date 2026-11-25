/**
 * Partyline hub engine: the LIVECHAT68 screen model, ported 1:1 from
 * amiexpress-web sdk/c/examples/livechat/livechat_ui.c (lc_model, theme, message formatting).
 *
 * Strings are latin1 JS strings (one char per byte), as the C door holds them. Marked strings use the
 * cells.ts markers (M_FG + colour byte, M_BOLD, M_PLAIN, M_BASE, M_ATTR + '@'|attr).
 *
 * Types here are local to ui/ until the P1 contract (contract/partyline-types.ts) lands; merge then.
 */
import { M_FG, M_BOLD, M_PLAIN, M_BASE, M_ATTR, A_UNDERLINE, A_ITALIC, A_REVERSE } from './cells';

// ---- theme tokens (ui_theme.h UI_T_*) ----
export const T_GROUND = 0, T_INK = 1, T_CHROME = 2, T_DIM = 3, T_BAR = 4, T_BAR_INK = 5, T_ACCENT = 6,
  T_ACCENT_ALT = 7, T_SELECTION_BG = 8, T_SELECTION_INK = 9, T_OK = 10, T_WARN = 11, T_ALERT = 12;
export const TOKEN_COUNT = 13;
/** ui_theme.c entry 0, Uprough Neon: the default (ui_theme_by_id("")). */
export const THEME_DEFAULT_RGB: readonly number[] = [0x000000, 0xe4ecfa, 0x4de0f0, 0x48566e, 0x000000, 0xff3d9a,
  0xff3d9a, 0xf5c451, 0xaa00aa, 0x000000, 0x57e389, 0xf5c451, 0xff5c7a];
/** ui_theme.c table (sdk/c/include/theme_tables.h, generated from sdk/engines/ui/theme/tokens.ts): id, name, blurb, rgb. */
export interface Theme { id: string; name: string; blurb: string; rgb: readonly number[] }
export const THEMES: readonly Theme[] = [
  { id: 'uprough-neon', name: 'Uprough Neon', blurb: 'Demoscene magenta and cyan, double-ruled, masthead slashes.', rgb: THEME_DEFAULT_RGB },
  { id: 'neon-muted', name: 'Uprough Neon (muted)', blurb: 'The neon frame, but the colour spent only where it counts.',
    rgb: [0x000000, 0xa8b4c8, 0x2e6e7a, 0x5a6474, 0x000000, 0xff3d9a, 0xff3d9a, 0x5a6474, 0xaa00aa, 0x000000, 0xa8b4c8, 0xa8b4c8, 0xff3d9a] },
  { id: 'slate-slash', name: 'Slate & Slash', blurb: 'Quiet slate chrome, one magenta accent, room to breathe.',
    rgb: [0x000000, 0xc9d4e8, 0x48566e, 0x48566e, 0x000000, 0xc9d4e8, 0xff3d9a, 0x4de0f0, 0xaa00aa, 0x000000, 0x57e389, 0xf5c451, 0xff5c7a] },
  { id: 'slate-muted', name: 'Slate & Slash (muted)', blurb: 'Near-monochrome. One accent, spent on the selection.',
    rgb: [0x000000, 0x95a0b4, 0x3a4354, 0x5a6474, 0x000000, 0xff3d9a, 0xff3d9a, 0x5a6474, 0xaa00aa, 0x000000, 0x95a0b4, 0x95a0b4, 0xff3d9a] },
  { id: 'quiet-phosphor', name: 'Quiet Phosphor', blurb: 'One phosphor hue, no borders, hierarchy by brightness alone.',
    rgb: [0x000000, 0x57e389, 0x2e4a3c, 0x2e4a3c, 0x000000, 0x57e389, 0x8cffb4, 0xf5c451, 0x00aa00, 0x000000, 0x57e389, 0xf5c451, 0xff8b6b] },
  { id: 'phosphor-muted', name: 'Quiet Phosphor (muted)', blurb: 'One hue and nothing else. Brightness alone carries the hierarchy.',
    rgb: [0x000000, 0x57e389, 0x1e3a28, 0x2e4a3c, 0x000000, 0x8cffb4, 0x8cffb4, 0x2e4a3c, 0x000000, 0xc8ffdc, 0x57e389, 0x8cffb4, 0xc8ffdc] },
];

export const TK_BASE = 1000;
export const TK_INK = TK_BASE + T_INK, TK_ACCENT = TK_BASE + T_ACCENT, TK_ACCENT_ALT = TK_BASE + T_ACCENT_ALT,
  TK_DIM = TK_BASE + T_DIM, TK_ALERT = TK_BASE + T_ALERT, TK_OK = TK_BASE + T_OK, TK_BAR = TK_BASE + T_BAR;
export const EV_RED = 1, EV_GREEN = 2, EV_YELLOW = 3, EV_LIGHTGREEN = 10;

/** One theme's 256-colour numbers per token (C lc_col). The C keeps one global; a hub keeps one per session. */
export class Palette {
  col = new Array<number>(TOKEN_COUNT).fill(0);
  constructor(rgb: readonly number[] = THEME_DEFAULT_RGB) { this.set(rgb); }
  set(rgb: readonly number[]): void { for (let t = 0; t < TOKEN_COUNT; t++) this.col[t] = rgbCube(rgb[t]); }
  tone(t: number): number { return t >= TK_BASE && t < TK_BASE + TOKEN_COUNT ? this.col[t - TK_BASE] : t; }
  get ink(): number { return this.col[T_INK]; }
  get accent(): number { return this.col[T_ACCENT]; }
  get borderFocus(): number { return this.col[T_INK]; }
  get alert(): number { return this.col[T_ALERT]; }
  get dim(): number { return this.col[T_DIM]; }
  get activity(): number { return this.col[T_ACCENT_ALT]; }
  get ok(): number { return this.col[T_OK]; }
  get warn(): number { return this.col[T_WARN]; }
  get barInk(): number { return this.col[T_GROUND]; }
  get grey(): number { return this.col[T_INK]; }
  get labelBg(): number { return this.col[T_BAR]; }
  get labelTail(): number { return this.col[T_INK]; }
  get scrollTrack(): number { return this.col[T_DIM]; }
  get scrollThumb(): number { return this.col[T_INK]; }
}

const SYS16 = [0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5,
  0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff];
function palette256(i: number): number {
  if (i < 16) return SYS16[i];
  if (i < 232) {
    i -= 16;
    const r = Math.floor(i / 36), g = Math.floor(i / 6) % 6, b = i % 6;
    return ((r ? r * 40 + 55 : 0) << 16) | ((g ? g * 40 + 55 : 0) << 8) | (b ? b * 40 + 55 : 0);
  }
  const l = (i - 232) * 10 + 8;
  return (l << 16) | (l << 8) | l;
}
/** 0xRRGGBB to the nearest xterm colour: weighted 30/59/11, first nearest wins, exact hit stops. */
export function rgbCube(rgb: number): number {
  let best = Infinity, li = 0;
  for (let i = 0; i < 256; i++) {
    const p = palette256(i);
    const dr = 30 * (((rgb >> 16) & 255) - ((p >> 16) & 255));
    const dg = 59 * (((rgb >> 8) & 255) - ((p >> 8) & 255));
    const db = 11 * ((rgb & 255) - (p & 255));
    const d = dr * dr + dg * dg + db * db;
    if (d === 0) return i;
    if (d < best) { best = d; li = i; }
  }
  return li;
}

// ---- model ----
export const SYSTEM = 0, ACTIVITY_LINE = 1, HISTORY = 2, LIVE = 3, NOTE = 4, EVENT = 5, PICTURE = 6;
export const SIDE_HEAD = 0, SIDE_ROOM = 1, SIDE_USER = 2, SIDE_DM = 3, SIDE_BLANK = 4;
export const FOCUS_INPUT = 0, FOCUS_SIDEBAR = 1, FOCUS_MENU = 2;
export const LINES_MAX = 80;
export const TEXT_MAX = 640;

export interface React { emoji: string; count: number }
export interface Line {
  kind: number; time: string; nick: string; label: string; text: string; quote: string; head: string;
  id: string; number: number; tone: number; bodyTone: number; pb: boolean; edited: boolean; react: React[];
}
export interface Side {
  kind: number; label: string; shown: string; note: string; joined: boolean; open: boolean; art: boolean;
  unread: number; status: number;
  /** The room a SIDE_ROOM row stands for (a click joins it). */
  id?: string;
}
export interface Typing { nick: string; text: string }

export function newLine(kind: number, time = '', nick = '', text = ''): Line {
  return { kind, time, nick, label: '', text, quote: '', head: '', id: '', number: 0, tone: 0, bodyTone: 0,
    pb: false, edited: false, react: [] };
}
export function newSide(kind: number, joined: boolean, label: string): Side {
  return { kind, label, shown: '', note: '', joined, open: kind === SIDE_ROOM && joined, art: false, unread: 0, status: 0 };
}

let linesClock = 0;
export class Model {
  pal = new Palette();
  cols: number; rows: number;
  handle = ''; room = ''; paneLabel = ''; node = 1;
  focus = FOCUS_INPUT; menu = -1; menuSel = 0;
  lines: Line[] = []; linesGen = 0;
  /** LIVECHAT's animation frame (createAnimationManager fps 10): the screen tick advances it while an effect is on screen. */
  fxFrame = 0;
  side: Side[] = []; sideSel = 0; sidebarHidden = false;
  typing: Typing[] = []; typingTime = ''; typingBlink = false;
  input = ''; inputCur = 0; inputAnchor = -1; editing = false; pick = '';
  /** The open right-click menu (LIVECHAT context-menus.ts): its rows, where it opens, the selected row; null when shut. */
  popup: { items: string[]; row: number; col: number; sel: number } | null = null;
  scroll = 0; timestamps = true; compact = false;
  /** lc_set_self: the caller's nick for @mention highlight (C keeps it global). */
  selfNick = '';
  customEmoji: Array<{ name: string; ascii: string }> = [];
  constructor(cols: number, rows: number) { this.cols = cols; this.rows = rows; this.linesChanged(); }
  /** Any line change: the draw's wrap cache keys on linesGen (a clock shared by all models, as in C). */
  linesChanged(): void { this.linesGen = ++linesClock; }
  addLine(l: Line): void {
    if (this.lines.length === LINES_MAX) this.lines.shift();
    this.lines.push(l);
    this.linesChanged();
  }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; this.scroll = 0; this.linesChanged(); }
  setSelf(handle: string): void { const at = handle.indexOf('@'); this.selfNick = (at >= 0 ? handle.slice(0, at) : handle).slice(0, 31); }
  /** Events carry the full handle (bob@BOARD); the screen knows only the nick. */
  isSelf(user: string): boolean { const at = user.indexOf('@'); return sameWord(at >= 0 ? user.slice(0, at) : user, this.selfNick); }
  sidebarWidth(): number {
    if (this.sidebarHidden || this.cols <= 40) return 0;
    const w = Math.min(this.cols - 24, 21);
    return w < 8 ? 0 : w;
  }
  textRows(): number { return Math.max(1, this.rows - 8); }
  pickIndex(): number {
    if (this.pick === '') return -1;
    return this.lines.findIndex((l) => pickable(l) && l.id === this.pick);
  }
  pickStart(): boolean {
    for (let i = this.lines.length - 1; i >= 0; i--) if (pickable(this.lines[i])) { this.pick = this.lines[i].id; return true; }
    this.pick = '';
    return false;
  }
  pickMove(dir: number): void {
    let i = this.pickIndex();
    if (i < 0) return;
    for (i += dir; i >= 0 && i < this.lines.length; i += dir) if (pickable(this.lines[i])) { this.pick = this.lines[i].id; return; }
  }
  pickStop(): void { this.pick = ''; this.scroll = 0; }
}
const pickable = (l: Line): boolean => l.number !== 0 && l.id !== '';

export function nickColor(nick: string): number {
  let sum = 0;
  for (let i = 0; i < nick.length; i++) sum += nick.charCodeAt(i) & 255;
  return (sum % 6) + 1;
}

// ---- string builder with the C buffer cap ----
class Sb {
  s = '';
  constructor(readonly cap: number, readonly pal: Palette) {}
  ch(c: number): void { if (this.s.length + 1 < this.cap) this.s += String.fromCharCode(c); }
  run(t: string): void { const room = Math.max(0, this.cap - 1 - this.s.length); this.s += t.length > room ? t.slice(0, room) : t; }
  fg(c: number): void { this.ch(M_FG); this.ch(this.pal.tone(c)); }
}
interface Style { fg: number; bold: number; attr: number }
function styleSet(b: Sb, have: Style, want: Style): void {
  if (want.fg !== have.fg) {
    if (want.fg >= 0) b.fg(want.fg);
    else { b.ch(M_BASE); have.bold = 0; have.attr = 0; }
    have.fg = want.fg;
  }
  if (want.bold !== have.bold) { b.ch(want.bold ? M_BOLD : M_PLAIN); have.bold = want.bold; }
  if (want.attr !== have.attr) { b.ch(M_ATTR); b.ch(0x40 | want.attr); have.attr = want.attr; }
}

// ---- emoji ----
export const EMOJI: ReadonlyArray<readonly [string, string]> = [
  [':smile:', ':-)'], [':grin:', ':D'], [':joy:', 'XD'], [':wink:', ';-)'], [':heart:', '<3'], [':sad:', ':-('],
  [':cry:', ":'-("], [':shock:', ':O'], [':angry:', '>:-('], [':cool:', 'B-)'], [':tongue:', ':P'], [':kiss:', ':-*'],
  [':blush:', ':-}'], [':confused:', ':-/'], [':neutral:', ':-|'], [':surprised:', ':o'], [':evil:', '>:-)'],
  [':angel:', 'O:-)'], [':tableflip:', '(>_<)~~ |[__]|'], [':unflip:', '|---| (-_-)'], [':shrug:', '\\(o.O)/'],
  [':fight:', '(>_<)*'], [':dance:', '\\(^o^)/'], [':hug:', '(>^_^)<'], [':run:', '(>_>)===>'], [':wave:', '(^.^)/'],
  [':facepalm:', '(>_<;)'], [':thumbsup:', '(Y)'], [':thumbsdown:', '(N)'], [':fire:', '(*)'], [':star:', '*'],
  [':check:', '[v]'], [':x:', '[x]'], [':skull:', '8X'], [':music:', '~o~'], [':heart2:', '<3'], [':diamond:', '<>'],
  [':arrow:', '->'], [':warning:', '(!)'], [':lightning:', '/!\\'], [':amiga:', '[A]'], [':bbs:', '[BBS]'], [':door:', '[=>]'],
];
export const emojiBuiltin = (code: string): boolean => EMOJI.some(([c]) => c === code);
function expandEmoji(m: Model, s: string, cap: number): string {
  let out = '';
  let i = 0;
  outer: while (i < s.length && out.length + 1 < cap) {
    if (s[i] === ':') {
      for (const [code, text] of EMOJI) {
        if (s.startsWith(code, i) && out.length + text.length < cap) { out += text; i += code.length; continue outer; }
      }
      for (const e of m.customEmoji) {
        if (s.startsWith(e.name, i + 1) && s[i + 1 + e.name.length] === ':' && out.length + e.ascii.length < cap) {
          out += e.ascii; i += e.name.length + 2; continue outer;
        }
      }
    }
    out += s[i++];
  }
  return out;
}

// ---- colour names and tags ----
const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'];
function namedColor(s: string): number {
  let light = 0;
  if (s.length > 5 && s.startsWith('light')) { light = 8; s = s.slice(5); }
  const i = NAMES.indexOf(s);
  return i < 0 ? -1 : i === 8 ? (light ? 15 : 8) : i + light;
}
function hexColor(s: string): number {
  return /^#[0-9a-fA-F]{6}$/.test(s) ? rgbCube(parseInt(s.slice(1), 16)) : -1;
}
const FX: ReadonlyArray<readonly [string, number, number]> = [['rainbow', TK_ACCENT_ALT, 1], ['pulse', TK_ACCENT, 1],
  ['sparkle', TK_ACCENT_ALT, 1], ['shake', TK_ALERT, 1], ['wave', TK_INK, 1], ['gradient', TK_ACCENT, 0]];
function effectTag(pal: Palette, s: string, at: number): { n: number; closing: boolean; fg: number; bold: number; name: string } | null {
  let p = at + 1;
  const closing = s[p] === '/';
  if (closing) p++;
  const end = s.indexOf('~', p);
  if (end < 0) return null;
  for (const [name, fg, bold] of FX) {
    if (s.startsWith(name, p) && (p + name.length === end || (!closing && s[p + name.length] === ' ')))
      return { n: end - at + 1, closing, fg: pal.tone(fg), bold, name };
  }
  return null;
}
/** A log line that carries an animated effect: the screen tick repaints while one is shown. */
export const FX_ANIMATED = /~(rainbow|pulse|sparkle|wave|gradient)[~ ]/;
// LIVECHAT renderers.ts colours (RAINBOW_COLORS, SPARKLE_COLORS, the red-blue GRADIENT_RAMP) as xterm indexes.
const FX_RAINBOW = [9, 11, 10, 14, 12, 13], FX_SPARKLE = [15, 11, 15], FX_RAMP = [9, 13, 12];
/** renderers.ts per character: the colour of visible char i of n at a frame, -1 for the effect's own tone. */
function fxColor(name: string, frame: number, i: number, n: number, ch: string): { fg: number; bold: number } | null {
  switch (name) {
    case 'rainbow': return { fg: FX_RAINBOW[(i + frame) % FX_RAINBOW.length], bold: 0 };
    case 'pulse': return { fg: Math.sin(frame * 0.3) * 0.5 + 0.5 > 0.5 ? 14 : 8, bold: 0 };
    case 'sparkle': return ((frame * 7 + i * 13) % 100) / 100 < 0.15 && ch !== ' ' ? { fg: FX_SPARKLE[(frame + i) % FX_SPARKLE.length], bold: 1 } : { fg: -1, bold: 0 };
    case 'wave': { const w = Math.sin((frame + i) * 0.5); return w > 0.5 ? { fg: 14, bold: 0 } : w < -0.5 ? { fg: 12, bold: 0 } : { fg: -1, bold: 0 }; }
    case 'gradient': { const pos = n <= 1 ? 0 : ((i + frame % n) % n) / (n - 1); return { fg: FX_RAMP[Math.min(FX_RAMP.length - 1, Math.floor(pos * FX_RAMP.length))], bold: 0 }; }
    default: return null;   // shake: LIVECHAT only moves it a column; static here so the line never rewraps
  }
}
const hasCloser = (s: string, at: number, len: number, closer: string): boolean => s.indexOf(closer, at + len + 1) >= 0;

interface Fmt { bold: boolean; italic: boolean; under: boolean; strike: boolean; inv: boolean; tagFg: number; effFg: number; effBold: number; eff: string; effI: number; effN: number }
function fmtWant(pal: Palette, f: Fmt, want: Style): void {
  want.bold = f.bold || f.effBold ? 1 : 0;
  want.attr = (f.italic ? A_ITALIC : 0) | (f.under ? A_UNDERLINE : 0) | (f.inv ? A_REVERSE : 0);
  want.fg = f.strike ? pal.dim : f.tagFg >= 0 ? f.tagFg : f.effFg;
}
function sbSpot(b: Sb, have: Style, want: Style, fg: number, rev: boolean, t: string): void {
  const spot = { ...want, fg };
  if (rev) spot.attr |= A_REVERSE;
  styleSet(b, have, spot);
  b.run(t);
}
/** A {tag} at s[at]: its length when it changes the style or is consumed, 0 when the brace stays as typed. */
function braceTag(s: string, at: number, f: Fmt): { n: number; lit: string } {
  const e = s.indexOf('}', at);
  if (e < 0) return { n: 0, lit: '' };
  const closing = s[at + 1] === '/';
  const nm = s.slice(at + 1 + (closing ? 1 : 0), e);
  const nl = nm.length, n = e - at + 1;
  const none = { n: 0, lit: '' }, ok = { n, lit: '' };
  if (nl === 0) {
    if (closing) { f.bold = f.italic = f.under = f.strike = f.inv = false; f.tagFg = -1; return ok; }
    return none;
  }
  if (nm === 'bold') { f.bold = !closing; return ok; }
  if (nm === 'italic') { f.italic = !closing; return ok; }
  if (nm === 'underline') { f.under = !closing; return ok; }
  if (nm === 'inverse') { f.inv = !closing; return ok; }
  if (nm === 'blink' || nm === 'invisible') return ok;
  if (!closing && nm === 'open') return { n, lit: '{' };
  if (!closing && nm === 'close') return { n, lit: '}' };
  if (nl > 3 && nm[nl - 3] === '-' && (nm[nl - 2] === 'f' || nm[nl - 2] === 'b') && nm[nl - 1] === 'g') {
    let v = namedColor(nm.slice(0, nl - 3));
    if (v < 0) v = hexColor(nm.slice(0, nl - 3));
    if (v < 0) return none;
    if (nm[nl - 2] === 'f') f.tagFg = closing ? -1 : v;   // -bg: read and dropped
    return ok;
  }
  if (!closing && namedColor(nm) >= 0) {
    // C sprintf(closer, "{/%.*s}") into char[16]: a name of 12+ bytes would overflow; colour names never are.
    if (s.indexOf(`{/${nm}}`, e + 1) < 0) return none;
    f.tagFg = namedColor(nm);
    return ok;
  }
  if (closing && namedColor(nm) >= 0) { f.tagFg = -1; return ok; }
  if (!closing && nl > 3 && nm.startsWith('bg:') && namedColor(nm.slice(3)) >= 0 && s.indexOf('{/bg}', e + 1) >= 0) return ok;
  if (closing && nm === 'bg') return ok;
  return none;
}
const isWord = (c: string | undefined): boolean => c !== undefined && /^[0-9A-Za-z_]$/.test(c);
const sameWord = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const MARKS = '*_`~{@[:';

/**
 * Does this chat line @-mention the reader? Same word rule as the inline @name
 * spot in sbMarkdown; the reader's own lines never count. The log paints such a
 * line as one full-width warn bar (sysop 2026-11-18).
 */
export function mentionsSelf(m: Model, l: Line): boolean {
  if ((l.kind !== HISTORY && l.kind !== LIVE) || m.selfNick === '') return false;
  if (m.isSelf(l.nick)) return false;
  const t = l.text;
  for (let i = t.indexOf('@'); i >= 0; i = t.indexOf('@', i + 1)) {
    if (isWord(t[i - 1])) continue;
    let e = i + 1;
    while (isWord(t[e])) e++;
    if (e - i - 1 === m.selfNick.length && sameWord(t.slice(i + 1, e), m.selfNick)) return true;
  }
  return false;
}

/** sb_markdown: emoji codes, markdown, colour tags and effects, links, mentions. A marker with no partner stays as typed. */
function sbMarkdown(m: Model, b: Sb, text: string): void {
  const s = expandEmoji(m, text, TEXT_MAX * 2);
  const have: Style = { fg: -1, bold: 0, attr: 0 }, want: Style = { fg: -1, bold: 0, attr: 0 };
  const f: Fmt = { bold: false, italic: false, under: false, strike: false, inv: false, tagFg: -1, effFg: -1, effBold: 0, eff: '', effI: 0, effN: 0 };
  const pal = b.pal;
  let i = 0;
  while (i < s.length) {
    const run = i;
    while (i < s.length && !MARKS.includes(s[i])) i++;
    if (i > run && f.eff !== '' && f.tagFg < 0 && !f.strike) {
      // An effect paints per character and per frame, as LIVECHAT's renderers do; a colour tag or strike inside it wins.
      for (const ch of s.slice(run, i)) {
        const fx = fxColor(f.eff, m.fxFrame, f.effI++, f.effN, ch);
        styleSet(b, have, fx === null ? want : { ...want, fg: fx.fg >= 0 ? fx.fg : want.fg, bold: want.bold | fx.bold });
        b.run(ch);
      }
    }
    else if (i > run) { styleSet(b, have, want); b.run(s.slice(run, i)); }
    if (i >= s.length) break;
    const c0 = s[i], c1 = s[i + 1];
    let tag: ReturnType<typeof effectTag>;
    let brace: { n: number; lit: string };
    if (c0 === '*' && c1 === '*' && (f.bold || hasCloser(s, i, 2, '**'))) { f.bold = !f.bold; i += 2; }
    else if (c0 === '*' && c1 !== '*' && (f.italic || hasCloser(s, i, 1, '*'))) { f.italic = !f.italic; i++; }
    else if (c0 === '_' && c1 === '_' && (f.under || hasCloser(s, i, 2, '__'))) { f.under = !f.under; i += 2; }
    else if (c0 === '~' && c1 === '~' && (f.strike || hasCloser(s, i, 2, '~~'))) { f.strike = !f.strike; i += 2; }
    else if (c0 === '`' && c1 !== '`' && c1 !== undefined && s.indexOf('`', i + 1) >= 0) {
      const e = s.indexOf('`', i + 1);
      styleSet(b, have, { ...want, attr: want.attr | A_REVERSE });
      b.ch(32); b.run(s.slice(i + 1, e)); b.ch(32);
      i = e + 1;
      continue;
    }
    else if (c0 === '~' && (tag = effectTag(pal, s, i)) !== null) {
      f.effFg = tag.closing ? -1 : tag.fg;
      f.effBold = tag.closing ? 0 : tag.bold;
      f.eff = tag.closing ? '' : tag.name; f.effI = 0;
      const close = s.indexOf(`~/${tag.name}~`, i + tag.n);
      f.effN = tag.closing ? 0 : (close < 0 ? s.length : close) - i - tag.n;
      i += tag.n;
    }
    else if (c0 === '{' && (brace = braceTag(s, i, f)).n > 0) {
      if (brace.lit !== '') { styleSet(b, have, want); b.run(brace.lit); }
      i += brace.n;
    }
    else if (c0 === '@' && isWord(c1)) {
      let e = i + 1;
      while (isWord(s[e])) e++;
      const word = s.slice(i + 1, e);
      if (m.selfNick.length === word.length && sameWord(word, m.selfNick)) sbSpot(b, have, want, 3, true, s.slice(i, e));
      else if (sameWord(word, 'everyone') || sameWord(word, 'here')) sbSpot(b, have, want, pal.alert, false, s.slice(i, e));
      else sbSpot(b, have, want, pal.accent, false, s.slice(i, e));
      i = e;
      continue;
    }
    else if (c0 === '[' && linkEnd(s, i) > 0) {
      const rb = s.indexOf(']', i);
      sbSpot(b, have, want, pal.accent, false, s.slice(i, rb + 1));   // [text](url): the text kept, the url dropped
      i = s.indexOf(')', rb) + 1;
      continue;
    }
    else { styleSet(b, have, want); b.run(c0); i++; continue; }
    fmtWant(pal, f, want);
  }
  styleSet(b, have, { fg: -1, bold: 0, attr: 0 });
}
function linkEnd(s: string, i: number): number {
  const rb = s.indexOf(']', i);
  return rb >= 0 && s[rb + 1] === '(' && s.indexOf(')', rb) >= 0 && rb > i + 1 ? rb : 0;
}

// ---- reactions ----
export const REACT_NAMES = ['+1', '-1', 'heart', 'fire', 'laugh', 'wow', 'sad', 'angry'];
const REACT_GLYPHS = [':)', ':/', '<3', '*', ':D', ':O', ':(', '>('];
const REACT_WORDS = ['Thumbs Up', 'Thumbs Down', 'Heart', 'Fire', 'Laugh', 'Wow', 'Sad', 'Angry'];
export function reactDisplay(emoji: string): string { const i = REACT_NAMES.indexOf(emoji); return i < 0 ? emoji : REACT_GLYPHS[i]; }
export function reactLabel(i: number): string { return i < 0 || i >= REACT_NAMES.length ? '' : `${REACT_GLYPHS[i].padEnd(3)} ${REACT_WORDS[i]}`; }
export function reactRows(l: Line, indent: number, width: number, cap = 8 * 40): string {
  let out = '', col = 0, any = false;
  if (indent < 0) indent = 0;
  if (width > 0 && indent > Math.floor(width / 2)) indent = Math.floor(width / 2);
  for (const r of l.react) {
    if (r.count <= 0) continue;
    const one = `${reactDisplay(r.emoji).slice(0, 12)} ${r.count}`;
    const gap = any && !(width > 0 && col + 2 + one.length > width) ? 2 : 0;
    const need = gap === 0 ? 1 + indent + one.length : gap + one.length;
    if (out.length + need + 1 > cap) break;
    if (gap === 0) { out += '\n' + ' '.repeat(indent); col = indent; }
    else { out += '  '; col += 2; }
    out += one;
    col += one.length;
    any = true;
  }
  return out;
}

export const MARKED_CAP = TEXT_MAX * 2 + 96;
/** lc_line_marked: one log line as a marked string, the C buffer cap applied. */
export function lineMarked(m: Model, l: Line, stamps: boolean, width: number, cap = MARKED_CAP): string {
  const b = new Sb(cap, m.pal), pal = m.pal;
  let indent = stamps ? 8 : 0;
  const chat = l.kind === HISTORY || l.kind === LIVE;
  if (chat && l.quote !== '') { b.fg(pal.dim); b.run('  > '); b.run(l.quote); b.ch(10); b.ch(M_BASE); }
  const name = l.label !== '' ? l.label : l.nick;
  switch (l.kind) {
    case SYSTEM:
      b.fg(pal.dim); b.run('*** ');
      if (l.tone > 0) b.fg(l.tone);
      b.run(l.text);
      if (l.tone > 0) b.fg(pal.dim);
      if (l.text.startsWith('--- ')) b.ch(M_BASE);
      b.run(' ***');
      break;
    case PICTURE: b.ch(32); break;
    case NOTE: b.fg(l.tone > 0 ? l.tone : pal.accent); b.run(l.text); break;
    case ACTIVITY_LINE: b.fg(pal.activity); b.run('['); b.run(l.time); b.run('] '); b.run(l.text); break;
    case EVENT:
      if (l.time !== '') { b.fg(pal.accent); b.run('['); b.run(l.time); b.run(']'); b.ch(M_BASE); b.ch(32); }
      b.fg(l.tone); b.run(l.head); b.ch(M_BASE);
      if (l.bodyTone > 0) b.fg(l.bodyTone);
      b.run(l.text);
      if (l.pb) { b.ch(M_BASE); b.ch(32); b.fg(EV_LIGHTGREEN); b.run('[NEW PB!]'); }
      break;
    case HISTORY:
      if (stamps) { b.fg(pal.dim); b.run('['); b.run(l.time); b.run('] '); b.ch(M_BASE); }
      b.run('<'); b.fg(nickColor(l.nick)); b.run(name); b.ch(M_BASE); b.run('> ');
      sbMarkdown(m, b, l.text);
      break;
    default:
      if (stamps) { b.fg(pal.dim); b.run('['); b.run(l.time); b.run('] '); b.ch(M_BASE); }
      b.fg(nickColor(l.nick)); b.ch(M_BOLD); b.run(name); b.ch(M_BASE); b.run(': ');
      sbMarkdown(m, b, l.text);
      break;
  }
  if (chat && l.edited) { b.ch(M_BASE); b.fg(pal.dim); b.run(' (edited)'); }
  if (chat) {
    indent += name.length + (l.kind === HISTORY ? 3 : 2);
    const rows = reactRows(l, indent, width);
    if (rows !== '') { b.ch(M_BASE); b.fg(pal.accent); b.run(rows); }
  }
  return b.s;
}

/** typing_marked: [time] <nick> buffer, then the blink cursor. */
export function typingMarked(m: Model, t: Typing, cap = MARKED_CAP): string {
  const b = new Sb(cap, m.pal), color = nickColor(t.nick);
  b.fg(m.pal.dim); b.run('['); b.run(m.typingTime); b.run(']'); b.ch(M_BASE);
  b.run(' <'); b.fg(color); b.run(t.nick); b.ch(M_BASE);
  b.run('> '); b.run(t.text);
  if (m.typingBlink) { b.fg(color); b.ch(M_ATTR); b.ch(0x40 | A_REVERSE); b.ch(32); b.ch(M_BASE); }
  else b.ch(32);
  return b.s;
}
