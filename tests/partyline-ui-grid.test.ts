/**
 * Port of amiexpress-web sdk/c/tests/test_livechat_ui.c compare(): the hub engine draws the LIVECHAT68 main
 * screen cell for cell like the C door. Fixtures are the TS-door grids the C test reads (lc68-ts-main-*.grid).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Cells, BG_DEFAULT, BOLD, cellCh, cellFg, cellBg, cellFlags } from '../src/partyline/ui/cells';
import { Model, newLine, newSide, SYSTEM, ACTIVITY_LINE, HISTORY, LIVE, SIDE_HEAD, SIDE_ROOM, SIDE_USER, T_BAR } from '../src/partyline/ui/model';
import { draw, DrawState } from '../src/partyline/ui/draw';

export function mainState(cols: number, rows: number): Model {
  const m = new Model(cols, rows);
  m.focus = -1;
  m.handle = 'Guest'; m.room = 'general'; m.paneLabel = 'general - General chat';
  m.side.push(newSide(SIDE_HEAD, false, 'TEXT CHANNELS'), newSide(SIDE_ROOM, true, 'general'), newSide(SIDE_USER, false, 'carol'),
    newSide(SIDE_ROOM, false, 'amiga'), newSide(SIDE_ROOM, false, 'secret'));
  m.sideSel = 1;
  const add = (k: number, t: string, n: string, s: string): void => m.addLine(newLine(k, t, n, s));
  add(SYSTEM, '', '', 'Found 3 rooms');
  add(SYSTEM, '', '', 'Auto-joining #general...');
  add(SYSTEM, '', '', 'Joined #general (3 users)');
  add(ACTIVITY_LINE, '17:03', '', 'Joined #general');
  add(SYSTEM, '', '', '--- 2 earlier messages ---');
  add(HISTORY, '11:01', 'alice', 'hello world');
  add(HISTORY, '11:02', 'bob', 'this is a long line that should wrap around the chat pane width for sure yes indeed');
  add(LIVE, '17:03', 'alice', 'hi sysop, how are you?');
  add(LIVE, '17:03', 'bob', 'nice **bold** and :D');
  add(SYSTEM, '', '', 'carol joined the room');
  add(ACTIVITY_LINE, '17:03', '', 'carol joined');
  add(SYSTEM, '', '', 'bob left the room');
  add(ACTIVITY_LINE, '17:03', '', 'bob left');
  return m;
}

function compare(file: string): string[] {
  const lines = fs.readFileSync(file).toString('latin1').split('\n');
  const [cols, rows] = lines[0].split(' ').map(Number);
  const c = new Cells(cols, rows), m = mainState(cols, rows), p = m.pal;
  draw(c, m, new DrawState());
  const role = (old: number): number => {
    switch (old) {
      case 255: case 7: case 3: case 195: return p.ink;
      case 204: return p.accent;
      case 196: return p.alert;
      case 240: case 66: return p.dim;
      case 221: return p.activity;
      case 78: return p.ok;
      case 0: return p.barInk;
      case 4: case 16: return p.col[T_BAR];
      default: return old;
    }
  };
  const diffs: string[] = [];
  let row = -1;
  for (const line of lines.slice(1)) {
    if (line[0] === 'T') {
      row++;
      for (let k = 0; k < cols; k++) {
        if (row === rows - 1 && k === cols - 1) break;
        const end = 1 + k >= line.length, want = end ? 32 : line.charCodeAt(1 + k), got = cellCh(c.back[row * cols + k]);
        if (got !== want) diffs.push(`r${row} c${k} char want ${want} got ${got}`);
        if (end) break;
      }
    } else if (line[0] === 'A') {
      for (const run of line.slice(1).trim().split(/ +/)) {
        const mm = /^(\d+)-(\d+):(-?\d+)\/(-?\d+)\/(\d+)$/.exec(run);
        if (!mm) continue;
        const [a, b, fg, bg, bold] = mm.slice(1).map(Number);
        for (let k = a; k <= b && k < cols; k++) {
          const v = c.back[row * cols + k], fl = cellFlags(v);
          const gbg = fl & BG_DEFAULT ? -1 : cellBg(v), gbold = fl & BOLD ? 1 : 0, wf = role(fg), wb = role(bg);
          if (cellCh(v) === 32 && wb === gbg) continue;
          if (cellFg(v) !== wf || gbg !== wb || gbold !== bold) diffs.push(`r${row} c${k} attr want ${wf}/${wb}/${bold} got ${cellFg(v)}/${gbg}/${gbold}`);
        }
      }
    }
  }
  return diffs;
}

describe('partyline ui: LIVECHAT68 main screen grid', () => {
  for (const size of ['80x25', '80x15', '40x25']) {
    it(`matches lc68-ts-main-${size}.grid cell for cell`, () => {
      const diffs = compare(path.join(__dirname, 'fixtures/partyline', `lc68-ts-main-${size}.grid`));
      expect(diffs.slice(0, 8)).toEqual([]);
    });
  }
  it.skip('a /chat/v1 client drives the same grid (waits for P1 server/frames)', () => undefined);
});
