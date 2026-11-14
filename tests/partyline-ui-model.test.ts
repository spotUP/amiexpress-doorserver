/**
 * Hub engine line rules, ported from amiexpress-web sdk/c/tests/test_livechat_ui.c
 * (stamps_follow_the_pref, system_line_tone).
 */
import { Cells, cellCh, cellFg } from '../src/partyline/ui/cells';
import { Model, newLine, lineMarked, LIVE, SYSTEM } from '../src/partyline/ui/model';

describe('partyline engine line rules', () => {
  const m = new Model(80, 25);
  it('draws the time column only when stamps are on (stamps_follow_the_pref)', () => {
    const l = newLine(LIVE, '17:03', 'bob', 'hi');
    const on = lineMarked(m, l, true, 0), off = lineMarked(m, l, false, 0);
    expect(on).toContain('17:03');
    expect(off).not.toContain('17:03');
    expect(off).toContain('hi');
  });
  it('draws a toned system line in the tone inside a dim frame (system_line_tone)', () => {
    const l = newLine(SYSTEM, '', '', '[MOTD] Be nice');
    l.tone = m.pal.activity;
    const c = new Cells(100, 2), s = lineMarked(m, l, false, 100);
    c.marked(0, 0, s, 0, s.length, 100);
    const shown = Array.from(c.back.slice(0, 100), (w) => String.fromCharCode(cellCh(w) || 32)).join('');
    const at = shown.indexOf('[MOTD]');
    expect(shown).toContain('*** [MOTD] Be nice ***');
    expect([cellFg(c.back[at]), cellFg(c.back[at - 2]), cellFg(c.back[at + 15])]).toEqual([m.pal.activity, m.pal.dim, m.pal.dim]);
  });
});
