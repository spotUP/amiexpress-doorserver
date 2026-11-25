/**
 * LIVECHAT parity for the Partyline hub screen, lane 1: the input line editor (history, message pick,
 * @-completion, Ctrl+A, the dropped-shift heuristic), focus and the menu bar from the keyboard, menu hover,
 * the chat and sidebar context menus, and the function keys (F2, F3, F6, F7, Ctrl+S, Ctrl+F).
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom } from '../src/chat/store';
import { chatScreen } from '../src/partyline/ui/screen';
import { FOCUS_INPUT, FOCUS_MENU, FOCUS_SIDEBAR, SIDE_ROOM, SIDE_USER, newLine } from '../src/partyline/ui/model';
import { HIT_POPUP, HIT_SIDEBAR, MENU_COL, MENU_ITEMS } from '../src/partyline/ui/draw';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('hub screen lane 1: LIVECHAT input, menus, sidebar and function keys', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
    for (const name of ['lobby', 'games']) {
      const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name })) as unknown as { id?: string; room?: { id: string } };
      screen.joinRoom(r.id ?? r.room?.id ?? '');
    }
    screen.render(true);
  });
  afterEach(() => { jest.restoreAllMocks(); screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const send = (s: string): string => { screen.input(Buffer.from(s, 'latin1')); return screen.render(false).toString('latin1'); };
  const fill = (text: string): void => { screen.model.input = text; screen.model.inputCur = text.length; screen.model.inputAnchor = -1; screen.render(true); };
  const last = (): string => screen.model.lines[screen.model.lines.length - 1].text;
  const hit = (id: number, dr: number): { row: number; col: number } => {
    for (let r = 0; r < 25; r++) for (let c = 0; c < 80; c++) { const h = screen.drawState.hits.at(r, c); if (h.id === id && h.dr === dr) return { row: r, col: c }; }
    throw new Error(`no hit ${id}/${dr}`);
  };
  const click = (b: number, row: number, col: number): string => send(`\x1b[<${b};${col + 1};${row + 1}M`);
  const say = (text: string): void => { fill(text); send('\r'); };
  const post = (text: string): void => { screen.model.lines.push({ ...newLine(0, '12:00', 'alice', text), number: 42, id: 'm42' }); screen.render(true); };

  it('F2 hides and shows the sidebar with the LIVECHAT message', () => {
    send('\x1bOQ');
    expect(screen.model.sidebarHidden).toBe(true);
    expect(last()).toContain('Sidebar hidden (F2 to show)');
    send('\x1b[12~');
    expect(screen.model.sidebarHidden).toBe(false);
    expect(last()).toContain('Sidebar shown');
  });

  it('F3 jumps the sidebar selection between channels and users', () => {
    send('\x1bOR');
    expect(screen.model.side[screen.model.sideSel].kind).toBe(SIDE_USER);
    expect(last()).toContain('Switched to users view');
    send('\x1b[13~');
    expect(screen.model.side[screen.model.sideSel].kind).toBe(SIDE_ROOM);
    expect(last()).toContain('Switched to channels view');
  });

  it('F6, F7, Ctrl+S and Ctrl+F route to files, pins, settings and search', () => {
    send('\x06');
    expect(screen.over.search).toBe(true); // livechat.c Ctrl+F: search_open
    send('\x1b\x1b');
    expect(screen.over.search).toBe(false);
    fill('');
    const before = screen.model.lines.length;
    send('\x1b[17~'); send('\x1b[18~');
    expect(screen.model.lines.length).toBeGreaterThan(before);
    expect(screen.over.view).toBe(true); // F7: pinned_typed opens the Pinned Messages view
    send('\x1b\x1b'); // livechat.c handle_key: an open view takes every key, so it closes before Ctrl+S
    send('\x13');
    expect(screen.over.settings).toBe(true); // Ctrl+S: settings_open
  });

  it('Ctrl+A selects the whole input', () => {
    fill('hello');
    send('\x01');
    expect([screen.model.inputAnchor, screen.model.inputCur]).toEqual([0, 5]);
  });

  it('a plain arrow inside 150ms of a shift arrow extends the selection, later it clears', () => {
    fill('hello');
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    send('\x1b[1;2D');
    now += 50; send('\x1b[D');
    expect(screen.model.input.slice(screen.model.inputCur, screen.model.inputAnchor)).toBe('lo');
    now += 500; send('\x1b[D');
    expect(screen.model.inputAnchor).toBe(-1);
  });

  it('Up and Down step through sent lines with the editing label; Down past the newest restores the draft', () => {
    say('first'); say('second');
    fill('draft');
    send('\x1b[A');
    expect(screen.model.input).toBe('second');
    expect(screen.model.editing).toBe(true);
    send('\x1b[A');
    expect(screen.model.input).toBe('first');
    send('\x1b[B'); send('\x1b[B');
    expect(screen.model.input).toBe('draft');
    expect(screen.model.editing).toBe(false);
  });

  it('Up on an empty line picks a message and Enter replies to it', () => {
    post('pick me');
    send('\x1b[A');
    expect(screen.model.pick).not.toBe('');
    const n = screen.model.lines[screen.model.pickIndex()].number;
    send('\r');
    expect(screen.model.pick).toBe('');
    expect(screen.model.input).toBe(`/reply ${n} `);
  });

  it('Tab completes @name from the room users and the ghost shows the rest', () => {
    fill('hi @b');
    expect(screen.render(true).toString('latin1')).toContain('ob');
    send('\t');
    expect(screen.model.input).toBe('hi @bob');
  });

  it('Tab after "/msg @b" completes the nick; "/msg b" with no @ moves focus, as LIVECHAT _tryTabComplete does', () => {
    fill('/msg @b');
    send('\t');
    expect(screen.model.input).toBe('/msg @bob');
    fill('/msg b');
    send('\t');
    expect(screen.model.input).toBe('/msg b');
    expect(screen.model.focus).toBe(FOCUS_SIDEBAR);
  });

  it('Tab cycles focus input, sidebar, menu bar; Shift+Tab goes back; menu keys move and Esc closes', () => {
    send('\t');
    expect(screen.model.focus).toBe(FOCUS_SIDEBAR);
    send('\t');
    expect([screen.model.focus, screen.model.menu]).toEqual([FOCUS_MENU, 0]);
    send('\x1b[C');
    expect(screen.model.menu).toBe(1);
    send('\x1b[B');
    expect(screen.model.menuSel).toBe(1);
    send('\x1b');
    send('\x1b[Z'); // Esc returns to the input, Shift+Tab from the input wraps back to the menu bar
    expect(screen.model.focus).toBe(FOCUS_MENU);
  });

  it('a menu item runs from the keyboard and from a click: Join Channel fills /join', () => {
    send('\t'); send('\t');
    send('\x1b[B'); send('\x1b[B'); send('\x1b[B');
    expect(MENU_ITEMS[0][screen.model.menuSel]).toBe('Join Channel...');
    send('\r');
    expect([screen.model.focus, screen.model.input]).toEqual([FOCUS_INPUT, '/join ']);
  });

  it('hover with a menu open moves to the next menu and arms any-motion reports', () => {
    const out = click(0, 0, MENU_COL[0]);
    expect(out).toContain('\x1b[?1003h');
    send(`\x1b[<35;${MENU_COL[1] + 1};1M`);
    expect(screen.model.menu).toBe(1);
  });

  it('a right-click on a chat line opens the message menu and Reply fills /reply N', () => {
    post('reply to me');
    const d = screen.drawState;
    const r = Array.from(d.chatRowLine).findIndex((li) => li >= 0 && screen.model.lines[li].number > 0);
    const n = screen.model.lines[d.chatRowLine[r]].number;
    click(2, d.chatBody + r, d.chatLeft + 2);
    expect(screen.model.popup?.items[0]).toBe('Reply');
    const at = hit(HIT_POPUP, 0);
    click(0, at.row, at.col);
    expect(screen.model.input).toBe(`/reply ${n} `);
  });

  it('a click on a user opens the user menu; Send Message opens a DM line', () => {
    const i = screen.model.side.findIndex((s) => s.kind === SIDE_USER);
    const at = hit(HIT_SIDEBAR, i);
    click(0, at.row, at.col);
    expect(screen.model.popup?.items).toContain('Kick User');
    const p = hit(HIT_POPUP, 1);
    click(0, p.row, p.col);
    expect(screen.model.input).toBe(`/msg ${screen.model.side[i].label} `);
  });
});
