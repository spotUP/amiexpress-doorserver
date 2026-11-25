/**
 * The hub engine's "/" menu rules, ported from amiexpress-web sdk/c/tests/test_livechat_ui.c slash_menu_rules.
 * The drawn menu is grid-tested against the C in partyline-ui-overlays.test.ts (slash-* cases).
 */
import { CMD_HELP, slashMatch, slashRow, slashGhost, slashExact, slashComplete, slashScroll } from '../src/partyline/ui/slash';

const names = (input: string): string[] => slashMatch(input).map((i) => CMD_HELP[i][0]);

describe('partyline slash menu (slash_menu_rules)', () => {
  it('matches prefix first, then description, each by name', () => {
    expect(names('/jo')[0]).toBe('join');
    const all = names('/');
    expect(all.length).toBe(CMD_HELP.length);
    expect(CMD_HELP.length).toBe(60);
    expect([...all].sort()).toEqual(all);
    expect(names('/mute').slice(0, 2)).toEqual(['mute', 'deafen']);
    expect(names('/pin').slice(0, 2)).toEqual(['pin', 'pinned']);
    expect(names('/reaction')[0]).toBe('reactions');
    expect(names('/Away')[0]).toBe('away');
    for (const none of ['/zzzz', 'hello', '/join x']) expect(slashMatch(none)).toEqual([]);
  });
  it('lays out wide and compact rows', () => {
    const wide = slashRow(slashMatch('/ban')[0], 80);
    expect(wide.text.slice(0, 56)).toBe('/ban          /ban @user [reason]  Ban user from channel');
    expect([wide.ucol, wide.ulen]).toEqual([14, 20]);
    expect(slashRow(slashMatch('/ban')[0], 40)).toEqual({ text: '/ban Ban user from channel', ucol: 0, ulen: 0 });
    expect(slashRow(2, 20).text.length).toBe(16);
  });
  it('ghosts only a prefix match', () => {
    const jo = slashMatch('/jo');
    expect(slashGhost('/jo', jo)).toBe(jo[0]);
    expect(slashGhost('/', slashMatch('/'))).toBe(-1);
    const annel = slashMatch('/annel');
    expect(annel.length).toBeGreaterThan(0);
    expect(slashGhost('/annel', annel)).toBe(-1);
  });
  it('knows an exact or complete command', () => {
    expect([slashExact('/join', 10), slashExact('/joi', 10), slashExact('/join x', 10), slashExact('/JOIN ', 10)]).toEqual([true, false, false, true]);
    for (const yes of ['/share', '/file ', '/files', '/PICTURE']) expect(slashComplete(yes)).toBe(true);
    for (const no of ['/shar', '/share x', '/nosuchcmd']) expect(slashComplete(no)).toBe(false);
  });
  it('scrolls the selection into view', () => {
    expect([slashScroll(0, 0, 35), slashScroll(8, 0, 35), slashScroll(2, 5, 35), slashScroll(34, 0, 35), slashScroll(3, 0, 5)]).toEqual([0, 1, 2, 27, 0]);
  });
});
