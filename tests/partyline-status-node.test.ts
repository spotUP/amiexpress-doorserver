/**
 * LIVECHAT status bar parity: "@handle | Node N | ..." shows the caller's own board node
 * (core/initialization.ts nodeId = bbsSession.nodeId || 1), not a fixed Node 1 for everyone.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { chatScreen } from '../src/partyline/ui/screen';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('hub screen status bar node', () => {
  let fx: AchievementsFixture;
  const open: HubScreen[] = [];
  beforeEach(() => { fx = makeAchievementsFixture(); });
  afterEach(() => { for (const s of open.splice(0)) s.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const screenFor = (handle: string, node?: number): HubScreen => {
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle, sysop: false, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true, ...(node !== undefined ? { node } : {}) } as ScreenInfo['hello'];
    const s = chatScreen(fx.ach, chat)({ sid, user: handle, boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined, sound: () => undefined }) as HubScreen;
    open.push(s);
    return s;
  };

  it('each caller sees the node the board sent in the hello', () => {
    expect(screenFor('sysop', 1).model.node).toBe(1);
    expect(screenFor('plstack1', 2).model.node).toBe(2);
  });

  it('a hello without a node falls back to Node 1 as LIVECHAT does', () => {
    expect(screenFor('bob').model.node).toBe(1);
  });
});
