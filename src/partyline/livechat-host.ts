/**
 * Spike: host the board's TypeScript LIVECHAT blessed door on the hub, one
 * instance per Partyline caller. The door runs unchanged from its compiled
 * dist; this file gives it the three objects it expects from the board (bbs,
 * bbsSession, socket) and answers its room:* socket events from the hub's own
 * chat store instead of the board's federation bridge.
 *
 * shortcut: only room:list / room:join / room:message / room:leave / room:create
 * are answered and incoming messages are relayed for the joined room; every
 * other event is logged as unhandled. Upgrade by porting chat-session-bridge's
 * FEDERATED_EVENTS table onto the store functions one event at a time.
 */
import { EventEmitter } from 'events';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { withAchievementsDb } from '../achievements/db';
import type { AchievementsConfig } from '../achievements/config';
import type { ChatConfig } from '../chat/config';
import { fetchVisibleEvents, headSeq, onEvents } from '../chat/events';
import { newId, resolveSession } from '../chat/sessions';
import type { ChatCtx } from '../chat/sessions';
import { createRoom, joinRoom, leaveRoom, listRooms, postMessage, roomHistory } from '../chat/store';
import type { PartylineScreen, ScreenFactory, ScreenInfo } from './session';

/** The board checkout's LIVECHAT door directory; its dist/server.js exports createApp. */
export function livechatDoorDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIVECHAT_DOOR_DIR || path.resolve(__dirname, '../../../amiexpress-web/board/Doors/livechat');
}

type Payload = Record<string, unknown>;
interface DoorApp { run(): Promise<void> }
interface DoorModule { createApp(session: unknown): DoorApp | Promise<DoorApp> }

export function livechatScreen(ach: AchievementsConfig, chat: ChatConfig, doorDir = livechatDoorDir(), log: (l: string) => void = (l) => console.log(l)): ScreenFactory {
  return (info: ScreenInfo): PartylineScreen => {
    const enc: BufferEncoding = info.hello.charset === 'utf8' ? 'utf8' : 'latin1';
    let cols = info.hello.cols;
    let rows = info.hello.rows;
    let out: string[] = [];
    let room: { id: string; name: string } | null = null;
    let closed = false;

    const store = <T>(write: boolean, fn: (db: Database.Database, ctx: ChatCtx) => T): T =>
      withAchievementsDb(ach, (db) => {
        const ctx = resolveSession(db, chat, info.sid, info.boardId);
        return write ? db.transaction(() => fn(db, ctx))() : fn(db, ctx);
      });

    const bbs = Object.assign(new EventEmitter(), {
      connectionType: 'telnet',
      unicodeCapable: enc === 'utf8',
      write: (s: string) => { out.push(s); info.markDirty(); },
      writeLine: (s: string) => { out.push(s + '\r\n'); info.markDirty(); },
      getTerminalSize: () => ({ width: cols, height: rows }),
      isPetsciiMode: () => false,
      isAnsiMode: () => true,
      getModemSpeed: () => 0,
      modemEmulationEnabled: false,
    });
    const user = { username: info.user, id: 0, secLevel: 10 };
    const bbsSession: { user: typeof user; nodeId: number; tempData: Payload; doorInputHandler?: (d: string) => void } =
      { user, nodeId: 0, tempData: {} };

    // The door's side of the socket: it listens here and the hub emits replies here.
    const toDoor = new EventEmitter();
    const reply = (ev: string, data: Payload): void => { setImmediate(() => { if (!closed) toDoor.emit(ev, data); }); };

    const join = (name: string): void => {
      const r = store(true, (db, ctx) => {
        let row = listRooms(db, ctx).find((x) => x.name === name);
        const id = row ? row.id : createRoom(db, ctx, { name }).id;
        const j = joinRoom(db, ctx, id);
        return { j, history: roomHistory(db, ctx, id, { limit: 50 }) };
      });
      room = { id: r.j.id, name: r.j.name };
      reply('room:joined', {
        roomId: r.j.id, roomName: r.j.name, topic: r.j.topic, memberCount: r.j.members,
        history: r.history.map((h) => ({ id: h.id, channelId: r.j.id, username: h.user, userId: h.user, content: h.text, type: 'message', createdAt: new Date(h.at * 1000).toISOString() })),
      });
    };

    const handlers: Record<string, (d: Payload) => void> = {
      'room:list': () => {
        const rooms = store(false, (db, ctx) => listRooms(db, ctx));
        reply('room:list', { rooms: rooms.map((x) => ({ room_id: x.id, room_name: x.name, topic: x.topic, is_public: x.visibility !== 'private', member_count: x.members, created_by_username: x.owner, kind: x.kind })) });
      },
      'room:join': (d) => join(String(d.roomName ?? d.roomId ?? '')),
      'room:create': (d) => join(String(d.roomName ?? '')),
      'room:leave': () => { if (room) { const id = room.id; store(true, (db, ctx) => leaveRoom(db, ctx, id)); room = null; } },
      'room:message': (d) => {
        if (!room) return;
        const id = room.id;
        store(true, (db, ctx) => postMessage(db, ctx, id, { content: String(d.message ?? ''), clientId: String(d.clientId ?? newId('pl')) }));
      },
    };

    const socket = {
      id: newId('pl'), connected: true,
      on: (ev: string, fn: (...a: unknown[]) => void) => { toDoor.on(ev, fn); return socket; },
      off: (ev: string, fn: (...a: unknown[]) => void) => { toDoor.off(ev, fn); return socket; },
      once: (ev: string, fn: (...a: unknown[]) => void) => { toDoor.once(ev, fn); return socket; },
      emit: (ev: string, data: Payload = {}) => {
        const h = handlers[ev];
        if (!h) { log(`[partyline-livechat] unhandled ${ev}`); return true; }
        try { h(data); } catch (e) { log(`[partyline-livechat] ${ev} failed: ${(e as Error).message}`); }
        return true;
      },
    };

    // Others' messages in the joined room reach the door as chat:message.
    let cursor = withAchievementsDb(ach, (db) => headSeq(db));
    const off = onEvents(() => {
      if (closed || !room) return;
      const evs = withAchievementsDb(ach, (db) => fetchVisibleEvents(db, info.sid, info.user, cursor, info.boardId));
      for (const e of evs) {
        cursor = Math.max(cursor, e.seq);
        if (e.type !== 'message' || e.room_id !== room.id || e.user === info.user) continue;
        reply('chat:message', { id: e.ref, channelId: e.room_id, userId: e.user, username: e.user, content: e.text, type: 'message', createdAt: new Date(e.at * 1000).toISOString() });
      }
    });

    const mod = require(path.join(doorDir, 'dist/server.js')) as DoorModule; // eslint-disable-line @typescript-eslint/no-require-imports
    Promise.resolve(mod.createApp({ socket, user, bbsSession, bbs, params: [] })).then((app) => app.run())
      .catch((e: Error) => log(`[partyline-livechat] door ended with error: ${e.message}`))
      .finally(() => { off(); if (!closed) info.quit?.(); });

    return {
      resize(c: number, r: number) { cols = c; rows = r; bbs.emit('screen:resize', { cols: c, rows: r }); },
      input(bytes: Buffer) { bbsSession.doorInputHandler?.(bytes.toString(enc)); },
      render() { const b = Buffer.from(out.join(''), enc); out = []; return b; },
      // shortcut: closing does not stop the door's blessed screen yet; Ctrl+Q / screen.destroy hook is remaining work.
      close() { closed = true; socket.connected = false; off(); },
    };
  };
}
