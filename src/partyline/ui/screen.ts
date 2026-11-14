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
import { joinRoom, listMemberships, listRooms, postMessage } from '../../chat/store';
import type { PartylineScreen, ScreenFactory, ScreenInfo } from '../session';
import { Cells } from './cells';
import { draw, DrawState } from './draw';
import { ACTIVITY_LINE, FOCUS_INPUT, LIVE, Model, newLine, SYSTEM } from './model';
import { OverlayState } from './overlays';

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
    this.cursor = Math.max(this.cursor, r.since);
    this.systemLine(`Joined #${r.name.slice(0, 40)} (${r.members} users)`);
    this.note(ACTIVITY_LINE, `Joined #${r.name.slice(0, 40)}`);
    return true;
  }

  /** livechat.c send_room_line: the line goes to the store; the event brings it back on screen. */
  sendRoomLine(text: string): void {
    if (!this.roomId) { this.systemLine('Join a channel first: /join room'); return; }
    this.tryRun(true, (db, ctx) => postMessage(db, ctx, this.roomId, { content: text, clientId: newId('pl') }));
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

  input(bytes: Buffer): void {
    const m = this.model;
    for (const b of bytes) {
      if (b === 0x0d) {
        const line = m.input;
        m.input = ''; m.inputCur = 0;
        if (line !== '') this.sendRoomLine(line);
      } else if (b === 0x08 || b === 0x7f) {
        if (m.inputCur > 0) { m.input = m.input.slice(0, m.inputCur - 1) + m.input.slice(m.inputCur); m.inputCur--; }
      } else if (b >= 0x20) {
        m.input = m.input.slice(0, m.inputCur) + String.fromCharCode(b) + m.input.slice(m.inputCur);
        m.inputCur++;
      }
    }
    this.info.markDirty();
  }

  render(full: boolean): Buffer {
    if (full) this.cells.invalidate();
    const { cr, cc } = draw(this.cells, this.model, this.drawState, this.over);
    return Buffer.from(this.cells.present(this.model.focus === FOCUS_INPUT && this.model.menu < 0, cr, cc), 'latin1');
  }

  close(): void { this.off(); }
}

export const chatScreen = (ach: AchievementsConfig, chat: ChatConfig): ScreenFactory => (info) => new HubScreen(ach, chat, info);
