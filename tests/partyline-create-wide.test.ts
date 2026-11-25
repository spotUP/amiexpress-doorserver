/**
 * Partyline Create Channel form at the sysop's wide 209x61 layout, his exact keys
 * (2026-11-25 local test step 7): name, Tab, topic, Tab, Right (Voice), Tab, Space (Private), Tab, Tab, Enter.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom } from '../src/chat/store';
import { chatScreen } from '../src/partyline/ui/screen';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('Create Channel form, wide layout, Tab between fields', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 209, rows: 61, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined, sound: () => undefined }) as HubScreen;
    const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name: 'lobby' })) as unknown as { id?: string; room?: { id: string } };
    screen.joinRoom(r.id ?? r.room?.id ?? '');
    screen.render(true);
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const key = (s: string): void => { screen.input(Buffer.from(s, 'latin1')); screen.render(false); };

  it('creates a private voice channel and joins it with the topic in the pane label', () => {
    key('/create\r');
    for (const k of ['testroom', '\t', 'hello there', '\t', '\x1b[C', '\t', ' ', '\t', '\t']) key(k);
    expect(screen.over.createKind).toBe(1);
    expect(screen.over.createPriv).toBe(true);
    key('\r');
    expect(screen.over.create).toBe(false);
    expect(screen.model.room).toBe('testroom');
    expect(screen.model.paneLabel).toBe('testroom - hello there');
  });
});
