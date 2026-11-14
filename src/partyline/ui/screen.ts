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
import { withAchievementsDb } from '../../achievements/db';
import type { AchievementsConfig } from '../../achievements/config';
import { SurfaceError } from '../../achievements/errors';
import type { ChatConfig } from '../../chat/config';
import { fetchVisibleEvents, headSeq, onEvents } from '../../chat/events';
import type { EventRec } from '../../chat/events';
import { newId, resolveSession } from '../../chat/sessions';
import type { ChatCtx } from '../../chat/sessions';
import { joinRoom, listMemberships, listRooms, postMessage, roomHistory } from '../../chat/store';
import type { PartylineScreen, ScreenFactory, ScreenInfo } from '../session';
import { Cells } from './cells';
import { draw, DrawState } from './draw';
import { ACTIVITY_LINE, FOCUS_INPUT, HISTORY, LIVE, Model, newLine, SYSTEM, TEXT_MAX } from './model';
import { MODAL_NONE, MODAL_QUIT, OverlayState } from './overlays';
import { CMD_HELP, slashComplete, slashGhost, slashMatch, slashScroll } from './slash';
import { runCommand } from '../commands';

/** ui_key.h codes. */
export const K_UP = 1000, K_DOWN = 1001, K_PGUP = 1002, K_PGDN = 1003, K_HOME = 1004, K_END = 1005, K_ENTER = 1006, K_ESC = 1007,
  K_LEFT = 1008, K_RIGHT = 1009, K_F1 = 1011;
const KEY_SEQ: Record<string, number> = {
  '\x1b[A': K_UP, '\x1b[B': K_DOWN, '\x1b[C': K_RIGHT, '\x1b[D': K_LEFT, '\x1b[H': K_HOME, '\x1b[F': K_END,
  '\x1b[5~': K_PGUP, '\x1b[6~': K_PGDN, '\x1bOP': K_F1, '\x1b[1~': K_HOME, '\x1b[4~': K_END,
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
  private cursor = 0;
  private readonly off: () => void;

  constructor(private readonly ach: AchievementsConfig, private readonly chat: ChatConfig, readonly info: ScreenInfo) {
    this.model = new Model(info.hello.cols, info.hello.rows);
    this.cells = new Cells(info.hello.cols, info.hello.rows);
    this.model.handle = info.user;
    this.model.setSelf(info.user);
    this.cursor = withAchievementsDb(ach, (db) => headSeq(db));
    this.firstRoom();
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
    return true;
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
    for (const e of rows) {
      this.cursor = e.seq;
      this.event(e);
    }
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
    for (const b of bytes) {
      if (this.esc !== '') {
        this.esc += String.fromCharCode(b);
        const k = KEY_SEQ[this.esc];
        if (k !== undefined) { this.esc = ''; this.key(k); } else if (this.esc.length >= 4 || (this.esc.length >= 2 && this.esc[1] !== '[' && this.esc[1] !== 'O')) {
          // shortcut: an unknown sequence is dropped whole; a lone Esc is seen only when the next byte is not '['.
          const lone = this.esc.length === 2 && this.esc[1] !== '[' && this.esc[1] !== 'O';
          this.esc = '';
          if (lone) { this.key(K_ESC); this.input(Buffer.from([b])); }
        }
        continue;
      }
      if (b === 0x1b) { this.esc = '\x1b'; continue; }
      this.key(b === 0x0d ? K_ENTER : b === 0x7f ? 8 : b);
      if (this.quitting) return;
    }
    this.info.markDirty();
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
    if (o.help) {
      if (k === K_ESC || k === 0x71) o.help = false;
      else if (k === K_DOWN) o.helpTop++;
      else if (k === K_UP && o.helpTop > 0) o.helpTop--;
      return;
    }
    if (m.focus === FOCUS_INPUT && this.slashKey(k)) return;
    if (k === K_F1) { o.help = true; o.helpTop = 0; return; }
    if (k === K_PGUP) { m.scroll += 10; return; }
    if (k === K_PGDN) { m.scroll = Math.max(0, m.scroll - 10); return; }
    if (k === K_ENTER) { this.submit(); return; }
    if (k === K_LEFT) { if (m.inputCur > 0) m.inputCur--; return; }
    if (k === K_RIGHT) { if (m.inputCur < m.input.length) m.inputCur++; return; }
    if (k === K_HOME) { m.inputCur = 0; return; }
    if (k === K_END) { m.inputCur = m.input.length; return; }
    if (k === 8) {
      if (m.inputCur > 0) { m.input = m.input.slice(0, m.inputCur - 1) + m.input.slice(m.inputCur); m.inputCur--; }
      o.slashOff = false;
      return;
    }
    if (k >= 0x20 && k < 0x100 && m.input.length < TEXT_MAX) {
      m.input = m.input.slice(0, m.inputCur) + String.fromCharCode(k) + m.input.slice(m.inputCur);
      m.inputCur++;
      o.slashOff = false;
    }
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
    this.over.slashOff = true;
  }

  /** submit: a command, else a room line; the input clears either way. */
  submit(): void {
    const m = this.model;
    const line = m.input;
    m.input = ''; m.inputCur = 0;
    this.over.slashSel = 0; this.over.slashTop = 0; this.over.slashOff = false;
    if (line === '') return;
    if (line[0] === '/') { if (runCommand(this, line)) this.quit(); return; }
    this.sendRoomLine(line);
  }

  private quit(): void {
    this.quitting = true;
    this.info.quit?.();
  }

  render(full: boolean): Buffer {
    if (full) this.cells.invalidate();
    const { cr, cc } = draw(this.cells, this.model, this.drawState, this.over);
    return Buffer.from(this.cells.present(this.model.focus === FOCUS_INPUT && this.model.menu < 0, cr, cc), 'latin1');
  }

  close(): void { this.off(); }
}

export const chatScreen = (ach: AchievementsConfig, chat: ChatConfig): ScreenFactory => (info) => new HubScreen(ach, chat, info);
