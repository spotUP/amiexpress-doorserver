/**
 * LIVECHAT68 disconnection dialog (livechat.c do_poll / reconnect_open / reconnect_retry): a failed
 * poll opens "Connection Error" with [ Retry ] / [ Cancel ]; clicks and R/C/Enter/Esc answer it
 * (the hub screen drew the dialog but never opened it, and swallowed clicks on it).
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
import { HIT_YES, HIT_NO, MODAL_NONE, MODAL_RECONNECT } from '../src/partyline/ui/overlays';
import * as events from '../src/chat/events';

describe('Partyline reconnect dialog', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  let quits = 0;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    quits = 0;
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => { quits++; }, sound: () => undefined }) as HubScreen;
    const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name: 'lobby' })) as unknown as { id?: string; room?: { id: string } };
    screen.joinRoom(r.id ?? r.room?.id ?? '');
    screen.render(true);
  });
  afterEach(() => { jest.restoreAllMocks(); screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const key = (s: string): void => { screen.input(Buffer.from(s, 'latin1')); screen.render(false); };
  const cellOf = (id: number): [number, number] => {
    for (let r = 0; r < 25; r++) for (let c = 0; c < 80; c++) if (screen.drawState.hits.at(r, c).id === id) return [r, c];
    throw new Error(`no hit ${id}`);
  };
  const click = (id: number): void => { const [r, c] = cellOf(id); key(`\x1b[<0;${c + 1};${r + 1}M\x1b[<0;${c + 1};${r + 1}m`); };

  const down = (): jest.SpyInstance => jest.spyOn(events, 'fetchVisibleEvents').mockImplementation(() => { throw new Error('database is closed'); });
  const texts = (): string[] => screen.model.lines.map((l) => l.text);

  it('a failed poll opens the dialog, and polling stays off while it is open', () => {
    const spy = down();
    screen.take();
    expect(screen.over.modal).toBe(MODAL_RECONNECT);
    expect(screen.over.modalAttempt).toBe(1);
    const calls = spy.mock.calls.length;
    screen.take();
    expect(spy.mock.calls.length).toBe(calls);
  });

  it('a click on [ Retry ] polls again and closes the dialog once the store answers', () => {
    const spy = down();
    screen.take();
    screen.render(false);
    spy.mockRestore();
    click(HIT_YES);
    expect(screen.over.modal).toBe(MODAL_NONE);
    expect(texts()).toContain('Reconnected to server!');
    expect(quits).toBe(0);
  });

  it('a failed Retry counts the attempt; past the maximum the caller leaves', () => {
    down();
    screen.take();
    screen.render(false);
    click(HIT_YES);
    expect(screen.over.modalAttempt).toBe(2);
    expect(screen.over.modalText).toBe('Reconnection failed');
    key('r');
    key('\r');
    expect(texts()).toContain('Maximum reconnection attempts reached. Please restart Partyline.');
    expect(quits).toBe(1);
  });

  it('a click on [ Cancel ] leaves the chat', () => {
    down();
    screen.take();
    screen.render(false);
    click(HIT_NO);
    expect(quits).toBe(1);
  });
});
