/**
 * The hub engine's overlays (help, view, modal, search, settings) draw cell for cell like the C LIVECHAT68
 * door. Fixture: tests/fixtures/partyline/lc68-overlays-c.txt, dumped by gen/lc-overlay-dump.c (rebuild
 * command in its header) from amiexpress-web sdk/c/examples/livechat/livechat_ui.c.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Cells } from '../src/partyline/ui/cells';
import { Model, FOCUS_INPUT, newLine, newSide, SYSTEM, HISTORY, LIVE, SIDE_HEAD, SIDE_ROOM, SIDE_USER } from '../src/partyline/ui/model';
import { draw, DrawState } from '../src/partyline/ui/draw';
import {
  OverlayState, MODAL_MESSAGE, MODAL_QUIT, MODAL_PROMPT, MODAL_RECONNECT, MODAL_PROGRESS, SET_CLOSE,
  progressBar, progressBytes, settingsLayout,
} from '../src/partyline/ui/overlays';

function mainState(cols: number, rows: number): Model {
  const m = new Model(cols, rows);
  m.focus = -1;
  m.handle = 'Guest'; m.room = 'general'; m.paneLabel = 'general - General chat';
  m.side.push(newSide(SIDE_HEAD, false, 'TEXT CHANNELS'), newSide(SIDE_ROOM, true, 'general'), newSide(SIDE_USER, false, 'carol'),
    newSide(SIDE_ROOM, false, 'amiga'), newSide(SIDE_ROOM, false, 'secret'));
  m.sideSel = 1;
  m.addLine(newLine(SYSTEM, '', '', 'Found 3 rooms'));
  m.addLine(newLine(HISTORY, '11:01', 'alice', 'hello world'));
  m.addLine(newLine(LIVE, '17:03', 'bob', 'nice **bold** and :D'));
  return m;
}

const slash = (o: OverlayState, m: Model, text: string): void => { m.focus = FOCUS_INPUT; m.input = text; m.inputCur = text.length; };

const SETUP: Record<string, (o: OverlayState, m: Model) => void> = {
  help: (o) => { o.help = true; },
  'help-scrolled': (o) => { o.help = true; o.helpTop = 12; },
  view: (o) => { o.view = true; o.viewTitle = 'Thread'; o.viewText = ['=alice 11:01', 'hello world', '  bob: a reply']; },
  'modal-message': (o) => { o.modal = MODAL_MESSAGE; o.modalTitle = 'Error'; o.modalText = 'Room not found'; },
  'modal-message-long': (o) => {
    o.modal = MODAL_MESSAGE; o.modalTitle = 'Error';
    o.modalText = 'This is a much longer message that has to wrap over more than one row of the box';
  },
  'modal-quit': (o) => { o.modal = MODAL_QUIT; o.modalTitle = 'Quit'; o.modalText = 'Leave the chat?'; },
  'modal-prompt': (o) => { o.modal = MODAL_PROMPT; o.modalTitle = 'Room name?'; o.prompt = 'a very long prompt answer that scrolls inside the field'; },
  'modal-reconnect': (o) => { o.modal = MODAL_RECONNECT; o.modalText = 'Retrying in 5s'; o.modalAttempt = 2; o.modalMax = 5; },
  'modal-progress': (o) => { o.modal = MODAL_PROGRESS; o.modalText = 'cat.iff'; o.upReceived = 1536000; o.upTotal = 2097152; },
  'modal-progress-unknown': (o) => { o.modal = MODAL_PROGRESS; o.modalText = 'dog.png'; o.upReceived = 700; o.upTotal = 0; },
  search: (o) => {
    o.search = true; o.searchField = 1; o.searchQ = 'hello'; o.searchUser = 'ali'; o.searchSel = 1;
    o.searchRows = ['11:01 alice: hello world', '12:00 alice: hello again', '13:30 alice: hello hello'];
  },
  settings: (o) => { o.settings = true; o.settingsSel = 3; o.settingsVal[0] = o.settingsVal[5] = o.settingsVal[7] = true; o.settingsStatus = 2; },
  'settings-close': (o) => { o.settings = true; o.settingsSel = SET_CLOSE; },
  slash: (o, m) => slash(o, m, '/'),
  'slash-jo': (o, m) => slash(o, m, '/jo'),
  'slash-mute': (o, m) => { slash(o, m, '/mute'); o.slashSel = 1; },
  'slash-scrolled': (o, m) => { slash(o, m, '/'); o.slashSel = 12; o.slashTop = 2; },
  'slash-off': (o, m) => { slash(o, m, '/'); o.slashOff = true; },
};

interface Case { name: string; cols: number; rows: number; cr: number; cc: number; words: number[] }

function cases(): Case[] {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/partyline/lc68-overlays-c.txt'), 'latin1').split('\n');
  const out: Case[] = [];
  for (let i = 0; i < text.length; i++) {
    const h = /^CASE (\S+) (\d+) (\d+) (-?\d+) (-?\d+)$/.exec(text[i]);
    if (!h) continue;
    const [cols, rows, cr, cc] = h.slice(2).map(Number), words: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (const run of text[++i].trim().split(' ')) {
        const [w, n] = run.split('*');
        for (let k = 0; k < (n ? Number(n) : 1); k++) words.push(parseInt(w, 16));
      }
    }
    out.push({ name: h[1], cols, rows, cr, cc, words });
  }
  return out;
}

describe('partyline engine overlays match the C door', () => {
  const all = cases();
  it('reads every case of the C dump', () => expect(all.length).toBe(Object.keys(SETUP).length * 3));
  it.each(all.map((k) => [k.name, k] as const))('%s', (_name, k) => {
    const tag = k.name.replace(/-\d+x\d+$/, ''), c = new Cells(k.cols, k.rows), o = new OverlayState();
    const m = mainState(k.cols, k.rows);
    SETUP[tag](o, m);
    const caret = draw(c, m, new DrawState(), o);
    expect(k.words.length).toBe(k.cols * k.rows);
    const diffs: string[] = [];
    for (let j = 0; j < k.words.length && diffs.length < 8; j++) {
      if (c.back[j] !== k.words[j]) diffs.push(`r${(j / k.cols) | 0} c${j % k.cols} want ${k.words[j].toString(16)} got ${c.back[j].toString(16)}`);
    }
    expect(diffs).toEqual([]);
    expect([caret.cr, caret.cc]).toEqual([k.cr, k.cc]);
  });
});

describe('partyline engine overlay helpers', () => {
  it('progress text matches the C (test_livechat_ui progress_dialog_text)', () => {
    expect(progressBar(56, 100, 32)).toBe('[#################...............]  56%');
    expect(progressBar(0, 100, 8)).toBe('[........]   0%');
    expect(progressBar(100, 100, 8)).toBe('[########] 100%');
    expect(progressBar(5, 0, 8)).toBe('[........]');
    expect(progressBytes(1153434, 2097152)).toBe('1.0 MB of 2.0 MB');
    expect(progressBytes(2048, 0)).toBe('2 KB');
  });
  it.each([80, 40])('the message modal wraps a long reason whole at %i cols (message_modal_wraps)', (cols) => {
    const c = new Cells(cols, 25), o = new OverlayState();
    o.modal = MODAL_MESSAGE; o.modalTitle = 'Error';
    o.modalText = 'Chat is offline. Try again later. (ae_net: connect to 127.0.0.1:3010 refused, errno 61)';
    draw(c, mainState(cols, 25), new DrawState(), o);
    let screen = '';
    for (let r = 0; r < 25; r++) screen += String.fromCharCode(...Array.from(c.back.subarray(r * cols, (r + 1) * cols), (w) => w & 0xff)).trimEnd() + '\n';
    for (const part of ['61)', '(ae_net:', 'offline.']) expect(screen).toContain(part);
  });
  it('settings layout gives up gaps on a short screen and keeps Close on the last row', () => {
    const tall = settingsLayout(80, 25), short = settingsLayout(80, 15);
    expect(tall.row[SET_CLOSE]).toBe(tall.h - 2 - 1 - 1);
    expect(short.h).toBe(15);
    expect(short.row[SET_CLOSE]).toBe(short.h - 3);
  });
});
