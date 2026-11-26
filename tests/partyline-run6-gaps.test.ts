/**
 * Telnet run 6, checked against LIVECHAT (board/Doors/livechat):
 * - G1: the caller's own users-list row opens no menu (server.ts userList 'select' and 'rightclick' skip `username`);
 *   the status picker is the Settings overlay radio (overlays/settings-status-radio.ts).
 * - G2: Up on an empty line starts message pick with action 'menu'; Enter opens the message context menu
 *   (server.ts messagePicker onConfirm kind 'menu' -> showContextMenu 'chat'), it does not fill "/reply N".
 * - G3: "/j", Esc, Enter never posts "/j" as chat; Esc only hides the popup (server.ts hideCommandSuggestions).
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, roomHistory } from '../src/chat/store';
import { chatScreen } from '../src/partyline/ui/screen';
import { SIDE_USER, FOCUS_SIDEBAR, newLine } from '../src/partyline/ui/model';
import { DISCORD_INVITE, HELP_TEXT } from '../src/partyline/ui/overlays';
import { HIT_SIDEBAR } from '../src/partyline/ui/draw';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('Partyline telnet run 6 gaps (LIVECHAT parity)', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  let sid: string;
  const chat = loadChatConfig();
  beforeEach(() => {
    fx = makeAchievementsFixture();
    sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: false, client: 'test' }).sid);
    withAchievementsDb(fx.ach, (db) => createRoom(db, resolveSession(db, chat, sid, fx.boardId), { name: 'Lobby' }));
    withAchievementsDb(fx.ach, (db) => createRoom(db, resolveSession(db, chat, sid, fx.boardId), { name: 'Random' }));
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
    screen.render(true);
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const send = (s: string): void => { screen.input(Buffer.from(s, 'latin1')); screen.render(true); };
  const texts = (): string[] => withAchievementsDb(fx.ach, (db) => roomHistory(db, resolveSession(db, chat, sid, fx.boardId), screen.roomId, { limit: 50 }).map((h) => h.text));

  it('G3: /j, Esc, Enter opens the channel pick list and posts nothing to the room', () => {
    expect(screen.roomId).not.toBe('');
    const before = texts();
    send('/j');
    expect(screen.model.popup).toBeNull();
    send('\x1b'); // a chunk ending in a bare ESC is the Esc key
    expect(screen.model.input).toBe('/j');
    send('\r');
    expect(texts()).toEqual(before);
    expect(texts().some((t) => t.includes('/j'))).toBe(false);
    expect(screen.model.popup).not.toBeNull();
  });

  it('G2: Up on an empty line picks a message and Enter opens its context menu (LIVECHAT kind "menu"), not /reply', () => {
    screen.model.lines.push({ ...newLine(0, '12:00', 'alice', 'hello run six'), number: 42, id: 'm42' });
    screen.render(true);
    send('\x1b[A');
    expect(screen.model.pick).not.toBe('');
    send('\r');
    expect(screen.model.pick).toBe('');
    expect(screen.model.input).toBe('');
    expect(screen.model.popup?.items).toEqual(['Reply', 'React', '---', 'Copy Text', 'Pin Message', '---', 'Mark Unread', 'Edit', 'Delete']);
  });

  it('G1: a click or Enter on the own users-list row opens no member menu (LIVECHAT skips username)', () => {
    const m = screen.model;
    const own = m.side.findIndex((s) => s.kind === SIDE_USER && m.isSelf(s.label));
    expect(own).toBeGreaterThanOrEqual(0);
    const at = (screen as unknown as { hitAt(id: number, dr: number): { row: number; col: number } }).hitAt(HIT_SIDEBAR, own);
    m.sideSel = -1;
    // Same 1-based col offset as lane1's click helper; the sideSel check proves the click landed on the row.
    send(`\x1b[<0;${at.col + 1};${at.row + 1}M\x1b[<0;${at.col + 1};${at.row + 1}m`);
    expect(m.sideSel).toBe(own);
    expect(m.popup).toBeNull();
    send(`\x1b[<2;${at.col + 1};${at.row + 1}M\x1b[<2;${at.col + 1};${at.row + 1}m`);
    expect(m.popup).toBeNull();
    m.focus = FOCUS_SIDEBAR; m.sideSel = own;
    send('\r');
    expect(m.popup).toBeNull();
    expect(m.sideSel).toBe(own);
  });

  it('Up on an empty line with nothing to pick says so, as LIVECHAT does', () => {
    screen.model.lines = screen.model.lines.filter((l) => l.number === 0);
    send('\x1b[A');
    expect(screen.model.pick).toBe('');
    expect(screen.model.lines[screen.model.lines.length - 1].text).toBe('No messages to pick.');
  });

  it('shows the Discord invite once on the first join and in the F1 help', () => {
    const invites = (): number => screen.model.lines.filter((l) => l.text.includes(DISCORD_INVITE)).length;
    expect(DISCORD_INVITE).toBe('https://discord.gg/7VGHTkbCGW');
    expect(invites()).toBe(1);
    send('/join Random\r');
    expect(screen.model.room).toBe('Random');
    expect(invites()).toBe(0);
    expect(HELP_TEXT.some((t) => t.includes(DISCORD_INVITE))).toBe(true);
  });
});
