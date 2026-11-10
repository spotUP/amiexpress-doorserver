/**
 * Renders a FILE_ID.DIZ (or any BBS-era ANSI text) to HTML.
 *
 * Real FILE_ID.DIZ files don't just carry SGR colour codes — cursor
 * movement (CUF/CUB/CUU/CUD), absolute positioning (CUP), and erase
 * (ED/EL) are routinely used to align columns and to overwrite a line
 * with a second colour pass (classic two-tone BBS ad effect). A
 * straight ansi_to_html pass drops all of that silently, collapsing
 * the intended spacing. This is a small VT-lite interpreter: it plays
 * the escape sequences into a 2-D cell grid (like a real terminal
 * would) and then serialises the grid to HTML, so cursor-positioned
 * text lands where it was meant to.
 *
 * Bytes 0x01-0x1F (other than ESC/CR/LF/TAB) are printable CP437
 * "control picture" glyphs in this format (smileys, card suits, ...),
 * not control actions — they're placed in the grid like any other
 * character, not stripped.
 */

interface Cell {
  ch: string;
  cls: string[];
  href: string | null;
}

const COLOR_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

// Defensive bounds on untrusted archive content — real DIZs are a few
// dozen columns by up to ~20 rows; this just stops a pathological CUP/CUF
// jump from allocating an enormous grid.
const MAX_ROWS = 400;
const MAX_COLS = 300;
const MAX_JUMP = 1000;

interface StyleState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: boolean;
}

function freshStyle(): StyleState {
  return { fg: null, bg: null, bold: false, faint: false, italic: false, underline: false };
}

function classesFor(s: StyleState): string[] {
  const cls: string[] = [];
  if (s.fg) cls.push(s.fg);
  if (s.bg) cls.push(s.bg);
  if (s.bold) cls.push('ansi-bold');
  if (s.faint) cls.push('ansi-faint');
  if (s.italic) cls.push('ansi-italic');
  if (s.underline) cls.push('ansi-underline');
  return cls;
}

function applySgr(s: StyleState, params: number[]): void {
  const codes = params.length > 0 ? params : [0];
  for (const code of codes) {
    if (code === 0) Object.assign(s, freshStyle());
    else if (code === 1) s.bold = true;
    else if (code === 2) s.faint = true;
    else if (code === 3) s.italic = true;
    else if (code === 4) s.underline = true;
    else if (code === 22) { s.bold = false; s.faint = false; }
    else if (code === 23) s.italic = false;
    else if (code === 24) s.underline = false;
    else if (code === 39) s.fg = null;
    else if (code === 49) s.bg = null;
    else if (code >= 30 && code <= 37) s.fg = `ansi-${COLOR_NAMES[code - 30]}-fg`;
    else if (code >= 40 && code <= 47) s.bg = `ansi-${COLOR_NAMES[code - 40]}-bg`;
    else if (code >= 90 && code <= 97) s.fg = `ansi-bright-${COLOR_NAMES[code - 90]}-fg`;
    else if (code >= 100 && code <= 107) s.bg = `ansi-bright-${COLOR_NAMES[code - 100]}-bg`;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

class Grid {
  rows: Cell[][] = [];
  row = 0;
  col = 0;

  private ensure(row: number, col: number): void {
    if (row < 0 || col < 0) return;
    while (this.rows.length <= row && this.rows.length < MAX_ROWS) this.rows.push([]);
    const r = this.rows[Math.min(row, MAX_ROWS - 1)];
    if (!r) return;
    while (r.length <= col && r.length < MAX_COLS) r.push({ ch: ' ', cls: [], href: null });
  }

  put(ch: string, cls: string[], href: string | null): void {
    const row = Math.min(this.row, MAX_ROWS - 1);
    const col = Math.min(this.col, MAX_COLS - 1);
    this.ensure(row, col);
    const r = this.rows[row];
    if (r && col < r.length) r[col] = { ch, cls, href };
    this.col++;
  }

  clampJump(n: number): number {
    return Math.max(0, Math.min(n, MAX_JUMP));
  }

  eraseDisplay(mode: number): void {
    const cmp = (r: number, c: number) => r * MAX_COLS + c;
    const here = cmp(this.row, this.col);
    for (let r = 0; r < this.rows.length; r++) {
      const line = this.rows[r];
      for (let c = 0; c < line.length; c++) {
        const at = cmp(r, c);
        const inRange = mode === 2 || (mode === 0 && at >= here) || (mode === 1 && at <= here);
        if (inRange) line[c] = { ch: ' ', cls: [], href: null };
      }
    }
  }

  eraseLine(mode: number): void {
    const line = this.rows[Math.min(this.row, MAX_ROWS - 1)];
    if (!line) return;
    for (let c = 0; c < line.length; c++) {
      const inRange = mode === 2 || (mode === 0 && c >= this.col) || (mode === 1 && c <= this.col);
      if (inRange) line[c] = { ch: ' ', cls: [], href: null };
    }
  }
}

const CSI_RE = /^\x1b\[([0-9;?]*)([A-Za-z])/;
const OSC_HYPERLINK_RE = /^\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)/;
const OSC_OTHER_RE = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/;

export function renderAnsiDiz(rawText: string): string {
  // DOS EOF (Ctrl-Z, 0x1A) marks the end of the displayed text; a SAUCE
  // metadata record (artist/date/font, "SAUCE00...") commonly follows it
  // and must never be rendered as content.
  const eof = rawText.indexOf('\x1a');
  const text = eof === -1 ? rawText : rawText.slice(0, eof);
  const grid = new Grid();
  let style = freshStyle();
  let href: string | null = null;

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '\x1b') {
      const rest = text.slice(i);
      const csi = rest.match(CSI_RE);
      if (csi) {
        const params = csi[1].split(';').filter((p) => p !== '').map(Number);
        const final = csi[2];
        const n = grid.clampJump(params[0] || 1);
        switch (final) {
          case 'A': grid.row = Math.max(0, grid.row - n); break;
          case 'B': grid.row = Math.min(grid.row + n, MAX_ROWS - 1); break;
          case 'C': grid.col = Math.min(grid.col + n, MAX_COLS - 1); break;
          case 'D': grid.col = Math.max(0, grid.col - n); break;
          case 'H':
          case 'f':
            grid.row = Math.max(0, Math.min((params[0] || 1) - 1, MAX_ROWS - 1));
            grid.col = Math.max(0, Math.min((params[1] || 1) - 1, MAX_COLS - 1));
            break;
          case 'J': grid.eraseDisplay(params[0] || 0); break;
          case 'K': grid.eraseLine(params[0] || 0); break;
          case 'm': applySgr(style, params); break;
          default: break; // recognised-but-unhandled CSI (mode sets, etc.) — no-op
        }
        i += csi[0].length;
        continue;
      }
      const oscLink = rest.match(OSC_HYPERLINK_RE);
      if (oscLink) {
        href = oscLink[1] || null;
        i += oscLink[0].length;
        continue;
      }
      const oscOther = rest.match(OSC_OTHER_RE);
      if (oscOther) {
        i += oscOther[0].length;
        continue;
      }
      // Unrecognised escape: drop just the ESC byte, let whatever follows
      // print normally (matches how real terminals fail gracefully).
      i += 1;
      continue;
    }

    if (ch === '\r') { grid.col = 0; i += 1; continue; }
    if (ch === '\n') { grid.row = Math.min(grid.row + 1, MAX_ROWS - 1); grid.col = 0; i += 1; continue; }
    if (ch === '\t') { grid.col = Math.min((Math.floor(grid.col / 8) + 1) * 8, MAX_COLS - 1); i += 1; continue; }

    grid.put(ch, classesFor(style), href);
    i += 1;
  }

  const lines: string[] = [];
  for (const row of grid.rows) {
    let html = '';
    let j = 0;
    while (j < row.length) {
      const cell = row[j];
      let k = j + 1;
      while (
        k < row.length &&
        row[k].href === cell.href &&
        row[k].cls.join(' ') === cell.cls.join(' ')
      ) k++;
      const runText = escapeHtml(row.slice(j, k).map((c) => c.ch).join(''));
      let chunk = runText;
      if (cell.cls.length > 0) chunk = `<span class="${cell.cls.join(' ')}">${chunk}</span>`;
      if (cell.href) chunk = `<a href="${escapeAttr(cell.href)}" target="_blank" rel="noreferrer" class="ansi-diz-link">${chunk}</a>`;
      html += chunk;
      j = k;
    }
    lines.push(html);
  }
  return lines.join('\n');
}
