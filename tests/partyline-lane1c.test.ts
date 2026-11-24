/**
 * LIVECHAT parity for the Partyline hub screen, lane 1c: the Settings and Search overlays
 * (livechat.c settings_* and search_*), prefs persistence and the 5 s stale typing row.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, getPrefs } from '../src/chat/store';
import type { EventRec } from '../src/chat/events';
import { chatScreen } from '../src/partyline/ui/screen';
import { SET_LOGINS, SET_TYPING } from '../src/partyline/ui/overlays';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('hub screen lane 1c: LIVECHAT settings, search, prefs and typing', () => {
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

  it('/settings opens the overlay; Space toggles, Esc closes and saves the prefs', () => {
    key('/settings\r');
    expect(screen.over.settings).toBe(true);
    expect(screen.over.settingsVal[SET_LOGINS]).toBe(true);
    key(' ');
    esc();
    expect(screen.over.settings).toBe(false);
    expect(screen.prefs.events.logins).toBe(false);
    const p = screen.tryRun(false, (db, ctx) => getPrefs(db, ctx)) as Record<string, unknown>;
    expect(p.showLogins).toBe(false);
  });

  it('Ctrl+F opens Search; a 1-character query is refused, a real one lists results', () => {
    key('hello world\r');
    key('\x06');
    expect(screen.over.search).toBe(true);
    key('h\r');
    expect(lines().some((l) => l.includes('Search query must be at least 2 characters'))).toBe(true);
    key('ello\r');
    expect(screen.over.searchRows.length).toBe(1);
    expect(lines().some((l) => l.includes('Found 1 results for "hello"'))).toBe(true);
    esc();
    expect(screen.over.search).toBe(false);
  });

  it('a typing row goes stale after 5 s; typing off in Settings clears and hides rows', () => {
    const fire = (text: string): void => (screen as unknown as { event(e: EventRec): void }).event({ seq: 0, type: 'typing', room_id: screen.roomId, label: '', user: 'alice', ref: '', at: 0, text, reply_to: null } as unknown as EventRec);
    fire('hi');
    screen.take();
    expect(screen.model.typing.map((t) => t.nick)).toEqual(['alice']);
    const tick = (screen as unknown as { typingTick(): boolean });
    for (let t = 0; t < 99; t++) tick.typingTick();
    expect(screen.model.typing.length).toBe(1);
    tick.typingTick();
    expect(screen.model.typing).toEqual([]);
    screen.settingsOpen();
    screen.settingsPick(SET_TYPING);
    esc();
    fire('again');
    screen.take();
    expect(screen.model.typing).toEqual([]);
  });
});
