/**
 * Port of amiexpress-web sdk/c/tests/test_livechat_ui.c compare(): the hub engine draws the LIVECHAT68 main
 * screen cell for cell like the C door. Fixtures are the TS-door grids the C test reads (lc68-ts-main-*.grid).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Cells, BG_DEFAULT, BOLD, cellCh, cellFg, cellBg, cellFlags } from '../src/partyline/ui/cells';
import { Model, newLine, newSide, SYSTEM, ACTIVITY_LINE, HISTORY, LIVE, SIDE_HEAD, SIDE_ROOM, SIDE_USER, T_BAR } from '../src/partyline/ui/model';
import { draw, DrawState } from '../src/partyline/ui/draw';
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { chatScreen } from '../src/partyline/ui/screen';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

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
});

/** A Partyline screen and a /chat/v1 client share one store: a line posted over HTTP lands on the screen grid. */
describe('partyline ui: /chat/v1 drives the hub screen', () => {
  let fx: AchievementsFixture;
  beforeEach(() => { fx = makeAchievementsFixture(); });
  afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

  const rowText = (c: Cells, r: number): string => {
    let s = '';
    for (let x = 0; x < c.cols; x++) s += String.fromCharCode(cellCh(c.back[r * c.cols + x]));
    return s;
  };
  const gridHas = (c: Cells, needle: string): boolean => {
    for (let r = 0; r < c.rows; r++) if (rowText(c, r).includes(needle)) return true;
    return false;
  };

  it('shows a message posted through POST /chat/v1/rooms/:id/messages', async () => {
    const call = (method: 'post', p: string, sid: string) => request(fx.app)[method](`/chat/v1${p}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);
    const web = (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle: 'alice', sysop: true })).body.sid as string;
    const room = (await call('post', '/rooms', web).send({ name: 'lobby' })).body.id as string;
    expect((await call('post', `/rooms/${room}/join`, web).send({})).status).toBe(200);

    const chat = loadChatConfig();
    const plSid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: false, client: 'test' }).sid);
    let dirty = 0;
    const hello = { cols: 80, rows: 25 } as ScreenInfo['hello'];
    const screen = chatScreen(fx.ach, chat)({ sid: plSid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => { dirty++; } }) as HubScreen;
    try {
      screen.render(true);
      expect(screen.model.room).toBe('lobby');
      expect(gridHas(screen.cells, 'Joined #lobby')).toBe(true);

      expect((await call('post', `/rooms/${room}/messages`, web).send({ content: 'hello from the web', clientId: 'w1' })).status).toBe(201);
      await new Promise<void>((r) => setImmediate(r));
      expect(dirty).toBeGreaterThan(0);
      const out = screen.render(false).toString('latin1');
      expect(out).toContain('hello from the web');
      expect(gridHas(screen.cells, 'hello from the web')).toBe(true);
      expect(gridHas(screen.cells, 'alice')).toBe(true);

      // And back: a line typed on the screen is a /chat/v1 message.
      screen.input(Buffer.from('hi from partyline\r', 'latin1'));
      await new Promise<void>((r) => setImmediate(r));
      screen.render(false);
      expect(gridHas(screen.cells, 'hi from partyline')).toBe(true);
    } finally {
      screen.close();
    }
  });
});
