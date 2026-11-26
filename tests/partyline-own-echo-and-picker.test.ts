/**
 * Telnet run 5: the caller's own typing row showed "[]" (typingTime never set; livechat.c present stamps it each frame),
 * and the format picker had to close on Enter over a telnet line ending (CR NUL / CR LF), as LIVECHAT's CategoryPicker does.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { chatScreen, stamp } from '../src/partyline/ui/screen';
import { typingMarked } from '../src/partyline/ui/model';
import { wrap } from '../src/partyline/ui/cells';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('Partyline own typing row and format picker', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const send = (s: string): void => { screen.input(Buffer.from(s, 'latin1')); screen.render(true); };
  const fill = (text: string): void => { screen.model.input = text; screen.model.inputCur = text.length; screen.model.inputAnchor = -1; screen.render(true); };

  it('the own typing row carries the time of the frame, never an empty []', () => {
    screen.typingSet('bob', 'fmt word');
    screen.render(true);
    const row = typingMarked(screen.model, screen.model.typing[0]).replace(/[\x00-\x1f\x7f-\xff]./g, '');
    expect(screen.model.typingTime).toBe(stamp(Math.floor(Date.now() / 1000)));
    expect(row).not.toContain('[]');
  });

  // Sysop: a rainbow on the unsent line showed its ~rainbow~ markers in the own typing row, and the row jumped a line with the blink.
  it('the typing row draws effects as the input does and keeps its height through the cursor blink', () => {
    const plain = (t: string): string => t.replace(/[\x00-\x1f\x7f-\xff]./g, '');
    screen.typingSet('bob', '~rainbow~hi there~/rainbow~ {red-fg}x{/red-fg}');
    screen.render(true);
    expect(plain(typingMarked(screen.model, screen.model.typing[0]))).not.toMatch(/~|\{/);
    for (let n = 1; n < 160; n++) {
      screen.typingSet('bob', 'w'.repeat(n));
      const rows = [false, true].map((b) => { screen.model.typingBlink = b; return wrap(typingMarked(screen.model, screen.model.typing[0]), 78, 8).length; });
      expect(rows[1]).toBe(rows[0]);
    }
  });

  it.each([['CR NUL', '\r\0'], ['CR LF', '\r\n']])('the format picker applies and closes on Enter over %s', (_n, enter) => {
    fill('fmt word');
    send('\x1b[1;2D\x1b[1;2D\x1b[1;2D\x1b[1;2D\x1b[15~');
    expect(screen.over.fmt).toBe(true);
    send(enter + enter); // Colors, then Red
    expect(screen.over.fmt).toBe(false);
    expect(screen.model.input).toBe('fmt {red-fg}word{/red-fg}');
  });

  it('Tab to the items and Enter applies and closes', () => {
    fill('fmt word');
    send('\x1b[1;2D\x1b[1;2D\x1b[1;2D\x1b[1;2D\x1b[15~');
    send('\t\r\0');
    expect(screen.over.fmt).toBe(false);
    expect(screen.model.input).toBe('fmt {red-fg}word{/red-fg}');
  });
});
