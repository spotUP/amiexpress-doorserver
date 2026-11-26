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
import { chatScreen, HubScreen, K_F1, K_F4 } from '../src/partyline/ui/screen';
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

  it.each([['help', K_F1], ['emoji picker', K_F4]] as const)('utf8 caller: %s owns non-ASCII glyphs', (_name, key) => {
    const screen = openScreen('bob', true, { charset: 'utf8', handle: 'bob' });
    try {
      screen.key(key);
      screen.input(Buffer.from('ä', 'utf8'));
      expect(screen.model.input).toBe('');
    } finally {
      screen.close();
    }
  });

  it('utf8 caller: x10 mouse with high coordinates stays raw, not text', () => {
    const screen = openScreen('bob', true, { charset: 'utf8', handle: 'bob', cols: 120, rows: 40 });
    try {
      screen.render(true);
      // col 101 -> coordinate byte 133 (>= 0x80): must not enter the UTF-8 decoder.
      screen.input(Buffer.from([0x1b, 0x5b, 0x4d, 32, 32 + 101, 32 + 11]));
      screen.render(true);
      expect(screen.model.input).toBe('');
      expect(screen.model.menu).toBe(-1);
      screen.input(Buffer.from('ä', 'utf8'));
      expect(screen.model.input).toBe('ä');
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
      let lobby = '', random = '';
      screen.run(true, (db, ctx) => {
        lobby = createRoom(db, ctx, { name: 'Lobby' }).id;
        random = createRoom(db, ctx, { name: 'Random' }).id;
      });
      expect(screen.joinRoom(random)).toBe(true);
      expect(screen.joinRoom(lobby)).toBe(true);
      const labels = (): string[] => screen.model.side.map((s) => s.label);
      expect(labels()[0]).toBe('TEXT CHANNELS');
      expect(labels()).toContain('Lobby');
      // amy writes in both rooms. LIVECHAT core/state.ts: only the background room counts
      // (noteBackgroundMessage); the room on screen stays read (setChannel zeroes it).
      const amySid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'amy', sysop: false, client: 'test' }).sid);
      withAchievementsDb(fx.ach, (db) => {
        const amy = resolveSession(db, chat, amySid, fx.boardId);
        joinRoom(db, amy, lobby);
        joinRoom(db, amy, random);
        postMessage(db, amy, lobby, { content: 'hi bob', clientId: 'a1' });
        postMessage(db, amy, random, { content: 'over here', clientId: 'a2' });
      });
      screen.take();
      const rooms = screen.model.side.filter((s) => s.kind === 1);
      expect(rooms.find((s) => s.label === 'Random')?.unread).toBe(1);
      expect(rooms.find((s) => s.label === 'Lobby')?.unread).toBe(0);
      expect(labels()).not.toContain('USERS'); // LIVECHAT: members sit inline under the active room
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
    `\x1b[${32 + b};${x + 1};${y + 1}${end}`; // rxvt-unicode sends Cb + 32, like X10

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

  it.each([['x10', x10], ['urxvt', urxvt]] as const)('%s shift+release over the menu is not a click', (_name, enc) => {
    const screen = openScreen('bob', true, { handle: 'bob' });
    try {
      screen.render(true);
      screen.input(Buffer.from(enc(3 | 4, MENU_COL[2], 0), 'latin1'));
      expect(screen.model.menu).toBe(-1);
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
