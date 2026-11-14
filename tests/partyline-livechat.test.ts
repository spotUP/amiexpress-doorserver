/**
 * Spike check: a fake Partyline caller runs the board's LIVECHAT door on the
 * hub and a typed line lands in the hub's chat store.
 */
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, listRooms, roomHistory } from '../src/chat/store';
import { livechatScreen } from '../src/partyline/livechat-host';
import type { PartylineScreen, ScreenInfo } from '../src/partyline/session';
import { makeAchievementsFixture } from './achievements/helpers';

jest.setTimeout(120_000);

const until = async (ok: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

test('LIVECHAT runs for a Partyline caller and posts to the hub store', async () => {
  const fx = makeAchievementsFixture();
  const chat = loadChatConfig();
  try {
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    withAchievementsDb(fx.ach, (db) => createRoom(db, resolveSession(db, chat, sid, fx.boardId), { name: 'general' }));
    let screen = '';
    const factory = livechatScreen(fx.ach, chat, undefined, () => {});
    let s: PartylineScreen | undefined;
    s = factory({ sid, user: 'bob', boardId: fx.boardId, hello: { cols: 80, rows: 25 } as ScreenInfo['hello'], markDirty: () => { setImmediate(() => { screen += s?.render(false).toString('latin1') ?? ''; }); }, quit: () => {} });
    await until(() => screen.includes('Auto-joining #general'), 90_000);
    expect(screen).toContain('Welcome to LiveChat v4.0!');
    await new Promise((r) => setTimeout(r, 500));
    s!.input(Buffer.from('hello hub\r', 'latin1'));
    const texts = (): string[] => withAchievementsDb(fx.ach, (db) => {
      const ctx = resolveSession(db, chat, sid, fx.boardId);
      const id = listRooms(db, ctx).find((r) => r.name === 'general')!.id;
      return roomHistory(db, ctx, id, { limit: 10 }).map((h) => h.text);
    });
    await until(() => texts().includes('hello hub'), 10_000);
    s!.close?.();
  } finally {
    _stopChatSweepersForTests();
    fx.cleanup();
  }
});
