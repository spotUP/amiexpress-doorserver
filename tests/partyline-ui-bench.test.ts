/**
 * Port of amiexpress-web sdk/c/tests/bench_livechat_wire.c run(): the same event sequence, and the hub's
 * cell diff must send no more bytes per frame than the C ui_cells_present. C numbers: fixtures/partyline/
 * bench-livechat-wire-c.json (built from the current C source). Also measures 30 sessions in one process.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Cells } from '../src/partyline/ui/cells';
import { Model, newLine, newSide, SYSTEM, LIVE, SIDE_HEAD, SIDE_ROOM, SIDE_USER, FOCUS_INPUT } from '../src/partyline/ui/model';
import { draw, DrawState } from '../src/partyline/ui/draw';

const NICKS = ['alice', 'bob', 'carol', 'Spot', 'zed_the_long_nick'];
const SAYS = ['hello world',
  'this is a long line that should wrap around the chat pane width for sure yes indeed',
  'hi sysop, how are you?', 'nice **bold** and :D', 'did anyone try the new door yet? it is fast on my A1200', 'ok',
  'brb, _coffee_',
  'the quick brown fox jumps over the lazy dog and keeps running until the line wraps twice on a narrow pane, as lines do'];

class Bench {
  m: Model; c: Cells; d = new DrawState(); said = 0; out: Record<string, number> = {};
  constructor(cols: number, rows: number, readonly useScroll: boolean) {
    const m = this.m = new Model(cols, rows);
    m.focus = FOCUS_INPUT; m.handle = 'Guest';
    m.side.push(newSide(SIDE_HEAD, false, 'TEXT CHANNELS'), newSide(SIDE_ROOM, true, 'general'), newSide(SIDE_USER, false, 'carol'),
      newSide(SIDE_USER, false, 'alice'), newSide(SIDE_ROOM, false, 'amiga'), newSide(SIDE_ROOM, false, 'secret'));
    m.sideSel = 1;
    this.room('general', 3);
    this.c = new Cells(cols, rows);
  }
  say(): void {
    const s = this.said++;
    this.m.addLine(newLine(LIVE, `17:${String(s % 60).padStart(2, '0')}`, NICKS[s % 5], SAYS[s % 8]));
  }
  room(name: string, lines: number): void {
    this.m.room = name; this.m.paneLabel = `${name} - ${name} chat`;
    this.m.lines = []; this.m.scroll = 0;
    this.m.addLine(newLine(SYSTEM, '', '', 'Joined the room (3 users)'));
    for (let i = 0; i < lines; i++) this.say();
  }
  type(s: string): void { const m = this.m; m.input = m.input.slice(0, m.inputCur) + s + m.input.slice(m.inputCur); m.inputCur += s.length; }
  present(what?: string): number {
    const { m, c, d } = this;
    const { cr, cc } = draw(c, m, d);
    if (this.useScroll && d.chatRows > 1 && m.sidebarWidth() === 0) c.scrollArea(d.chatBody, d.chatBody + d.chatRows, d.chatLeft, d.chatLeft + d.chatWidth);
    else c.scrollArea(0, 0, 0, 0);
    const n = c.present(m.focus === FOCUS_INPUT && m.menu < 0, cr, cc).length;
    if (what) this.out[what] = n;
    return n;
  }
  run(): Record<string, number> {
    const m = this.m;
    let total = 0;
    this.present('first frame (full repaint)');
    this.present('idle (nothing changed)');
    this.type('h'); this.present('type 1 char');
    for (let i = 0; i < 20; i++) { this.type('e'); total += this.present(); }
    this.out['type 20 chars at the end'] = Math.trunc(total / 20);
    m.inputCur = 5; this.present('caret moved (Left x16)');
    this.type('X'); this.present('insert 1 char mid-line');
    m.input = ''; m.inputCur = 0; this.present('send (input cleared)');
    this.say(); this.present('message arrives, pane not full');
    for (let i = 0; i < 30; i++) this.say();
    this.present('30 messages arrive (one frame)');
    total = 0;
    for (let i = 0; i < 16; i++) { this.say(); total += this.present(); }
    this.out['message arrives, pane full (x16)'] = Math.trunc(total / 16);
    m.typing = [{ nick: 'bob', text: 'typ' }]; this.present('typing preview appears');
    m.typing = []; this.present('typing preview goes');
    m.scroll = 1; this.present('scroll back 1 row');
    m.scroll = 9; this.present('scroll back 8 more rows');
    m.scroll = 0; this.present('scroll to newest');
    m.menu = 0; m.menuSel = 0; this.present('open Chat menu');
    m.menuSel = 1; this.present('menu: next item');
    m.menu = -1; this.present('close menu');
    m.sideSel = 4;
    m.side[1].joined = false; m.side[1].open = false; m.side[4].joined = true; m.side[4].open = true;
    this.room('amiga', 25); this.present('switch channel');
    this.c.invalidate(); this.present('resize / full repaint');
    return this.out;
  }
}

const C = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/partyline/bench-livechat-wire-c.json'), 'utf8')) as
  { cases: Record<string, Record<string, number>> };

describe('partyline ui: wire bytes vs the C ui_cells_present', () => {
  const rows: string[] = [];
  afterAll(() => { if (process.env.PARTYLINE_BENCH_REPORT) fs.writeFileSync(process.env.PARTYLINE_BENCH_REPORT, rows.join('\n') + '\n'); });
  for (const [cols, scroll] of [[80, false], [40, false], [80, true], [40, true]] as const) {
    const key = `${cols}x25 ${scroll ? 'scroll' : 'noscroll'}`;
    it(`${key}: every case sends <= the C bytes`, () => {
      const ts = new Bench(cols, 25, scroll).run(), want = C.cases[key];
      const over: string[] = [];
      for (const [name, cBytes] of Object.entries(want)) {
        rows.push(`${key} | ${name} | ts ${ts[name]} | c ${cBytes}`);
        if (!(ts[name] <= cBytes)) over.push(`${name}: ts ${ts[name]} c ${cBytes}`);
      }
      expect(Object.keys(ts).sort()).toEqual(Object.keys(want).sort());
      expect(over).toEqual([]);
    });
  }

  it('30 sessions in one process: memory and per-frame time', () => {
    const gc = (global as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    const sessions = Array.from({ length: 30 }, (_, i) => new Bench(i % 2 ? 40 : 80, 25, false));
    for (const s of sessions) { for (let i = 0; i < 80; i++) s.say(); s.present(); }
    gc?.();
    const heap = process.memoryUsage().heapUsed - before;
    const frames = 100;
    const t0 = process.hrtime.bigint();
    for (let f = 0; f < frames; f++) for (const s of sessions) { s.m.input = String.fromCharCode(97 + (f & 7)); s.m.inputCur = 1; s.present(); }
    const keyUs = Number(process.hrtime.bigint() - t0) / 1e3 / (frames * 30);
    const t1 = process.hrtime.bigint();
    for (let f = 0; f < frames; f++) for (const s of sessions) { s.say(); s.present(); }
    const msgUs = Number(process.hrtime.bigint() - t1) / 1e3 / (frames * 30);
    const line = `30 sessions: heap +${(heap / 1048576).toFixed(2)} MB (gc ${gc ? 'yes' : 'no'}), key frame ${keyUs.toFixed(1)} us, message frame ${msgUs.toFixed(1)} us`;
    rows.push(line);
    expect(sessions.length).toBe(30);
  });
});
