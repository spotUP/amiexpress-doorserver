/**
 * LIVECHAT parity for the Partyline hub screen, lane 1d: the theme panel (livechat.c theme_*), the pinned/thread view
 * window and profile modal, mouse clicks inside Settings and Search, and Enter on a search result jumping to the message.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom } from '../src/chat/store';
import type { EventRec } from '../src/chat/events';
import { chatScreen } from '../src/partyline/ui/screen';
import { HIT_SEARCH_ROW, HIT_SETTINGS_ROW, HIT_THEME_ROW, MODAL_MESSAGE, MODAL_NONE, SET_LOGINS } from '../src/partyline/ui/overlays';
import { THEMES } from '../src/partyline/ui/model';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('hub screen lane 1d: LIVECHAT theme, views, overlay clicks and search jump', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined, sound: () => undefined }) as HubScreen;
    const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name: 'lobby' })) as unknown as { id?: string; room?: { id: string } };
    screen.joinRoom(r.id ?? r.room?.id ?? '');
    screen.render(true);
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const key = (s: string): void => screen.input(Buffer.from(s, 'latin1'));
  /** A lone Esc is decided by the next byte (screen.ts inputBytes), so a second Esc follows it. */
  const esc = (): void => key('\x1b\x1b');
  const lines = (): string[] => screen.model.lines.map((l) => l.head + l.text);

  /** Pull the committed events into the screen now (onEvents tells it after the commit). */
  const pump = (): void => (screen as unknown as { take(): void }).take();
  /** The first cell carrying a hit id, then a left press and release there. */
  const click = (id: number, dr = 0): void => {
    screen.render(true);
    for (let r = 0; r < 25; r++) for (let c = 0; c < 80; c++) {
      const h = screen.drawState.hits.at(r, c);
      if (h.id === id && h.dr === dr) { key(`\x1b[<0;${c + 1};${r + 1}M`); key(`\x1b[<0;${c + 1};${r + 1}m`); return; }
    }
    throw new Error(`no hit ${id}/${dr} on screen`);
  };

  it('/theme previews on Down, Esc puts the opened theme back, Enter keeps the pick', () => {
    const first = [...screen.model.pal.col];
    key('/theme\r');
    expect(screen.over.theme).toBe(true);
    key('\x1b[B');
    expect(screen.over.themeSel).toBe(1);
    expect(screen.model.pal.col).not.toEqual(first);
    esc();
    expect(screen.over.theme).toBe(false);
    expect(screen.model.pal.col).toEqual(first);
    key('/theme\r');
    click(HIT_THEME_ROW, 2);
    expect(screen.over.themeSel).toBe(2);
    key('\r');
    expect(screen.over.theme).toBe(false);
    key('/theme\r');
    expect(screen.over.themeSel).toBe(2);
    expect(THEMES.length).toBe(6);
  });

  it('a click on a Settings row toggles it', () => {
    key('/settings\r');
    screen.render(true);
    const at = Array.from(screen.over.setItemAt).indexOf(SET_LOGINS);
    click(HIT_SETTINGS_ROW, at);
    expect(screen.over.settingsVal[SET_LOGINS]).toBe(false);
  });

  it('Search: a click selects a result, Enter on the shown results picks that message', () => {
    key('hello one\r');
    key('hello two\r');
    pump();
    key('\x06');
    key('hello\r');
    expect(screen.over.searchRows.length).toBe(2);
    click(HIT_SEARCH_ROW, 1);
    expect(screen.over.searchSel).toBe(1);
    const id = screen.over.searchIds[1];
    key('\r');
    expect(screen.over.search).toBe(false);
    expect(screen.model.pick).toBe(id);
  });

  it('/pinned and /thread open the view window; Esc closes it', () => {
    key('/pinned\r');
    expect(screen.over.view).toBe(true);
    expect(screen.over.viewText).toContain('No pinned messages in this room.');
    esc();
    expect(screen.over.view).toBe(false);
    key('first post\r');
    pump();
    const n = screen.model.lines.find((l) => l.text.includes('first post'))?.number ?? 0;
    key(`/thread ${n}\r`);
    expect(screen.over.viewTitle).toBe('Thread');
    expect(screen.over.viewText).toContain('No replies yet. Be the first to reply!');
    esc();
    expect(screen.over.view).toBe(false);
  });

  it('a message modal closes on Enter', () => {
    screen.over.modal = MODAL_MESSAGE; screen.over.modalTitle = 'bob'; screen.over.modalText = 'x';
    key('\r');
    expect(screen.over.modal).toBe(MODAL_NONE);
  });
});
