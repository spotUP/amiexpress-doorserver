/**
 * LIVECHAT unread parity (core/state.ts): the channel on screen never counts unread; only background
 * channels do (noteBackgroundMessage). The caller's own posts must not raise the room they are in.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, joinRoom, listMemberships, postMessage } from '../src/chat/store';
import { chatScreen } from '../src/partyline/ui/screen';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('hub screen unread for the room on screen', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  let lobby = '', side = '', carolSid = '';
  const chat = loadChatConfig();
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: false, client: 'test' }).sid);
    carolSid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'carol', sysop: false, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined, sound: () => undefined }) as HubScreen;
    screen.tryRun(true, (db, ctx) => { lobby = createRoom(db, ctx, { name: 'lobby' }).id; side = createRoom(db, ctx, { name: 'side' }).id; joinRoom(db, ctx, side); return 0; });
    carol((db, ctx) => { joinRoom(db, ctx, lobby); joinRoom(db, ctx, side); });
    screen.joinRoom(lobby);
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const carol = (fn: Parameters<HubScreen['run']>[1]): void => {
    withAchievementsDb(fx.ach, (db) => { const ctx = resolveSession(db, chat, carolSid, fx.boardId); db.transaction(() => fn(db, ctx))(); });
  };
  const pump = (): void => (screen as unknown as { take(): void }).take();
  const unread = (id: string): number => (screen.tryRun(false, (db, ctx) => listMemberships(db, ctx)) ?? []).find((m) => m.roomId === id)?.unread ?? -1;

  it('own posts leave the room on screen at no unread', () => {
    screen.sendRoomLine('hello');
    screen.sendRoomLine('again');
    pump();
    expect(unread(lobby)).toBe(0);
  });

  it('another user posting in the room on screen leaves it read; a background room counts', () => {
    carol((db, ctx) => { postMessage(db, ctx, lobby, { content: 'hi bob', clientId: 'c1' }); postMessage(db, ctx, side, { content: 'over here', clientId: 'c2' }); });
    pump();
    expect(unread(lobby)).toBe(0);
    expect(unread(side)).toBe(1);
  });
});
