/**
 * Two fake Partyline callers run the board's LIVECHAT door on the hub at once,
 * each in its own child process, and talk through the hub's chat store.
 */
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, listRooms, roomHistory } from '../src/chat/store';
import { livechatScreen } from '../src/partyline/livechat-host';
import { renderParts } from '../src/partyline/session';
import type { PartylineScreen, ScreenInfo } from '../src/partyline/session';
import { makeAchievementsFixture } from './achievements/helpers';

/** The caller's text (D parts); kitty G parts are not screen text. */
const screenText = (s: PartylineScreen): string => renderParts(s.render(false)).filter((p) => p.type === 'D').map((p) => p.bytes.toString('latin1')).join('');

jest.setTimeout(120_000);

const until = async (ok: () => boolean, ms: number): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

interface Caller { s: PartylineScreen; screen: () => string }

test('two LIVECHAT callers run side by side, talk, and one leaving keeps the other', async () => {
  const fx = makeAchievementsFixture();
  const chat = loadChatConfig();
  const callers: Caller[] = [];
  const logs: string[] = [];
  try {
    const sid = (handle: string): string => withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle, sysop: true, client: 'test' }).sid);
    const bobSid = sid('bob');
    const aliceSid = sid('alice');
    withAchievementsDb(fx.ach, (db) => createRoom(db, resolveSession(db, chat, bobSid, fx.boardId), { name: 'general' }));
    const factory = livechatScreen(fx.ach, chat, undefined, (l) => logs.push(l));
    const start = (user: string, id: string): Caller => {
      let text = '';
      let s: PartylineScreen | undefined;
      s = factory({ sid: id, user, boardId: fx.boardId, hello: { cols: 80, rows: 25 } as ScreenInfo['hello'], markDirty: () => { setImmediate(() => { if (s) text += screenText(s); }); }, quit: () => {} });
      const c = { s, screen: () => text };
      callers.push(c);
      return c;
    };
    const bob = start('bob', bobSid);
    const alice = start('alice', aliceSid);
    await until(() => bob.screen().includes('Auto-joining #general') && alice.screen().includes('Auto-joining #general'), 110_000);
    expect(bob.screen()).toContain('Welcome to LiveChat v4.0!');
    expect(alice.screen()).toContain('Welcome to LiveChat v4.0!');
    await new Promise((r) => setTimeout(r, 1000));

    const texts = (): string[] => withAchievementsDb(fx.ach, (db) => {
      const ctx = resolveSession(db, chat, bobSid, fx.boardId);
      const id = listRooms(db, ctx).find((r) => r.name === 'general')!.id;
      return roomHistory(db, ctx, id, { limit: 10 }).map((h) => h.text);
    });
    bob.s.input(Buffer.from('hello hub\r', 'latin1'));
    await until(() => texts().includes('hello hub'), 10_000);
    await until(() => alice.screen().includes('hello hub'), 10_000);

    bob.s.close?.();
    alice.s.input(Buffer.from('still here\r', 'latin1'));
    await until(() => texts().includes('still here'), 10_000);
  } catch (e) {
    console.log(logs.slice(-60).join('\n'));
    throw e;
  } finally {
    for (const c of callers) c.s.close?.();
    _stopChatSweepersForTests();
    fx.cleanup();
  }
});
