/**
 * The Partyline input selection and mouse, ported from LIVECHAT (the SDK textbox.ts and server.ts):
 * shift-key selection, typing over it, the format picker on the selection, and the mouse actions
 * LIVECHAT has (click, drag, right-click, the emoji button, channel click and wheel).
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom } from '../src/chat/store';
import { cellBg, cellCh } from '../src/partyline/ui/cells';
import { chatScreen } from '../src/partyline/ui/screen';
import { SIDE_ROOM } from '../src/partyline/ui/model';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('hub screen input selection and mouse', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
  });
  afterEach(() => { jest.useRealTimers(); screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const send = (s: string): void => { screen.input(Buffer.from(s, 'latin1')); screen.render(true); };
  const fill = (text: string): void => { screen.model.input = text; screen.model.inputCur = text.length; screen.model.inputAnchor = -1; screen.render(true); };
  const sel = (): string => {
    const m = screen.model;
    return m.inputAnchor < 0 ? '' : m.input.slice(Math.min(m.inputAnchor, m.inputCur), Math.max(m.inputAnchor, m.inputCur));
  };
  // The input text sits on row rows-3 (1-based SGR row 23), character i on 1-based column i + 2.
  const mouseAt = (b: number, ch: number, end = 'M'): void => send(`\x1b[<${b};${ch + 2};23${end}`);

  it('shift+left and shift+right (xterm CSI 1;2) select from the cursor', () => {
    fill('hello');
    send('\x1b[1;2D\x1b[1;2D');
    expect(sel()).toBe('lo');
    send('\x1b[1;2C');
    expect(sel()).toBe('o');
  });

  it('rxvt shift arrows select too', () => {
    fill('hello');
    send('\x1b[d\x1b[d\x1b[d');
    expect(sel()).toBe('llo');
  });

  it('shift+home, shift+end, shift+up and shift+down select to the ends of the line', () => {
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 1000)); // past the LIVECHAT 150ms dropped-shift window
    fill('hello world');
    send('\x1b[1;2H'); expect(sel()).toBe('hello world');
    send('\x1b[C'); // a plain arrow clears the selection
    expect(sel()).toBe('');
    screen.model.inputCur = 6;
    send('\x1b[1;2F'); expect(sel()).toBe('world');
    send('\x1b[D'); screen.model.inputCur = 5;
    send('\x1b[1;2A'); expect(sel()).toBe('hello');
    send('\x1b'); send('x'); // Esc clears it (the x confirms the lone Esc went through)
    expect(screen.model.inputAnchor).toBe(-1);
    screen.model.inputCur = 0;
    send('\x1b[1;2B'); expect(sel()).toBe('xhello world');
    jest.restoreAllMocks();
  });

  it('the selection is drawn inverse', () => {
    fill('hello');
    send('\x1b[1;2D\x1b[1;2D');
    const c = screen.cells, row = 22;
    expect(cellBg(c.back[row * c.cols + 1 + 3])).not.toBe(cellBg(c.back[row * c.cols + 1]));
    expect(cellBg(c.back[row * c.cols + 1 + 3])).toBe(cellBg(c.back[row * c.cols + 1 + 4]));
  });

  it('typing replaces the selection', () => {
    fill('hello');
    send('\x1b[1;2D\x1b[1;2D');
    send('p!');
    expect(screen.model.input).toBe('help!');
    expect(screen.model.inputAnchor).toBe(-1);
  });

  it('backspace and delete remove the selection; delete alone removes forward', () => {
    fill('hello');
    send('\x1b[1;2D\x1b[1;2D\x7f');
    expect(screen.model.input).toBe('hel');
    send('\x1b[1;2H\x1b[3~');
    expect(screen.model.input).toBe('');
    fill('abc'); screen.model.inputCur = 1;
    send('\x1b[3~');
    expect(screen.model.input).toBe('ac');
  });

  it('F5 opens the format picker on the selection and a colour wraps it as LIVECHAT does', () => {
    fill('say hi');
    send('\x1b[1;2D\x1b[1;2D\x1b[15~');
    expect(screen.over.fmt).toBe(true);
    expect(screen.over.pickFmt).toBe(true);
    send('\r\r'); // Colors, then Red
    expect(screen.model.input).toBe('say {red-fg}hi{/red-fg}');
    expect(screen.model.inputCur).toBe(screen.model.input.length);
  });

  it('the format picker effects and markdown use the LIVECHAT wraps', () => {
    fill('hi');
    send('\x1b[1;2H\x1b[15~\x1b[B\r\r'); // Effects, Rainbow
    expect(screen.model.input).toBe('~rainbow~hi~/rainbow~');
    fill('hi');
    send('\x1b[1;2H\x1b[15~\x1b[B\x1b[B\r\r'); // Markdown, Bold
    expect(screen.model.input).toBe('**hi**');
  });

  it('a keyboard selection opens the format picker once the keys rest', () => {
    jest.useFakeTimers();
    fill('hello');
    send('\x1b[1;2D');
    expect(screen.over.fmt).toBe(false);
    jest.advanceTimersByTime(500);
    expect(screen.over.fmt).toBe(true);
    expect(screen.over.pickFmt).toBe(true);
  });

  it('a full frame asks for drag reports and leaving turns them off', () => {
    expect(screen.render(true).toString('latin1')).toContain('\x1b[?1000h\x1b[?1006h\x1b[?1002h');
  });

  it('a click in the input places the cursor', () => {
    fill('hello world');
    mouseAt(0, 3); mouseAt(0, 3, 'm');
    expect(screen.model.inputCur).toBe(3);
    expect(screen.model.inputAnchor).toBe(-1);
    expect(screen.over.fmt).toBe(false);
  });

  it('a drag in the input selects and the release opens the format picker', () => {
    fill('hello world');
    mouseAt(0, 6); mouseAt(32, 9); mouseAt(32, 11); mouseAt(0, 11, 'm');
    expect(sel()).toBe('world');
    expect(screen.over.fmt).toBe(true);
    expect(screen.over.pickFmt).toBe(true);
  });

  it('a right click in the input with text selected opens the format picker', () => {
    fill('hello');
    screen.model.inputAnchor = 0;
    mouseAt(2, 1);
    expect(screen.over.fmt).toBe(true);
    expect(screen.over.pickFmt).toBe(true);
  });

  it('a click on the :D button opens the emoji picker', () => {
    fill('');
    send('\x1b[<0;76;23M');
    expect(screen.over.fmt).toBe(true);
    expect(screen.over.pickFmt).toBe(false);
  });

  it('a click on a channel row, or a wheel step onto one, joins that channel', () => {
    screen.run(true, (db, ctx) => { for (const name of ['alpha', 'beta', 'gamma']) createRoom(db, ctx, { name }); });
    send('/join #alpha\r'); send('/join #beta\r'); send('/join #gamma\r');
    screen.take(); screen.render(true);
    const first = screen.model.side.findIndex((s) => s.kind === SIDE_ROOM);
    const label = screen.model.side[first].label;
    expect(screen.model.room).not.toBe(label);
    send(`\x1b[<0;3;${2 + first + 1}M`);
    expect(screen.model.room).toBe(label);
    send(`\x1b[<65;3;${2 + first + 1}M`); // the wheel steps two rows (side_move), onto the third channel
    expect(screen.model.side[screen.model.sideSel].kind).toBe(SIDE_ROOM);
    expect(screen.model.room).toBe(screen.model.side[screen.model.sideSel].label);
    expect(screen.model.room).not.toBe(label);
  });

  // textbox.ts _unitAt / _stepVisible / _selectedRange / preview: a format marker is one zero-width unit.
  const inputRow = (): string => {
    const c = screen.cells, row = c.rows - 3;
    let out = '';
    for (let x = 1; x < 60; x++) out += String.fromCharCode(cellCh(c.back[row * c.cols + x]));
    return out.trimEnd();
  };

  it('format markers do not show in the input line', () => {
    fill('say ~wave~hi~/wave~ {red-fg}yo{/red-fg}!');
    expect(inputRow()).toBe('say hi yo!');
  });

  it('left and right step over a format marker whole', () => {
    fill('a~wave~hi~/wave~');
    send('\x1b[D'); expect(screen.model.inputCur).toBe('a~wave~h'.length);
    send('\x1b[D'); expect(screen.model.inputCur).toBe('a~wave~'.length);
    send('\x1b[D'); expect(screen.model.inputCur).toBe(0);
    send('\x1b[C'); expect(screen.model.inputCur).toBe(1);
    send('\x1b[C'); expect(screen.model.inputCur).toBe('a~wave~h'.length);
  });

  it('shift+arrows select visible characters and the format picker gets the word without its markers', () => {
    fill('x {red-fg}hi{/red-fg}');
    send('\x1b[1;2D\x1b[1;2D');
    expect(screen.model.inputCur).toBe('x {red-fg}'.length);
    send('\x1b[15~'); // the format picker wraps the visible word, not half a marker
    expect(screen.over.pickSel.text).toBe('hi');
  });

  it('a click maps the screen column to the visible character', () => {
    fill('~wave~abc~/wave~');
    mouseAt(0, 2); mouseAt(0, 2, 'm');
    expect(screen.model.inputCur).toBe('~wave~ab'.length);
  });
});
