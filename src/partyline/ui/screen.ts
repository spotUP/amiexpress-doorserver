/**
 * Partyline hub engine: one caller's screen. The model, the draw and the cell
 * diff are the C livechat ports (model.ts, draw.ts, cells.ts); this file feeds
 * them from the chat store the /chat/v1 router uses, so a Partyline caller and
 * a /chat/v1 client read and write the same rooms.
 *
 * Events arrive through events.ts onEvents (told after each commit, like a held
 * poll); the screen then fetches what this session may see since its cursor,
 * the way livechat.c take_events reads a poll reply.
 */
import type Database from 'better-sqlite3';
import { StringDecoder } from 'string_decoder';
import { withAchievementsDb } from '../../achievements/db';
import type { AchievementsConfig } from '../../achievements/config';
import { SurfaceError } from '../../achievements/errors';
import type { ChatConfig } from '../../chat/config';
import { fetchVisibleEvents, headSeq, onEvents } from '../../chat/events';
import type { EventRec } from '../../chat/events';
import { newId, resolveSession } from '../../chat/sessions';
import type { ChatCtx } from '../../chat/sessions';
import { joinRoom, listMemberships, listRooms, postMessage, roomHistory, roomMembers } from '../../chat/store';
import type { PartylineScreen, ScreenFactory, ScreenInfo } from '../session';
import { Cells } from './cells';
import { draw, DrawState, HIT_DROPDOWN, HIT_MENU, HIT_SCROLLBAR, HIT_SIDEBAR, HIT_STATUS, HIT_INPUT, MENU_COL, MENU_ITEMS, MENU_LABELS } from './draw';
import { ACTIVITY_LINE, FOCUS_INPUT, FOCUS_MENU, HISTORY, LIVE, Model, newLine, newSide, SIDE_BLANK, SIDE_HEAD, SIDE_ROOM, SIDE_USER, SYSTEM, TEXT_MAX } from './model';
import { HIT_FMT, HIT_FMT_CAT, HIT_FMT_CLOSE, HIT_FMT_ITEM, MODAL_NONE, MODAL_QUIT, formatItems, OverlayState, pickCats, pickList, pickMove } from './overlays';
import { CMD_HELP, slashComplete, slashGhost, slashMatch, slashScroll } from './slash';
import { allEmoji, loadCustomEmoji, runCommand } from '../commands';

/** ui_key.h codes. */
export const K_UP = 1000, K_DOWN = 1001, K_PGUP = 1002, K_PGDN = 1003, K_HOME = 1004, K_END = 1005, K_ENTER = 1006, K_ESC = 1007,
  K_LEFT = 1008, K_RIGHT = 1009, K_BACKTAB = 1010, K_F1 = 1011, K_F4 = 1014, K_F5 = 1015, K_DEL = 1020,
  K_SLEFT = 1021, K_SRIGHT = 1022, K_SHOME = 1023, K_SEND = 1024, K_SUP = 1025, K_SDOWN = 1026;
const KEY_SEQ: Record<string, number> = {
  '\x1b[A': K_UP, '\x1b[B': K_DOWN, '\x1b[C': K_RIGHT, '\x1b[D': K_LEFT, '\x1b[H': K_HOME, '\x1b[F': K_END,
  '\x1b[5~': K_PGUP, '\x1b[6~': K_PGDN, '\x1bOP': K_F1, '\x1bOS': K_F4, '\x1b[14~': K_F4, '\x1b[Z': K_BACKTAB, '\x1b[1~': K_HOME, '\x1b[4~': K_END,
  '\x1b[3~': K_DEL, '\x1b[15~': K_F5,
  // xterm shift forms (CSI 1;2X, the board's composed-key.ts) and rxvt's lower-case ones: the input selection (textbox.ts).
  '\x1b[1;2D': K_SLEFT, '\x1b[d': K_SLEFT, '\x1b[1;2C': K_SRIGHT, '\x1b[c': K_SRIGHT, '\x1b[1;2H': K_SHOME, '\x1b[1;2F': K_SEND,
  '\x1b[1;2A': K_SUP, '\x1b[a': K_SUP, '\x1b[1;2B': K_SDOWN, '\x1b[b': K_SDOWN,
};

export type ChatRun = <T>(write: boolean, fn: (db: Database.Database, ctx: ChatCtx) => T) => T;

/** "HH:MM" of a unix second, the C line stamp. */
export function stamp(at: number): string {
  const d = new Date(at * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class HubScreen implements PartylineScreen {
  readonly model: Model;
  cells: Cells;
  readonly drawState = new DrawState();
  readonly over = new OverlayState();
  /** The room the caller is in (livechat.c room_id); '' before the first join. */
  roomId = '';
  /** Custom emoji with a picture and no ascii face: the picker lists them by :name:, a message cannot expand them. */
  imageEmoji: string[] = [];
  private cursor = 0;
  private readonly off: () => void;

  /** Pictures and files the hub announced this session (livechat.c shared_files[], 1-based /view N). */
  readonly shared: { id: string; name: string; kind: string }[] = [];
  /** The caller's bytes are UTF-8 (hello charset); latin1 callers keep the byte path. */
  private readonly utf8: boolean;
  /** A UTF-8 glyph can straddle two K frames; the decoder holds the half glyph. */
  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly ach: AchievementsConfig, private readonly chat: ChatConfig, readonly info: ScreenInfo, readonly filesDir: string | null = null) {
    this.model = new Model(info.hello.cols, info.hello.rows);
    this.cells = new Cells(info.hello.cols, info.hello.rows);
    this.model.handle = info.user;
    this.model.setSelf(info.user);
    this.utf8 = info.hello.charset === 'utf8';
    this.cursor = withAchievementsDb(ach, (db) => headSeq(db));
    this.firstRoom();
    this.fillSidebar();
    this.off = onEvents(() => this.take());
  }

  /** One store call as this session, in a transaction when it writes (router.ts run). */
  run: ChatRun = (write, fn) => withAchievementsDb(this.ach, (db) => {
    const ctx = resolveSession(db, this.chat, this.info.sid, this.info.boardId);
    return write ? db.transaction(() => fn(db, ctx))() : fn(db, ctx);
  });

  /** A store refusal is a system line (livechat.c show_error), never a dropped caller. */
  tryRun<T>(write: boolean, fn: (db: Database.Database, ctx: ChatCtx) => T): T | undefined {
    try {
      return this.run(write, fn);
    } catch (err) {
      if (!(err instanceof SurfaceError)) throw err;
      this.systemLine(err.message);
      return undefined;
    }
  }

  /** The last message number handed to a pane line (C msg_number); line_by_number looks it up. */
  msgNumber = 0;
  /** /events and /sounds, kept for the session (livechat.c ev_* and snd_on; the hub stores no prefs). */
  readonly prefs = { sounds: true, events: { logins: true, files: true, doors: true, messages: true, announcements: true } as Record<string, boolean> };

  systemLine(text: string): void { this.note(SYSTEM, text); }
  note(kind: number, text: string): void {
    this.model.addLine(newLine(kind, '', '', text));
    this.info.markDirty();
  }

  /** livechat.c start: the first room the caller is a member of, else the first listed room. */
  private firstRoom(): void {
    const id = this.tryRun(false, (db, ctx) => listMemberships(db, ctx)[0]?.roomId ?? listRooms(db, ctx)[0]?.id ?? '');
    if (id) this.joinRoom(id);
    loadCustomEmoji(this);
  }

  /** livechat.c join_room: switch rooms, clear the lines, say so. */
  joinRoom(id: string): boolean {
    const r = this.tryRun(true, (db, ctx) => joinRoom(db, ctx, id));
    if (!r) return false;
    this.roomId = r.id;
    this.model.room = r.name;
    this.model.paneLabel = r.topic ? `${r.name.slice(0, 40)} - ${r.topic.slice(0, 50)}` : r.name;
    this.model.lines = [];
    this.model.linesChanged();
    this.msgNumber = 0;
    this.cursor = Math.max(this.cursor, r.since);
    this.systemLine(`Joined #${r.name.slice(0, 40)} (${r.members} users)`);
    this.note(ACTIVITY_LINE, `Joined #${r.name.slice(0, 40)}`);
    this.takeHistory(r.id);
    this.fillSidebar();
    return true;
  }

  /**
   * The sidebar the livechat engine used to fill: joined rooms with unreads,
   * then the users in this room. Only marks dirty when something changed,
   * so an unrelated event does not repaint anyone.
   */
  private fillSidebar(): void {
    const m = this.model;
    const data = this.tryRun(false, (db, ctx) => ({
      rooms: listMemberships(db, ctx),
      users: this.roomId !== '' ? roomMembers(db, ctx, this.roomId) : [],
    }));
    if (!data) return;
    const sel = m.side[m.sideSel];
    const selKey = sel !== undefined ? `${sel.kind}:${sel.label}` : '';
    const side = [newSide(SIDE_HEAD, false, 'TEXT CHANNELS')];
    for (const r of data.rooms) {
      const it = newSide(SIDE_ROOM, r.roomId === this.roomId, r.name.slice(0, 36));
      it.id = r.roomId;
      it.unread = r.unread;
      side.push(it);
    }
    if (data.users.length > 0) {
      side.push(newSide(SIDE_HEAD, false, 'USERS'));
      for (const u of data.users) {
        const it = newSide(SIDE_USER, false, u.user.split('@')[0].slice(0, 38));
        it.note = (u.statusText ?? '').slice(0, 14);
        it.status = u.status === 'online' ? 1 : 0;
        side.push(it);
      }
    }
    const same = (a: typeof side, b: typeof m.side): boolean =>
      a.length === b.length && a.every((s, i) => s.kind === b[i].kind && s.label === b[i].label && s.unread === b[i].unread && s.joined === b[i].joined && s.note === b[i].note && s.status === b[i].status);
    if (same(side, m.side)) return;
    m.side = side;
    m.sideSel = Math.max(0, side.findIndex((s) => `${s.kind}:${s.label}` === selKey));
    this.info.markDirty();
  }

  /** livechat.c take_history: the newest HISTORY_LIMIT (30) messages, numbered like live lines so /reply, /edit and /react reach them. */
  private takeHistory(id: string): void {
    const rows = this.tryRun(false, (db, ctx) => roomHistory(db, ctx, id, { limit: 30 })) ?? [];
    if (rows.length === 0) return;
    this.systemLine(`--- ${rows.length} earlier message${rows.length === 1 ? '' : 's'} ---`);
    for (const h of rows) {
      const l = newLine(HISTORY, stamp(h.at), h.user, h.text);
      l.id = h.id;
      l.number = ++this.msgNumber;
      this.model.addLine(l);
    }
    this.info.markDirty();
  }

  /** livechat.c send_room_line: the line goes to the store; the event brings it back on screen. */
  sendRoomLine(text: string, replyTo?: string): void {
    if (!this.roomId) { this.systemLine('Join a channel first: /join room'); return; }
    this.tryRun(true, (db, ctx) => postMessage(db, ctx, this.roomId, { content: text, clientId: newId('pl'), ...(replyTo ? { replyTo } : {}) }));
  }

  /** take_events: the events this session may see since the cursor. */
  take(): void {
    let rows: EventRec[];
    try {
      rows = withAchievementsDb(this.ach, (db) => fetchVisibleEvents(db, this.info.sid, this.info.user, this.cursor, this.info.boardId));
    } catch {
      return; // the database is closing (shutdown): the next commit retries
    }
    if (rows.length === 0) return;
    let side = false;
    for (const e of rows) {
      this.cursor = e.seq;
      this.event(e);
      if (e.type === 'message' || e.type === 'joined' || e.type === 'left' || e.type === 'presence' ||
        e.type === 'room_created' || e.type === 'room_deleted' || e.type === 'dm') side = true;
    }
    if (side) this.fillSidebar();
    this.info.markDirty();
    if (rows.length > 0) this.take();
  }

  private event(e: EventRec): void {
    const inRoom = this.roomId !== '' && e.room_id === this.roomId;
    const m = this.model;
    if (e.type === 'message' && inRoom) {
      const l = newLine(LIVE, stamp(e.at), e.user, e.text);
      l.id = e.ref;
      l.number = ++this.msgNumber; // livechat.c msg_number: the number a user types in /reply, /react ...
      m.addLine(l);
    } else if ((e.type === 'joined' || e.type === 'left') && inRoom) {
      const joined = e.type === 'joined';
      m.addLine(newLine(SYSTEM, '', '', `${e.user.slice(0, 24)} ${joined ? 'joined' : 'left'} the room`));
      m.addLine(newLine(ACTIVITY_LINE, '', '', `${e.user.slice(0, 24)} ${joined ? 'joined' : 'left'}`));
    } else if (e.type === 'edit') {
      const l = m.lines.find((x) => x.id === e.ref);
      if (l) { l.text = e.text; l.edited = true; m.linesChanged(); }
    } else if (e.type === 'delete') {
      const i = m.lines.findIndex((x) => x.id === e.ref);
      if (i >= 0) { m.lines.splice(i, 1); m.linesChanged(); }
    } else if (e.type === 'file_shared') {
      // livechat.c shared_add: text is "name|size|kind", the ref is the file id; only a picture says anything.
      const [name = '', , kind = ''] = e.text.split('|');
      if (e.ref && this.shared.length < 64) {
        this.shared.push({ id: e.ref, name: name.slice(0, 63), kind: kind.slice(0, 11) });
        if (kind === 'image') m.addLine(newLine(SYSTEM, '', '', `${e.user.slice(0, 30)} shared a picture: ${name.slice(0, 60)} (/view)  #${this.shared.length} [PICTURE] ${name.slice(0, 60)}`));
      }
    } else if (e.type === 'topic' && inRoom) {
      m.paneLabel = `${m.room.slice(0, 40)} - ${e.text.slice(0, 50)}`;
      m.addLine(newLine(SYSTEM, '', '', `${(e.user || 'Someone').slice(0, 24)} set the topic: ${e.text.slice(0, 200)}`));
    }
  }

  resize(cols: number, rows: number): void {
    this.model.resize(cols, rows);
    this.cells = new Cells(cols, rows);
  }

  private esc = '';

  /** Bytes to keys (ui_key.h codes): ESC [ A..D, ESC [5~ / [6~, H / F, CR, BS/DEL, Tab, printable latin1. */
  input(bytes: Buffer): void {
    if (this.utf8) {
      // Text goes through the UTF-8 decoder; ESC and any bytes while an ESC
      // sequence is open stay raw so legacy X10 mouse coordinates (which can
      // carry high bytes) still reach the byte-level mouse parser.
      let at = 0;
      while (at < bytes.length && !this.quitting) {
        if (this.esc !== '' || bytes[at] === 0x1b) {
          this.inputByte(bytes[at++]);
          continue;
        }
        let end = at;
        while (end < bytes.length && bytes[end] !== 0x1b) end++;
        for (const ch of this.decoder.write(bytes.subarray(at, end))) {
          const cp = ch.codePointAt(0) as number;
          if (cp < 0x80) this.inputByte(cp);
          else this.insertChar(ch);
          if (this.quitting) break;
        }
        at = end;
      }
      this.info.markDirty();
      return;
    }
    this.inputBytes(bytes);
  }

  /** One non-ASCII glyph straight into the input line (no ESC decoding up here). */
  private insertChar(ch: string): void {
    const m = this.model, o = this.over;
    if (o.modal !== MODAL_NONE || o.fmt || o.help) return;
    if (m.focus === FOCUS_INPUT) this.slashKey(ch.codePointAt(0) as number);
    this.cutSelection();
    if (m.input.length + ch.length < TEXT_MAX) {
      m.input = m.input.slice(0, m.inputCur) + ch + m.input.slice(m.inputCur);
      m.inputCur += ch.length;
      o.slashOff = false;
    }
  }

  private inputBytes(bytes: Buffer): void {
    for (const b of bytes) {
      this.inputByte(b);
      if (this.quitting) return;
    }
    this.info.markDirty();
  }

  /** One byte through the ESC machine and into key(). */
  private inputByte(b: number): void {
    if (this.esc !== '') {
      // X10 mouse (\x1b[M Cb Cx Cy): old terminals answer without SGR even
      // after ?1006h; swallow the report as a click instead of typing it.
      if (this.esc[1] === '[' && this.esc[2] === 'M') {
        if (b === 0x1b) { this.esc = '\x1b'; return; }
        this.esc += String.fromCharCode(b);
        if (this.esc.length < 6) return;
        const [cb, cx, cy] = [...this.esc].map((c) => c.charCodeAt(0)).slice(-3);
        this.esc = '';
        this.legacyMouse(cb, cx - 32, cy - 32, false);
        return;
      }
      // urxvt mouse (\x1b[Cb;Cx;Cy M|m): same treatment on the M terminator.
      if (b === 0x4d || b === 0x6d) {
        const m = /^\x1b\[(\d+);(\d+);(\d+)$/.exec(this.esc);
        if (m) {
          this.esc = '';
          this.legacyMouse(Number(m[1]), Number(m[2]), Number(m[3]), b === 0x6d);
          return;
        }
      }
      this.esc += String.fromCharCode(b);
      if (this.esc.startsWith('\x1b[<')) { // SGR mouse report ESC [ < button ; col ; row M|m
        if (b === 0x4d || b === 0x6d) { const e = this.esc; this.esc = ''; this.mouse(e, b === 0x4d); } else if (this.esc.length > 24) this.esc = '';
        return;
      }
      const k = KEY_SEQ[this.esc];
      // A urxvt mouse report (\x1b[Cb;Cx;Cy M) is longer than the key
      // sequences the drop below assumes; while it still parses as digits
      // and semicolons, wait for its M terminator instead of dropping it.
      if (k === undefined && /^\x1b\[\d+(;\d*){0,2}$/.test(this.esc) && this.esc.length <= 16) return;
      if (k !== undefined) { this.esc = ''; this.key(k); } else if (this.esc.length >= 4 || (this.esc.length >= 2 && this.esc[1] !== '[' && this.esc[1] !== 'O')) {
        // shortcut: an unknown sequence is dropped whole; a lone Esc is seen only when the next byte is not '['.
        const lone = this.esc.length === 2 && this.esc[1] !== '[' && this.esc[1] !== 'O';
        this.esc = '';
        if (lone) { this.key(K_ESC); this.input(Buffer.from([b])); }
      }
      return;
    }
    if (b === 0x1b) { this.esc = '\x1b'; return; }
    this.key(b === 0x0d ? K_ENTER : b === 0x7f ? 8 : b);
  }

  /**
   * X10 and urxvt both carry Cb = 32 + button (+ modifier/motion bits); low bits 3 without
   * the motion bit is a release. Re-spelled as the SGR report mouse() reads.
   */
  private legacyMouse(cb: number, col: number, row: number, release: boolean): void {
    const button = cb - 32;
    const up = release || (button & 0x63) === 3;
    this.mouse(`\x1b[<${button};${col};${row}${up ? 'm' : 'M'}`, !up);
  }

  private quitting = false;

  /** handle_key: modal quit, help, the "/" menu, then the line editor. */
  key(k: number): void {
    const m = this.model, o = this.over;
    if (o.modal === MODAL_QUIT) {
      if (k === 0x79 || k === 0x59 || k === K_ENTER) { this.quit(); return; }
      if (k === 0x6e || k === 0x4e || k === K_ESC) o.modal = MODAL_NONE;
      return;
    }
    if (k === 17) { o.modal = MODAL_QUIT; o.modalTitle = 'Quit'; o.modalText = 'Leave the chat?'; return; }
    if (o.fmt) { this.pickKey(k); return; }
    if (o.help) {
      if (k === K_ESC || k === 0x71) o.help = false;
      else if (k === K_DOWN) o.helpTop++;
      else if (k === K_UP && o.helpTop > 0) o.helpTop--;
      return;
    }
    if (m.focus === FOCUS_INPUT && this.slashKey(k)) return;
    if (k === K_F4 || k === 5) { this.openPicker(); return; }
    if (k === K_F1) { o.help = true; o.helpTop = 0; return; }
    if (k === K_PGUP) { m.scroll += 10; return; }
    if (k === K_PGDN) { m.scroll = Math.max(0, m.scroll - 10); return; }
    if (k === K_ENTER) { this.submit(); return; }
    if (k >= K_SLEFT && k <= K_SDOWN) { // textbox.ts: shift extends the selection from where the cursor stood
      if (m.inputAnchor < 0) m.inputAnchor = m.inputCur;
      if (k === K_SLEFT) m.inputCur = Math.max(0, m.inputCur - 1);
      else if (k === K_SRIGHT) m.inputCur = Math.min(m.input.length, m.inputCur + 1);
      else m.inputCur = k === K_SHOME || k === K_SUP ? 0 : m.input.length; // one line: up/down reach its ends
      this.selectSoon();
      return;
    }
    if (k === K_F5) { this.openFormat(); return; }
    if (k === K_LEFT || k === K_RIGHT || k === K_HOME || k === K_END || k === K_ESC) this.clearSelection();
    if (k === K_LEFT) { if (m.inputCur > 0) m.inputCur--; return; }
    if (k === K_RIGHT) { if (m.inputCur < m.input.length) m.inputCur++; return; }
    if (k === K_HOME) { m.inputCur = 0; return; }
    if (k === K_END) { m.inputCur = m.input.length; return; }
    if (k === 8 || k === K_DEL) {
      if (this.cutSelection()) { o.slashOff = false; return; }
      if (k === K_DEL) { if (m.inputCur < m.input.length) m.input = m.input.slice(0, m.inputCur) + m.input.slice(m.inputCur + 1); }
      else if (m.inputCur > 0) { m.input = m.input.slice(0, m.inputCur - 1) + m.input.slice(m.inputCur); m.inputCur--; }
      o.slashOff = false;
      return;
    }
    if (k >= 0x20 && k < 0x100) this.cutSelection();
    if (k >= 0x20 && k < 0x100 && m.input.length < TEXT_MAX) {
      m.input = m.input.slice(0, m.inputCur) + String.fromCharCode(k) + m.input.slice(m.inputCur);
      m.inputCur++;
      o.slashOff = false;
    }
  }

  /** emoji_show: the picker over the chat, on the first category. */
  openPicker(): void {
    const o = this.over;
    o.fmt = true; o.pickFmt = false; o.pickItems = allEmoji(this); o.pickCat = o.pickItem = o.pickTop = o.pickPane = 0;
  }

  /** LIVECHAT openFormatPicker: with text selected, the format picker over the chat; the selection is kept to wrap on apply. */
  openFormat(): void {
    const m = this.model, o = this.over;
    this.selectTimer = clearTimeout(this.selectTimer) as undefined;
    if (m.inputAnchor < 0 || m.inputAnchor === m.inputCur || o.fmt) return;
    const start = Math.min(m.inputAnchor, m.inputCur), end = Math.max(m.inputAnchor, m.inputCur);
    o.pickSel = { start, end, text: m.input.slice(start, end) };
    o.fmt = true; o.pickFmt = true; o.pickItems = formatItems(); o.pickCat = o.pickItem = o.pickTop = o.pickPane = 0;
  }

  /** textbox.ts: a keyboard selection opens the format picker once the keys rest (LIVECHAT inputBox 'select'). */
  private selectSoon(): void {
    clearTimeout(this.selectTimer);
    this.selectTimer = setTimeout(() => { this.selectTimer = undefined; this.openFormat(); this.info.markDirty(); }, 500);
    this.selectTimer.unref?.();
  }

  private selectTimer: ReturnType<typeof setTimeout> | undefined;
  private inputDrag = false;

  private clearSelection(): void {
    this.model.inputAnchor = -1;
    this.selectTimer = clearTimeout(this.selectTimer) as undefined;
  }

  /** Deletes the selected text, the cursor at its start; false with nothing selected. */
  private cutSelection(): boolean {
    const m = this.model, a = m.inputAnchor;
    if (a < 0 || a === m.inputCur) { this.clearSelection(); return false; }
    const start = Math.min(a, m.inputCur), end = Math.max(a, m.inputCur);
    m.input = m.input.slice(0, start) + m.input.slice(end);
    m.inputCur = start;
    this.clearSelection();
    return true;
  }

  /** fmt_key: the picker owns every key while it is shown; Enter on an item inserts its code and a space (emoji_apply). */
  private pickKey(k: number): void {
    const m = this.model, o = this.over;
    if (k === K_UP || k === 0x6b) pickMove(o, -1);
    else if (k === K_DOWN || k === 0x6a) pickMove(o, 1);
    else if (k === 9 || k === K_BACKTAB) o.pickPane ^= 1;
    else if (k === K_ESC) o.fmt = false;
    else if (k === K_ENTER) {
      if (o.pickPane === 0) { o.pickPane = 1; return; }
      this.pickApply();
    }
  }

  /** emoji_apply: close the picker and append the selected code and a space to the input. */
  private pickApply(): void {
    const m = this.model, o = this.over;
    o.fmt = false;
    const e = pickList(o)[o.pickItem];
    if (!e) return;
    if (o.pickFmt && e.wrap) { // LIVECHAT applyFormat: the snapshot if the input still holds it there, else the first match
      const { start: s0, end, text } = o.pickSel;
      const start = m.input.slice(s0, end) === text ? s0 : m.input.indexOf(text);
      if (start < 0) return;
      const wrapped = e.wrap(text);
      m.input = m.input.slice(0, start) + wrapped + m.input.slice(start + text.length);
      m.inputCur = start + wrapped.length;
      this.clearSelection();
      return;
    }
    if (m.input.length + e.code.length + 1 >= TEXT_MAX) { this.systemLine('The emoji does not fit the input'); return; }
    m.input = `${m.input}${e.code} `;
    m.inputCur = m.input.length;
  }

  /** The mouse (livechat.c): a wheel step moves the chat three lines; with the picker on top a left press selects, a press on the
   *  selected row or category enters it, [X] closes, and a left press outside closes. Releases and motion carry nothing. */
  private mouse(seq: string, press: boolean): void {
    const f = /^\x1b\[<(\d+);(\d+);(\d+)$/.exec(seq.slice(0, -1));
    if (!f) return;
    const b = Number(f[1]), m = this.model, o = this.over, d = this.drawState;
    const row = Number(f[3]) - 1, col = Number(f[2]) - 1;
    if (b >= 64) {
      if (b >= 66) return;
      const up = b === 64;
      if (d.hits.at(row, col).id === HIT_SIDEBAR) { this.sideMove(up ? -2 : 2); this.sideJoin(); }
      else m.scroll = Math.max(0, Math.min(d.barRows > 0 ? d.barSpan : 0, m.scroll + (up ? 3 : -3)));
      return;
    }
    if (this.barDrag) { // the thumb follows the pointer until the button comes up
      if (!press) this.barDrag = false;
      else if (b >= 32) { if ((b & 3) !== 3) { const sc = d.scrollAt(row); if (sc >= 0) m.scroll = sc; } else this.barDrag = false; }
      if (!(press && b < 32)) return;
      this.barDrag = false;
    }
    if (this.inputDrag) { // textbox.ts mousemove/mouseup: the drag extends the selection; a release with text selected opens the format picker
      if (b >= 32 && press) { m.inputCur = this.inputAt(col); return; }
      if (!press) {
        this.inputDrag = false;
        m.inputCur = this.inputAt(col);
        if (m.inputAnchor === m.inputCur) m.inputAnchor = -1; else this.openFormat();
        return;
      }
      this.inputDrag = false;
    }
    if (!press || b >= 32) return;
    if (!o.fmt) { this.mousePress(row, col, b & 3); return; }
    const h = d.hits.at(row, col), button = b & 3;
    if (h.id === HIT_FMT_CLOSE) { o.fmt = false; return; }
    if (h.id === HIT_FMT_CAT && h.dr < pickCats(o).length) {
      if (h.dr === o.pickCat) { o.pickPane = 1; return; }
      o.pickPane = 0; pickMove(o, h.dr - o.pickCat);
    } else if (h.id === HIT_FMT_ITEM) {
      const item = h.dr + o.pickTop;
      if (item >= pickList(o).length) return;
      if (o.pickPane === 1 && item === o.pickItem) { this.pickApply(); return; }
      o.pickPane = 1; pickMove(o, item - o.pickItem);
    } else if (h.id !== HIT_FMT && button === 0) o.fmt = false;
  }

  private barDrag = false;

  /** side_move: step the sidebar selection over rows that are not headings or blanks. */
  private sideMove(step: number): void {
    const m = this.model, ok = (i: number): boolean => i >= 0 && i < m.side.length && m.side[i].kind !== SIDE_HEAD && m.side[i].kind !== SIDE_BLANK;
    let i = m.sideSel + step;
    while (i >= 0 && i < m.side.length && !ok(i)) i += step;
    if (ok(i)) m.sideSel = i;
  }

  /** handle_mouse for a press with no picker on top: menu bar, dropdown, status line, input, scrollbar, sidebar. Chat and
   *  channel/user context menus, the format picker and room switching are not on Partyline (see partyline-mouse2.md). */
  private mousePress(row: number, col: number, button: number): void {
    const m = this.model, o = this.over, h = this.drawState.hits.at(row, col);
    if (o.modal !== MODAL_NONE || o.help) return;
    if (h.id === HIT_MENU) {
      const k = MENU_COL.findIndex((c, i) => col >= c && col < c + MENU_LABELS[i].length);
      if (k >= 0) { m.menu = k; m.menuSel = 0; m.focus = FOCUS_MENU; return; }
    }
    if (h.id === HIT_DROPDOWN && m.menu >= 0 && h.dr < MENU_ITEMS[m.menu].length) {
      const it = MENU_ITEMS[m.menu][h.dr];
      m.menu = -1; m.focus = FOCUS_INPUT;
      if (it.startsWith('Help') || it === 'Keyboard Shortcuts') { o.help = true; o.helpTop = 0; } else if (it.startsWith('Channel List') || it === 'Toggle Sidebar') m.sidebarHidden = !m.sidebarHidden;
      else if (it.startsWith('Emoji')) this.openPicker();
      else if (it.startsWith('Quit')) this.key(17);
      return;
    }
    if (m.focus === FOCUS_MENU) { m.menu = -1; m.focus = FOCUS_INPUT; }
    if (h.id === HIT_STATUS) m.sidebarHidden = false;
    else if (h.id === HIT_INPUT) {
      m.focus = FOCUS_INPUT;
      const d = this.drawState;
      if (button === 2) { this.openFormat(); return; } // LIVECHAT: right-click with text selected
      if (button !== 0) return;
      if (d.inputW < this.cells.cols && col >= d.inputW) { this.openPicker(); return; } // the :D button
      this.clearSelection();
      m.inputCur = m.inputAnchor = this.inputAt(col); // textbox.ts mousedown: cursor and selection start at the click
      this.inputDrag = true;
    }
    else if (h.id === HIT_SCROLLBAR) {
      const sc = this.drawState.scrollAt(row);
      if (sc >= 0) m.scroll = sc;
      this.barDrag = button === 0;
    } else if (h.id === HIT_SIDEBAR && h.dr < m.side.length && m.side[h.dr].kind !== SIDE_HEAD && m.side[h.dr].kind !== SIDE_BLANK) {
      m.sideSel = h.dr;
      this.sideJoin();
    }
  }

  /** LIVECHAT: a click (or a wheel step) on a channel row switches to that channel. */
  private sideJoin(): void {
    const it = this.model.side[this.model.sideSel];
    if (it?.kind === SIDE_ROOM && it.id !== undefined && it.id !== this.roomId) this.joinRoom(it.id);
  }

  /** The input character under a column, clamped to the text. */
  private inputAt(col: number): number {
    return Math.max(0, Math.min(this.model.input.length, this.drawState.inputFrom + col - 1));
  }

  /** slash_key: true when the "/" menu used the key. */
  private slashKey(k: number): boolean {
    const m = this.model, o = this.over;
    const idx = o.slashOff ? [] : slashMatch(m.input);
    if (idx.length === 0) return false;
    const ghost = slashGhost(m.input, idx);
    if (k === K_UP || k === K_DOWN) {
      o.slashSel = Math.max(0, Math.min(idx.length - 1, o.slashSel + (k === K_DOWN ? 1 : -1)));
      o.slashTop = slashScroll(o.slashSel, o.slashTop, idx.length);
      return true;
    }
    if (k === K_ESC) { o.slashOff = true; return true; }
    if (k === 9 || k === K_RIGHT) {
      if (ghost < 0) { if (k === 9) { o.slashOff = true; return true; } return false; }
      this.fillCommand(ghost);
      return true;
    }
    if (k === K_ENTER) {
      if (slashComplete(m.input)) return false;
      this.fillCommand(ghost >= 0 ? ghost : idx[Math.min(o.slashSel, idx.length - 1)]);
      return true;
    }
    o.slashSel = 0; o.slashTop = 0;
    return false;
  }

  private fillCommand(cmd: number): void {
    const m = this.model;
    m.input = `/${CMD_HELP[cmd][0]} `;
    m.inputCur = m.input.length;
    this.clearSelection();
    this.over.slashOff = true;
  }

  /** submit: a command, else a room line; the input clears either way. */
  submit(): void {
    const m = this.model;
    const line = m.input;
    m.input = ''; m.inputCur = 0;
    this.clearSelection();
    this.over.slashSel = 0; this.over.slashTop = 0; this.over.slashOff = false;
    if (line === '') return;
    if (line[0] === '/') { if (runCommand(this, line)) this.quit(); return; }
    this.sendRoomLine(line);
  }

  private quit(): void {
    this.quitting = true;
    // Dirty first: the session renders one last frame (the clear below) before it ends; without it PL's screen stayed on the board (sysop 2026-11-24).
    this.info.markDirty();
    this.info.quit?.();
  }

  render(full: boolean): Buffer {
    // Leaving: hand the board a clean screen, as LIVECHAT's cleanup and every door exit do.
    if (this.quitting) return Buffer.from((this.info.hello.mouse ? '\x1b[?1002l\x1b[?1000l\x1b[?1006l' : '') + '\x1b[0m\x1b[2J\x1b[H\x1b[?25h', 'latin1');
    if (full) this.cells.invalidate();
    const { cr, cc } = draw(this.cells, this.model, this.drawState, this.over);
    // A full frame (first paint, resize, redraw) re-arms SGR mouse reports; input() parses them. ?1002h adds drag motion (the input selection).
    const mouseOn = full && this.info.hello.mouse ? '\x1b[?1000h\x1b[?1006h\x1b[?1002h' : '';
    // The terminal bytes are in the caller's own charset (hello charset=):
    // UTF-8 for the web and modern doors, latin1 for the Amiga and kin.
    return Buffer.from(mouseOn + this.cells.present(this.model.focus === FOCUS_INPUT && this.model.menu < 0, cr, cc), this.utf8 ? 'utf8' : 'latin1');
  }

  close(): void { clearTimeout(this.selectTimer); this.off(); }
}

export const chatScreen = (ach: AchievementsConfig, chat: ChatConfig, filesDir: string | null = null): ScreenFactory => (info) => new HubScreen(ach, chat, info, filesDir);
