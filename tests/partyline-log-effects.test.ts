/**
 * Sysop 2026-11-25 (LOCAL): the format picker opened at the right edge, not over the selection, and
 * text effects did not show in the chat log. LIVECHAT places the picker at the selection
 * (server.ts getSelectionPosition) and renders the markup in the log.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom } from '../src/chat/store';
import { LIVE, newLine } from '../src/partyline/ui/model';
import { chatScreen } from '../src/partyline/ui/screen';
import { HIT_FMT } from '../src/partyline/ui/overlays';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('partyline format picker place and log effects', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 132, rows: 40, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const send = (s: string): void => { screen.input(Buffer.from(s, 'latin1')); screen.render(true); };
  const fill = (text: string): void => { screen.model.input = text; screen.model.inputCur = text.length; screen.model.inputAnchor = -1; screen.render(true); };

  it('the format picker opens over the selection, not at the right edge', () => {
    fill('hi there');
    send('\x1b[1;2H\x1b[15~'); // select the whole line from column 0, F5
    expect(screen.over.pickFmt).toBe(true);
    const hit = screen.drawState.hits.at(36 - 14 - 1 + 1, 0); // picker rows end just above the input text row
    expect(hit.id).toBe(HIT_FMT);
  });

  it('a rainbow effect paints each character its own colour and moves with the frame', () => {
    screen.model.addLine(newLine(LIVE, '', 'carol', '~rainbow~abcdef~/rainbow~ plain'));
    const out = (): string => screen.render(true).toString('latin1');
    screen.model.fxFrame = 0;
    const first = out();
    const fgs = new Set([...first.matchAll(/\x1b\[([0-9;]+)m[a-f]/g)].map((x) => x[1]));
    expect(fgs.size).toBeGreaterThanOrEqual(4);
    screen.model.fxFrame = 1;
    expect(out()).not.toBe(first);
  });
});

describe('partyline format picker demos each format', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 132, rows: 40, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  // Sysop 2026-11-25: the Effects list showed only the raw codes; each name now shows its own effect, the code after it.
  it('the Effects list paints Rainbow in rainbow colours that move, the code still readable', () => {
    screen.model.input = 'hi'; screen.model.inputCur = 2; screen.model.inputAnchor = -1; screen.render(true);
    screen.input(Buffer.from('\x1b[1;2H\x1b[15~', 'latin1')); screen.render(true);
    screen.over.pickCat = 1; // Effects
    screen.model.fxFrame = 0;
    const first = screen.render(true).toString('latin1');
    const m = /\x1b\[([0-9;]+)mR\x1b\[([0-9;]+)ma\x1b\[([0-9;]+)mi\x1b\[([0-9;]+)mn/.exec(first);
    expect(m).not.toBeNull();
    expect(new Set(m!.slice(1)).size).toBe(4);
    expect(first).toContain('~rainbow~text~/rainbow~'.slice(0, 15));
    screen.model.fxFrame = 1;
    expect(screen.render(true).toString('latin1')).not.toBe(first);
  });
});
