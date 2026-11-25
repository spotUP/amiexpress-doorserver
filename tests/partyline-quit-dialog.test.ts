/**
 * Ctrl+Q opens the Quit dialog (2026-11-25 sysop, localhost: "i cant click it or navigate it with keys").
 * LIVECHAT68 (livechat.c handle_mouse) answers a click on [ Yes ] / [ No ]; a lone Esc from a web
 * terminal arrives as one byte and must close the dialog without waiting for the next key.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom } from '../src/chat/store';
import { chatScreen } from '../src/partyline/ui/screen';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';
import { HIT_YES, HIT_NO, MODAL_NONE, MODAL_QUIT } from '../src/partyline/ui/overlays';

describe('Partyline Quit dialog', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  let quits = 0;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    quits = 0;
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => { quits++; }, sound: () => undefined }) as HubScreen;
    const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name: 'lobby' })) as unknown as { id?: string; room?: { id: string } };
    screen.joinRoom(r.id ?? r.room?.id ?? '');
    screen.render(true);
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const key = (s: string): void => { screen.input(Buffer.from(s, 'latin1')); screen.render(false); };
  const cellOf = (id: number): [number, number] => {
    for (let r = 0; r < 25; r++) for (let c = 0; c < 80; c++) if (screen.drawState.hits.at(r, c).id === id) return [r, c];
    throw new Error(`no hit ${id}`);
  };
  const click = (id: number): void => { const [r, c] = cellOf(id); key(`\x1b[<0;${c + 1};${r + 1}M\x1b[<0;${c + 1};${r + 1}m`); };

  it('a click on [ No ] closes the dialog and stays in the chat', () => {
    key('\x11');
    expect(screen.over.modal).toBe(MODAL_QUIT);
    click(HIT_NO);
    expect(screen.over.modal).toBe(MODAL_NONE);
    expect(quits).toBe(0);
  });

  it('a click on [ Yes ] leaves the chat', () => {
    key('\x11');
    click(HIT_YES);
    expect(quits).toBe(1);
  });

  it('a lone Esc byte closes the dialog at once', () => {
    key('\x11');
    key('\x1b');
    expect(screen.over.modal).toBe(MODAL_NONE);
    expect(quits).toBe(0);
  });

  // the [ char inside each button: same glyph, so a different cell value means a different pen
  const face = (id: number): number => { const [r, c] = cellOf(id); return screen.cells.back[(r + 1) * 80 + c + 1]; };

  it('draws [ Yes ] highlighted at open, and Tab / Shift+Tab / arrows move the highlight', () => {
    key('\x11');
    const yesOn = face(HIT_YES), noOff = face(HIT_NO);
    expect(yesOn).not.toBe(noOff);
    key('\t');
    expect(face(HIT_NO)).not.toBe(noOff);
    expect(face(HIT_YES)).not.toBe(yesOn);
    key('\x1b[Z');
    expect(face(HIT_YES)).toBe(yesOn);
    key('\x1b[C');
    expect(face(HIT_YES)).not.toBe(yesOn);
    key('\x1b[D');
    expect(face(HIT_YES)).toBe(yesOn);
  });

  it('Enter on [ No ] closes the dialog and stays in the chat', () => {
    key('\x11');
    key('\t');
    key('\r');
    expect(screen.over.modal).toBe(MODAL_NONE);
    expect(quits).toBe(0);
  });

  it('Enter on [ Yes ] (the initial focus) leaves the chat', () => {
    key('\x11');
    key('\r');
    expect(quits).toBe(1);
  });

  it('the dialog reopens with [ Yes ] focused', () => {
    key('\x11'); key('\t'); key('n');
    key('\x11'); key('\r');
    expect(quits).toBe(1);
  });

  it('an arrow key in its own chunk is still an arrow, not Esc', () => {
    key('\x11');
    key('\x1b[C');
    expect(screen.over.modal).toBe(MODAL_QUIT);
  });
});
