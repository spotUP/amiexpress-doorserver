/**
 * Sysop 2026-11-13: "when I leave the chat alone the log history should be there to read when I return".
 * Room entry on the telnet Partyline screen shows everything after the caller's marker, and at least the
 * newest 100 messages when nothing is unread (store.ts entryHistory). The old screen showed the newest 30.
 */
import { _resetRateLimitsForTests } from '../src/achievements/ratelimit';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, joinRoom, markRead, postMessage, roomHeadSeq } from '../src/chat/store';
import { chatScreen } from '../src/partyline/ui/screen';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('Partyline room entry shows the history', () => {
  let fx: AchievementsFixture;
  let bob: string;
  let alice: string;
  let lobby: string;
  const chat = loadChatConfig();
  const screens: HubScreen[] = [];
  const ctx = (sid: string) => (db: Parameters<typeof resolveSession>[0]) => resolveSession(db, chat, sid, fx.boardId);
  const post = (n: number, from: number): void => withAchievementsDb(fx.ach, (db) => {
    for (let i = 0; i < n; i++) { _resetRateLimitsForTests(); postMessage(db, ctx(alice)(db), lobby, { content: `m${from + i}`, clientId: `c${from + i}` }); }
  });
  const open = (): HubScreen => {
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    const user = withAchievementsDb(fx.ach, (db) => ctx(bob)(db).user);
    const s = chatScreen(fx.ach, chat)({ sid: bob, user, boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
    screens.push(s);
    // The screen joins the caller's room itself on open; that join is the entry under test.
    expect(s.roomId).toBe(lobby);
    return s;
  };
  const shown = (s: HubScreen): string[] => s.model.lines.map((l) => l.text);

  beforeEach(() => {
    fx = makeAchievementsFixture();
    alice = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'alice', sysop: false, client: 'test' }).sid);
    bob = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: false, client: 'test' }).sid);
    lobby = withAchievementsDb(fx.ach, (db) => createRoom(db, ctx(alice)(db), { name: 'Lobby' }).id);
    withAchievementsDb(fx.ach, (db) => joinRoom(db, ctx(alice)(db), lobby));
  });
  afterEach(() => { for (const s of screens.splice(0)) s.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  it('a first entry with nothing unread shows the newest 100, not 30', () => {
    post(130, 0);
    const lines = shown(open());
    expect(lines).toContain('--- 100 earlier messages ---');
    expect(lines).toContain('m30');
    expect(lines).toContain('m129');
    expect(lines).not.toContain('m29');
  });

  it('a return after 150 unread shows every one of them', () => {
    post(10, 0);
    withAchievementsDb(fx.ach, (db) => { const c = ctx(bob)(db); joinRoom(db, c, lobby); markRead(db, c, lobby, { seq: roomHeadSeq(db, lobby) }); });
    post(150, 10);
    const lines = shown(open());
    expect(lines).toContain('--- 150 earlier messages ---');
    expect(lines).toContain('m10');
    expect(lines).toContain('m159');
    expect(lines).not.toContain('m9');
  });
});
