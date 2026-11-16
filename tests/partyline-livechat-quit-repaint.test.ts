/**
 * Quitting PL on a wide terminal leaked the whole chat screen into the board: the door's
 * disableWideMode makes the board go 80 columns, its resize reaches the hub AFTER the door
 * destroyed its blessed screen, and the hub's full repaint re-rendered that dead screen
 * at the old wide size. A destroyed screen must not repaint.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { forkLivechatChild } from '../src/partyline/livechat-host';
import type { ChildInit, FromChild } from '../src/partyline/livechat-child';

jest.setTimeout(30_000);

test('a repaint after the door destroyed its screen writes nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-quit-'));
  fs.mkdirSync(path.join(dir, 'dist/ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist/ui/screen.js'), 'exports.createScreen = () => ({ destroyed: false, render() { exports.bbs.write("PAINT"); exports.bbs.enableWideMode(); } });');
  fs.writeFileSync(path.join(dir, 'dist/server.js'), `
    const scr = require('./ui/screen.js');
    exports.createApp = (ctx) => { scr.bbs = ctx.bbs; const s = scr.createScreen(ctx.bbs);
      ctx.bbsSession.doorInputHandler = () => { s.destroyed = true; };
      return { run: () => new Promise((r) => setTimeout(r, 4000)) }; };`);
  const child = forkLivechatChild(dir, () => {});
  const got: FromChild[] = [];
  child.on('message', (m: FromChild) => got.push(m));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    const init: ChildInit = { t: 'init', doorDir: dir, user: 'u', access: 10, sysop: false, cols: 120, rows: 40, utf8: true, kitty: false, conn: 'web', wide: true };
    child.send(init);
    await wait(1500);
    child.send({ t: 'repaint' });
    await wait(300);
    expect(got.filter((m) => m.t === 'out' && m.s === 'PAINT')).toHaveLength(1);
    child.send({ t: 'input', s: 'q' });
    child.send({ t: 'repaint' });
    await wait(300);
    expect(got.filter((m) => m.t === 'out' && m.s === 'PAINT')).toHaveLength(1);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
