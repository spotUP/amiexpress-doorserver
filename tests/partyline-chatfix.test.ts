/**
 * Hub screen charset + sidebar: UTF-8 callers type and read UTF-8, latin1
 * callers keep byte-identical behaviour, and the sidebar lists rooms/users.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, joinRoom, postMessage } from '../src/chat/store';
import { chatScreen, HubScreen } from '../src/partyline/ui/screen';
import { MENU_COL } from '../src/partyline/ui/draw';
import type { ScreenInfo } from '../src/partyline/session';

let fx: AchievementsFixture;
beforeEach(() => {
  fx = makeAchievementsFixture();
});
afterEach(() => {
  _stopChatSweepersForTests();
  fx.cleanup();
});

function openScreen(handle: string, sysop: boolean, hello: Record<string, unknown>): HubScreen {
  const chat = loadChatConfig();
  const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle, sysop, client: 'test' }).sid);
  return chatScreen(fx.ach, chat)({
    sid, user: `${handle}@${fx.boardId.toUpperCase()}`, boardId: fx.boardId,
    hello: { cols: 80, rows: 24, ...hello } as ScreenInfo['hello'],
    markDirty: () => undefined, quit: () => undefined,
  }) as HubScreen;
}

describe('hub screen charset', () => {
  it('utf8 caller: split multibyte input assembles, output is UTF-8', () => {
    const screen = openScreen('bob', true, { charset: 'utf8', handle: 'bob' });
    try {
      let lobby = '';
      screen.run(true, (db, ctx) => {
        lobby = createRoom(db, ctx, { name: 'Lobby' }).id;
      });
      expect(screen.joinRoom(lobby)).toBe(true);
      // ä as UTF-8, split across two K frames (the decoder holds the half glyph).
      screen.input(Buffer.from([0xc3]));
      screen.input(Buffer.from([0xa4]));
      expect(screen.model.input).toBe('ä');
      expect(screen.render(false).includes(Buffer.from('ä', 'utf8'))).toBe(true);
    } finally {
      screen.close();
    }
  });

  it('latin1 caller: byte input stays byte-identical on the wire', () => {
    const screen = openScreen('bob', true, { handle: 'bob' });
    try {
      screen.input(Buffer.from([0xe4]));
      expect(screen.model.input).toBe('ä');
      const out = screen.render(false);
      expect(out.includes(Buffer.from([0xe4]))).toBe(true);
      expect(out.includes(Buffer.from('ä', 'utf8'))).toBe(false);
    } finally {
      screen.close();
    }
  });
});

describe('hub screen sidebar', () => {
  it('lists joined rooms with unreads and the users in this room', () => {
    const chat = loadChatConfig();
    const screen = openScreen('bob', true, { handle: 'bob' });
    try {
      let lobby = '';
      screen.run(true, (db, ctx) => {
        lobby = createRoom(db, ctx, { name: 'Lobby' }).id;
      });
      expect(screen.joinRoom(lobby)).toBe(true);
      const labels = (): string[] => screen.model.side.map((s) => s.label);
      expect(labels()[0]).toBe('TEXT CHANNELS');
      expect(labels()).toContain('Lobby');
      // amy joins and writes: bob's sidebar shows unread 1 and amy below USERS.
      const amySid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'amy', sysop: false, client: 'test' }).sid);
      withAchievementsDb(fx.ach, (db) => {
        const amy = resolveSession(db, chat, amySid, fx.boardId);
        joinRoom(db, amy, lobby);
        postMessage(db, amy, lobby, { content: 'hi bob', clientId: 'a1' });
      });
      screen.take();
      const rooms = screen.model.side.filter((s) => s.kind === 1);
      expect(rooms.find((s) => s.label === 'Lobby')?.unread).toBe(1);
      expect(labels()).toContain('USERS');
      expect(labels()).toContain('amy');
    } finally {
      screen.close();
    }
  });
});

describe('hub screen mouse formats', () => {
  // Old terminals answer ?1000h without SGR (?1006h): X10 and urxvt reports
  // must click, never land in the input line as garbage.
  const x10 = (b: number, x: number, y: number): string =>
    `\x1b[M${String.fromCharCode(32 + b, 32 + x + 1, 32 + y + 1)}`;
  const urxvt = (b: number, x: number, y: number, end = 'M'): string =>
    `\x1b[${b};${x + 1};${y + 1}${end}`;

  it.each([['x10', x10], ['urxvt', urxvt]] as const)('%s click opens the menu, types nothing', (_name, enc) => {
    const screen = openScreen('bob', true, { handle: 'bob' });
    try {
      screen.render(true);
      screen.input(Buffer.from(enc(0, MENU_COL[2], 0), 'latin1'));
      screen.render(true);
      expect(screen.model.menu).toBe(2);
      expect(screen.model.input).toBe('');
    } finally {
      screen.close();
    }
  });

  it('x10 release and overlong reports are swallowed', () => {
    const screen = openScreen('bob', true, { handle: 'bob' });
    try {
      screen.render(true);
      screen.input(Buffer.from(x10(3, 10, 10), 'latin1'));
      screen.input(Buffer.from('\x1b[M\x40\x41', 'latin1'));
      screen.render(true);
      expect(screen.model.input).toBe('');
      expect(screen.model.menu).toBe(-1);
    } finally {
      screen.close();
    }
  });
});
