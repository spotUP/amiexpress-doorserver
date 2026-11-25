/**
 * The /draw canvas on Partyline (livechat.c dr_* / draw_key / draw_mouse): an art room opens it,
 * a stroke reaches the other caller through the hub's canvas store and event, undo takes it
 * back on both screens, and Esc brings the chat screen back as a full repaint.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, ensureDefaultRoom } from '../src/chat/store';
import { chatScreen } from '../src/partyline/ui/screen';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('Partyline /draw canvas', () => {
  let fx: AchievementsFixture;
  let a: HubScreen;
  let b: HubScreen;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const open = (handle: string, sysop: boolean): HubScreen => {
      const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle, sysop, client: 'test' }).sid);
      const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
      return chatScreen(fx.ach, chat)({ sid, user: handle, boardId: fx.boardId, hello, markDirty: () => {}, quit: () => {} }) as HubScreen;
    };
    a = open('bob', true);
    b = open('alice', false);
    a.run(true, (db, ctx) => { createRoom(db, ctx, { name: 'general' }); createRoom(db, ctx, { name: 'paint', kind: 'art' }); });
  });
  afterEach(() => { a.close(); b.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const type = (s: HubScreen, line: string): void => { s.input(Buffer.from(`${line}\r`, 'latin1')); s.take(); };
  const keys = (s: HubScreen, k: string): void => { s.input(Buffer.from(k, 'latin1')); };
  const screenText = (s: HubScreen, full: boolean): string => s.render(full).toString('latin1');

  it('/draw in an art room opens the canvas with its status bar', () => {
    type(a, '/join #general');
    type(a, '/draw');
    expect(a.canvas.on).toBe(false);
    type(a, '/draw #paint');
    expect(a.model.room).toBe('paint');
    expect(a.canvas.on).toBe(true);
    keys(a, '\x1b'); // Esc leaves; /draw in the art room opens it again
    type(a, '/draw');
    expect(a.canvas.on).toBe(true);
    expect(screenText(a, true)).toContain('Draw | pen # fg 15 bg 0 | 0,0 | Space paint, T tools, H pen, Esc back');
  });

  it('a stroke from one caller reaches the other, and undo takes it back on both', () => {
    type(a, '/join #paint');
    type(b, '/join #paint');
    keys(a, ' '); // Space paints the pen at 0,0 and posts it
    b.take();
    expect(b.canvas.grid[0][0]).toMatchObject({ char: '#', fg: 15, bg: 0 });
    // a mouse drag: press at column 5 row 2, motion to column 7, release
    keys(a, '\x1b[<0;6;3M'); keys(a, '\x1b[<32;7;3M'); keys(a, '\x1b[<32;8;3M'); keys(a, '\x1b[<0;8;3m');
    b.take();
    expect([5, 6, 7].map((x) => b.canvas.grid[2][x].char).join('')).toBe('###');
    expect(screenText(b, true)).toContain('###');
    keys(a, 'u'); // undo the drag
    b.take();
    expect(a.canvas.grid[2][5].char).toBe(' ');
    expect(b.canvas.grid[2][6].char).toBe(' ');
    expect(b.canvas.grid[0][0].char).toBe('#');
    keys(a, 'r'); // redo
    b.take();
    expect(b.canvas.grid[2][7].char).toBe('#');
    keys(b, 'x'); // clear is the room owner's or an op's
    expect(b.canvas.note).toMatch(/^Not sent: /);
    keys(a, 'x');
    b.take();
    expect(b.canvas.grid[0][0].char).toBe(' ');
  });

  it('the tool popup picks a box, and a late joiner gets the snapshot', () => {
    type(a, '/join #paint');
    keys(a, 't');
    expect(screenText(a, true)).toContain('Filled Box');
    keys(a, '\x1b[B\x1b[B\r'); // Draw -> Line -> Box
    keys(a, ' \x1b[C\x1b[C\x1b[B\x1b[B '); // corners 0,0 and 2,2
    type(b, '/join #paint');
    expect([0, 1, 2].map((y) => [0, 1, 2].map((x) => b.canvas.grid[y][x].char).join(''))).toEqual(['###', '# #', '###']);
  });

  it('Esc returns to the chat screen with a full repaint', () => {
    type(a, '/join #paint');
    screenText(a, true);
    keys(a, '\x1b');
    expect(a.canvas.on).toBe(false);
    expect(a.cells.full).toBe(true);
    const out = screenText(a, false);
    // Cells writes every cell on a full frame (no clear needed): row 1 and the status row come back, the canvas bar is gone
    expect(out).toContain('\x1b[1H');
    expect(out).toContain('\x1b[25H');
    expect(out).not.toContain('Space paint');
    expect(out).toContain('Joined #paint');
  });

  it('a resumed session lands in the room and mode it was on, not the first membership (hub restart)', () => {
    const chat = loadChatConfig();
    const reopen = (s: HubScreen): HubScreen => {
      s.close();
      const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
      // A new screen on the same sid is what a resume onto a restarted hub builds.
      return chatScreen(fx.ach, chat)({ sid: s.info.sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => {}, quit: () => {} }) as HubScreen;
    };
    type(a, '/join #paint');
    type(a, '/join #general');
    a = reopen(a);
    expect(a.model.room).toBe('general'); // was 'paint', the first membership by name, with its canvas open
    expect(a.canvas.on).toBe(false);
    type(a, '/join #paint');
    keys(a, '\x1b'); // chat view of the art room
    a = reopen(a);
    expect(a.model.room).toBe('paint');
    expect(a.canvas.on).toBe(false);
    type(a, '/draw');
    a = reopen(a);
    expect(a.canvas.on).toBe(true);
    keys(a, '\x1b'); // Esc closes the canvas inside DrawCanvas.key: the close must be stored too
    a = reopen(a);
    expect(a.canvas.on).toBe(false);
    type(a, '/draw');
    type(a, '/leave');
    a = reopen(a);
    expect(a.model.room).toBe('general'); // a left room is not rejoined
  });

  it('a fresh entry opens the default channel like LC, not the first membership or the last session (#artroom canvas)', () => {
    const chat = loadChatConfig();
    a.run(true, (db) => ensureDefaultRoom(db)); // the shared #lobby a seeded hub always has
    type(a, '/join #paint');
    type(a, '/draw');
    a.close();
    // Quit then PL again: a new chat session, no resume token.
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    a = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => {}, quit: () => {} }) as HubScreen;
    expect(a.model.room).toBe('lobby');
    expect(a.canvas.on).toBe(false);
  });
});
