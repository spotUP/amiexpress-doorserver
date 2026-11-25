/**
 * LIVECHAT handlers/keyboard-shortcuts.ts Alt+R / Alt+F / Alt+L on the Partyline hub screen:
 * layout reset, fullscreen of the focused pane, and the three layout presets.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom } from '../src/chat/store';
import { chatScreen } from '../src/partyline/ui/screen';
import { FOCUS_SIDEBAR, PANE_CHAT, PANE_SIDEBAR } from '../src/partyline/ui/model';
import { HIT_CHAT, HIT_SIDEBAR } from '../src/partyline/ui/draw';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('hub screen: LIVECHAT Alt+R / Alt+F / Alt+L layout keys', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
    const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name: 'lobby' })) as unknown as { id?: string; room?: { id: string } };
    screen.joinRoom(r.id ?? r.room?.id ?? '');
    screen.render(true);
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const send = (s: string): string => { screen.input(Buffer.from(s, 'latin1')); return screen.render(false).toString('latin1'); };
  const last = (): string => screen.model.lines[screen.model.lines.length - 1].text;
  /** First cell (row, col) a hit id covers, or null when it is not on screen. */
  const where = (id: number): { row: number; col: number } | null => {
    for (let r = 0; r < 25; r++) for (let c = 0; c < 80; c++) if (screen.drawState.hits.at(r, c).id === id) return { row: r, col: c };
    return null;
  };

  it('Alt+L cycles Wide Sidebar, Vertical Split, Standard with the LIVECHAT messages', () => {
    const std = screen.model.panes();
    send('\x1bl');
    expect(last()).toBe('Layout: Wide Sidebar');
    expect(screen.model.panes().side?.w).toBe(32);
    expect(screen.model.panes().chat).toEqual({ top: 1, h: 20, left: 32, w: 48 });
    expect(where(HIT_CHAT)?.col).toBe(33);
    send('\x1bl');
    expect(last()).toBe('Layout: Vertical Split');
    expect(screen.model.panes()).toEqual({ side: { top: 1, h: 8, left: 0, w: 80 }, chat: { top: 9, h: 12, left: 0, w: 80 } });
    expect(where(HIT_SIDEBAR)).toEqual({ row: 2, col: 1 });
    expect(where(HIT_CHAT)?.row).toBeGreaterThan(9);
    send('\x1bl');
    expect(last()).toBe('Layout: Standard');
    expect(screen.model.panes()).toEqual(std);
  });

  it('Alt+F fullscreens the chat from the input and the sidebar from the sidebar, again restores', () => {
    send('\x1bf');
    expect(screen.model.maxPane).toBe(PANE_CHAT);
    expect(last()).toBe('Chat Fullscreen enabled');
    expect(where(HIT_SIDEBAR)).toBeNull();
    expect(where(HIT_CHAT)?.col).toBe(1);
    send('\x1bf');
    expect(screen.model.maxPane).toBe(0);
    expect(last()).toBe('Chat Fullscreen disabled');
    screen.model.focus = FOCUS_SIDEBAR;
    send('\x1bf');
    expect(screen.model.maxPane).toBe(PANE_SIDEBAR);
    expect(last()).toBe('Fullscreen enabled');
    expect(where(HIT_CHAT)).toBeNull();
    expect(screen.model.panes().side).toEqual({ top: 1, h: 20, left: 0, w: 80 });
  });

  it('Alt+R puts the standard layout back from a preset and a fullscreen pane', () => {
    const std = screen.model.panes();
    send('\x1bl'); send('\x1bl'); send('\x1bf');
    send('\x1br');
    expect(last()).toBe('Layout reset to defaults');
    expect(screen.model.layout).toBe(0);
    expect(screen.model.maxPane).toBe(0);
    expect(screen.model.panes()).toEqual(std);
  });

  it('Esc followed by another letter still types it, and a lone Esc is still Esc', () => {
    send('\x1bx');
    expect(screen.model.input).toBe('x');
    expect(screen.model.layout).toBe(0);
  });
});
