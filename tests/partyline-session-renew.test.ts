/**
 * A hub screen whose chat session row is gone (swept after a hub restart, or
 * expired elsewhere) renews its session instead of answering every action with
 * "the session is gone; start a new one" (sysop, 2026-11-25).
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, expireSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, roomMembers } from '../src/chat/store';
import { chatScreen, HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

it('a gone session row is renewed in the same room, and the session learns the new sid', () => {
  const chat = loadChatConfig();
  const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'spot', sysop: true, client: 'test' }).sid);
  const renewed: string[] = [];
  const screen = chatScreen(fx.ach, chat)({
    sid, user: `spot@${fx.boardId.toUpperCase()}`, boardId: fx.boardId,
    hello: { cols: 80, rows: 24, handle: 'spot', sysop: true, client: 'test' } as ScreenInfo['hello'],
    renewed: (s) => renewed.push(s), markDirty: () => undefined, quit: () => undefined,
  }) as HubScreen;
  try {
    let lobby = '';
    screen.run(true, (db, ctx) => { lobby = createRoom(db, ctx, { name: 'Lobby' }).id; });
    expect(screen.joinRoom(lobby)).toBe(true);
    // The hub restarted and the sweeper expired the row while the caller stayed in Partyline.
    withAchievementsDb(fx.ach, (db) => db.transaction(() => expireSession(db, sid))());
    const lines: string[] = [];
    const sys = screen.systemLine.bind(screen);
    screen.systemLine = (t: string) => { lines.push(t); sys(t); };
    const members = screen.tryRun(false, (db, ctx) => roomMembers(db, ctx, lobby).map((m) => m.user));
    expect(lines.filter((l) => /session is gone|timed out/.test(l))).toEqual([]);
    expect(members).toContain(`spot@${fx.boardId.toUpperCase()}`);
    expect(renewed).toHaveLength(1);
    expect(renewed[0]).not.toBe(sid);
    expect(screen.info.sid).toBe(renewed[0]);
  } finally {
    screen.close();
  }
});
