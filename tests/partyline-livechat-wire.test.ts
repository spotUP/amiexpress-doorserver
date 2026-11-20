/**
 * Per-keystroke wire cost on the LIVECHAT engine path: the door re-asserts the
 * same SGR per fragment (~1 KB/keystroke where the hub screen costs ~1 byte),
 * so the host drops SGR runs byte-identical to the one already in effect.
 * Same visible bytes, fewer wire bytes.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { SgrDedupe } from '../src/partyline/livechat-wire';
import { livechatScreen } from '../src/partyline/livechat-host';
import { renderParts } from '../src/partyline/session';
import type { PartylineScreen, ScreenInfo } from '../src/partyline/session';
import { makeAchievementsFixture } from './achievements/helpers';

jest.setTimeout(30_000);

test('SgrDedupe drops only byte-identical SGR repeats', () => {
  const w = new SgrDedupe();
  // First run stays; the repeat after a cursor move and text goes.
  expect(w.filter('\x1b[24;2H\x1b[0;48;5;204;30m///\x1b[1;57H\x1b[0;48;5;204;30m///')).toBe(
    '\x1b[24;2H\x1b[0;48;5;204;30m///\x1b[1;57H///');
  // A different SGR stays and becomes the new baseline.
  expect(w.filter('\x1b[0;49;38;5;255m<')).toBe('\x1b[0;49;38;5;255m<');
  expect(w.filter('\x1b[0;49;38;5;255m')).toBe('');
  // RIS resets the rendition: the same bytes afterwards are needed again.
  expect(w.filter('\x1bc\x1b[0;49;38;5;255m')).toBe('\x1bc\x1b[0;49;38;5;255m');
  // Printables and non-SGR escapes pass through untouched.
  expect(w.filter('hello')).toBe('hello');
  expect(w.filter('\x1b[?25l\x1b[?25l')).toBe('\x1b[?25l\x1b[?25l');
});

test('one keystroke forwards every visible byte with no repeat SGR', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-wire-'));
  fs.mkdirSync(path.join(dir, 'dist/ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist/ui/screen.js'), 'exports.createScreen = () => ({ render() {} });');
  // A burst shaped like the real door's per-key repaint: echo, typing
  // preview, and a glitch header that re-asserts its SGR per fragment.
  const PINK = '\x1b[0;48;5;204;30m';
  const BURST = `\x1b[24;2H\x1b[0;1mh\x1b[0;1morem \x1b[1;51H${PINK}///\x1b[1;57H${PINK}///`;
  fs.writeFileSync(path.join(dir, 'dist/server.js'), `
    exports.createApp = (ctx) => {
      ctx.bbs.write('READY');
      ctx.bbsSession.doorInputHandler = (d) => { if (d === 'h') ctx.bbs.write(${JSON.stringify(BURST)}); };
      return { run: () => new Promise(() => {}) };
    };`);
  const fx = makeAchievementsFixture();
  const chat = loadChatConfig();
  const logs: string[] = [];
  let s: PartylineScreen | undefined;
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    s = livechatScreen(fx.ach, chat, dir, (l) => logs.push(l))({
      sid, user: 'bob', boardId: fx.boardId,
      hello: { cols: 80, rows: 25 } as ScreenInfo['hello'], markDirty: () => {}, quit: () => {},
    });
    const text = (): string => renderParts(s!.render(false)).filter((p) => p.type === 'D').map((p) => p.bytes.toString('latin1')).join('');
    const end = Date.now() + 20_000;
    let seen = '';
    while (!seen.includes('READY')) {
      if (Date.now() > end) throw new Error(`timed out waiting for READY; logs:\n${logs.slice(-10).join('\n')}`);
      await wait(100);
      seen += text();
    }
    text(); // drain
    s.input(Buffer.from('h', 'latin1'));
    await wait(800);
    const got = text();
    const pink = PINK.replace(/\[/g, '\\[');
    expect(got.match(new RegExp(pink, 'g'))).toHaveLength(1);
    expect(got).toBe(`\x1b[24;2H\x1b[0;1mhorem \x1b[1;51H${PINK}///\x1b[1;57H///`);
    expect(got.length).toBeLessThan(BURST.length);
  } finally {
    s?.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
    _stopChatSweepersForTests();
    fx.cleanup();
  }
});
