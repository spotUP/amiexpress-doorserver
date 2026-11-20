/**
 * Spike: host the board's TypeScript LIVECHAT blessed door on the hub, one
 * forked process per Partyline caller (livechat-child.ts). The door runs
 * unchanged from its compiled dist; the child gives it the three objects it
 * expects from the board (bbs, bbsSession, socket), and this side answers its
 * room:* socket events from the hub's own chat store instead of the board's
 * federation bridge. close() kills the child, which ends the door.
 *
 * Every event is answered by calling the same src/chat/store.ts function the
 * HTTP router (src/chat/router.ts) calls; only the reply shapes are new here.
 * Effects other callers (and the actor) must see arrive through the event
 * relay below, not as a direct reply. File, upload and draw events live in livechat-files.ts. Not hosted: audio/voice/video/door
 * events other than audio:play and the voice/video ones (livechat-voice.ts), chat:auth-token; they are logged and dropped.
 */
import { fork } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { withAchievementsDb } from '../achievements/db';
import type { AchievementsConfig } from '../achievements/config';
import type { ChatConfig } from '../chat/config';
import { fetchVisibleEvents, headSeq, onEvents } from '../chat/events';
import { newId, resolveSession, splitUser } from '../chat/sessions';
import type { ChatCtx } from '../chat/sessions';
import {
  addIgnore, createRoom, deleteMessage, dmHistory, dmParticipants, dmThreads, editMessage, invite, joinRoom, leaveRoom, listEmoji, listIgnores,
  clearRoom, deleteRoom, doorRoster, markRead, roomHeadSeq, listMemberships, getPrefs, listPins, listRooms, moderate, muteSecondsLeft, pin, setOp, setPrefs, postDm, postDmGroup, postMessage, postThread, profileOf, react, reactionRows, removeIgnore, roomHistory,
  search, setMode, setPresence, setRoomMotd, setTopic, setTyping, threadHistory, unreact, getDiscordMirror, setDiscordMirror,
} from '../chat/store';
import { SurfaceError } from '../achievements/errors';
import type { PartylineScreen, RenderPart, ScreenFactory, ScreenInfo } from './session';
import type { FromChild, ToChild } from './livechat-child';
import { SgrDedupe } from './livechat-wire';
import { filesAndDrawing } from './livechat-files';
import { joinVoiceHub } from './livechat-voice';

// Each caller's door runs in its own process: the door's module singletons cannot be shared.
const CHILD = path.join(__dirname, `livechat-child${path.extname(__filename)}`);

/** The board checkout's LIVECHAT door directory; its dist/server.js exports createApp. */
export function livechatDoorDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIVECHAT_DOOR_DIR || path.resolve(__dirname, '../../../amiexpress-web/board/Doors/livechat');
}

type Payload = Record<string, unknown>;

/**
 * Fork a LIVECHAT child that loads the door at once. The host keeps one such spare
 * idle so a caller's PL skips process boot and the door's module load (seconds,
 * and far more on a cold file cache). An idle spare does not hold the hub open.
 */
export function forkLivechatChild(doorDir: string, log: (l: string) => void): ChildProcess {
  const child = fork(CHILD, [doorDir], { execArgv: CHILD.endsWith('.ts') ? ['--require', require.resolve('tsx/cjs')] : [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
  for (const std of [child.stdout, child.stderr]) {
    std?.on('data', (d: Buffer) => { for (const l of d.toString('utf8').split('\n')) if (l.trim()) log(`[partyline-livechat ${child.pid}] ${l}`); });
  }
  child.on('error', (e) => log(`[partyline-livechat] child ${child.pid} error: ${e.message}`));
  child.unref();
  child.channel?.unref();
  return child;
}

/** Newest mtime of the two dist files the child loads; a rebuild changes it. 0 when absent. */
export function doorDistStamp(doorDir: string): number {
  return Math.max(...['dist/server.js', 'dist/ui/screen.js'].map((f) => { try { return fs.statSync(path.join(doorDir, f)).mtimeMs; } catch { return 0; } }));
}

/** Warm spare that is replaced on handout when the door's dist changed since it was forked (it loaded old code). */
export function warmSpare(doorDir: string, fork: () => ChildProcess, stamp: () => number = () => doorDistStamp(doorDir)): () => ChildProcess {
  const start = (): { child: ChildProcess; at: number } => ({ at: stamp(), child: fork() });
  let spare = start();
  return () => {
    const alive = spare.child.connected && spare.child.exitCode === null;
    const fresh = alive && spare.at === stamp();
    if (alive && !fresh) spare.child.kill();
    const taken = fresh ? spare.child : fork();
    spare = start();
    return taken;
  };
}

export function livechatScreen(ach: AchievementsConfig, chat: ChatConfig, doorDir = livechatDoorDir(), log: (l: string) => void = (l) => console.log(l), filesDir: string | null = null): ScreenFactory {
  const takeSpare = warmSpare(doorDir, () => forkLivechatChild(doorDir, log));
  return (info: ScreenInfo): PartylineScreen => {
    const enc: BufferEncoding = info.hello.charset === 'utf8' ? 'utf8' : 'latin1';
    let cols = info.hello.cols;
    let rows = info.hello.rows;
    // Door output in order: text and kitty APC alternate, and a picture must land where the text before it put the cursor.
    let out: RenderPart[] = [];
    // The door re-asserts the same SGR per fragment (~1 KB/keystroke); drop the no-ops, keep every visible byte.
    const wire = new SgrDedupe();
    const push = (type: RenderPart['type'], s: string): void => {
      if (type === 'D') s = wire.filter(s);
      const last = out[out.length - 1];
      if (last?.type === type) last.bytes = Buffer.concat([last.bytes, Buffer.from(s, type === 'G' ? 'latin1' : enc)]);
      else out.push({ type, bytes: Buffer.from(s, type === 'G' ? 'latin1' : enc) });
      info.markDirty();
    };
    // Every room the caller belongs to (id -> name) and the one on screen. Switching changes `room` only.
    const joined = new Map<string, string>();
    let room: { id: string; name: string } | null = null;
    let closed = false;

    const store = <T>(write: boolean, fn: (db: Database.Database, ctx: ChatCtx) => T): T =>
      withAchievementsDb(ach, (db) => {
        const ctx = resolveSession(db, chat, info.sid, info.boardId);
        return write ? db.transaction(() => fn(db, ctx))() : fn(db, ctx);
      });

    // Take the warm spare (a dead one is replaced) and start the next spare for the caller after.
    const child = takeSpare();
    child.ref();
    child.channel?.ref();
    // 'advanced' IPC keeps Date objects: the door formats createdAt with getHours().
    const tell = (m: ToChild): void => { if (child.connected) child.send(m); };
    tell({ t: 'init', doorDir, user: info.user, access: info.hello.access, sysop: info.hello.sysop, cols, rows, utf8: enc === 'utf8', kitty: info.hello.kitty, conn: info.hello.conn, wide: info.hello.wide, responsive: info.hello.responsive, chatOnly: info.hello.chatOnly });
    // Hub replies go to the door's socket listeners in the child.
    const reply = (ev: string, data: Payload): void => { if (!closed) tell({ t: 'event', ev, data }); };

    // The door finds itself in `members` by its own init name (info.user, the full handle@BOARD); no match and it lists nobody.
    // made: a /create's topic, visibility and kind, used only when the room is new.
    const join = (name: string, made: Payload = {}): void => {
      const r = store(true, (db, ctx) => {
        let row = listRooms(db, ctx).find((x) => x.name === name);
        const id = row ? row.id : createRoom(db, ctx, name.startsWith('art:') ? { name, kind: 'art' } : { ...made, name }).id;
        const j = joinRoom(db, ctx, id);
        markRead(db, ctx, id, { seq: roomHeadSeq(db, id) }); // viewing it reads it; plain recent history, no replay
        return { j, history: roomHistory(db, ctx, id, { limit: 50 }), roster: doorRoster(db, id, (u) => (u === me ? info.user : short(u))) };
      });
      joined.set(r.j.id, r.j.name);
      room = { id: r.j.id, name: r.j.name };
      reply('room:joined', {
        channel: r.j.name, roomId: r.j.id, roomName: r.j.name, topic: r.j.topic, memberCount: r.j.members, members: r.roster,
        history: r.history.map((h) => ({ id: h.id, channelId: r.j.id, username: h.user, userId: h.user, content: h.text, type: 'message', createdAt: new Date(h.at * 1000) })),
      });
    };

    const me = store(false, (_db, ctx) => ctx.user);
    const board = splitUser(me)?.board ?? info.boardId;
    const full = (n: string): string => (splitUser(n) ? n : `${n}@${board}`);
    const short = (u: string): string => { const p = splitUser(u); return p && p.board.toLowerCase() === board.toLowerCase() ? p.handle : u; };
    const str = (d: Payload, ...keys: string[]): string => { for (const k of keys) { const v = d[k]; if (typeof v === 'string' && v !== '') return v; } return ''; };
    const target = (d: Payload): string => full(str(d, 'targetUsername', 'target', 'targetUserId', 'username', 'user'));
    const when = (at: number): Date => new Date(at * 1000);
    // LC shape (web/backend dm-thread-list.handler.ts): participants = the others, displayName names the thread.
    const sendThreads = (): void => reply('chat:dm-threads', {
      threads: store(false, (db, ctx) => dmThreads(db, ctx)).map((t) => {
        const others = t.peer.split(',').map(short);
        return { threadId: t.threadId, isGroup: t.threadId.startsWith('dg'), displayName: others.join(', '), participants: others, lastMessageAt: when(t.lastAt), unread: t.unread };
      }),
    });
    // Client room actions name their room (roomId / roomName / channel) or mean the active one.
    const roomOfD = (d: Payload): { id: string; name: string } | null => {
      const n = str(d, 'roomId', 'roomName', 'channel').replace(/^#/, '').toLowerCase();
      if (n) for (const [id, name] of joined) if (id === n || name.toLowerCase() === n) return { id, name };
      return room;
    };
    const needRoom = (d: Payload, fn: (id: string) => void): void => { const r = roomOfD(d); if (r) fn(r.id); else reply('room:error', { message: 'Join a room first' }); };
    const counts = (id: string): Record<string, number> =>
      Object.fromEntries(store(false, (db, ctx) => reactionRows(db, ctx, id)).map((r) => [r.emoji, r.count]));
    const ignoreList = (): void => reply('chat:ignore-list', { users: store(false, (db, ctx) => listIgnores(db, ctx)).map((r) => short(r.user)) });
    const pinList = (id: string, ev = 'chat:pin:list'): void => reply(ev, {
      channel: joined.get(id), roomId: id,
      pinnedMessages: store(false, (db, ctx) => listPins(db, ctx, id)).map((p) => ({ messageId: p.messageId, id: p.messageId, username: short(p.user), content: p.content, pinnedBy: short(p.pinnedBy), createdAt: when(p.messageAt), pinnedAt: when(p.at) })),
    });
    const msgOf = (h: { id: string; user: string; text: string; at: number }): Payload => ({ id: h.id, messageId: h.id, username: short(h.user), userId: h.user, content: h.text, message: h.text, createdAt: when(h.at) });
    // The door names a channel by name or id (admin:*, /delete #name).
    const roomIdOf = (d: Payload): string => {
      const n = str(d, 'channel', 'roomId', 'roomName').replace(/^#/, '').toLowerCase();
      const hit = store(false, (db, ctx) => listRooms(db, ctx)).find((x) => x.id === n || x.name.toLowerCase() === n);
      if (!hit) reply('room:error', { message: `Channel ${n.slice(0, 40)} not found` });
      return hit?.id ?? '';
    };
    const moderation = (action: 'kick' | 'ban' | 'unban' | 'mute' | 'unmute') => (d: Payload): void => needRoom(d, (id) => {
      const minutes = Number(d.minutes ?? d.duration);
      store(true, (db, ctx) => moderate(db, ctx, id, action, { user: target(d), reason: str(d, 'reason'), ...(minutes > 0 ? { minutes } : {}) }));
    });

    const files = filesAndDrawing({ store, reply, str, short, room: () => room, filesDir, uploadMode: info.hello.upload, conn: info.hello.conn, ctrl: info.ctrl });
    let typed = '';
    const showTyped = (): void => { if (room) { const id = room.id; store(true, (db, ctx) => setTyping(db, ctx, id, { text: typed })); } };
    const handlers: Record<string, (d: Payload) => void> = {
      ...files.handlers,
      'room:list': () => {
        const rooms = store(false, (db, ctx) => listRooms(db, ctx));
        const unread = store(false, (db, ctx) => new Map(listMemberships(db, ctx).map((m) => {
          const mention = m.unread > 0 && roomHistory(db, ctx, m.roomId, { after: m.lastRead, limit: 50 }).some((h) => h.user !== me && h.text.toLowerCase().includes(`@${short(me).toLowerCase()}`));
          return [m.roomId, { unreadCount: m.unread, mention }] as const;
        })));
        reply('room:list', { rooms: rooms.map((x) => ({ room_id: x.id, room_name: x.name, topic: x.topic, is_public: x.visibility !== 'private', member_count: x.members, created_by_username: x.owner, kind: x.kind, unreadCount: unread.get(x.id)?.unreadCount ?? 0, mention: unread.get(x.id)?.mention ?? false })) });
      },
      'room:join': (d) => join(String(d.roomName ?? d.roomId ?? '')),
      // The door's sidebar only learns of rooms from room:list (sysop 2026-11-17: a created room was missing).
      'room:create': (d) => {
        const made: Payload = { topic: str(d, 'topic'), visibility: d.isPublic === false || d.isInviteOnly === true ? 'private' : 'public' };
        if (typeof d.kind === 'string') made.kind = d.kind;
        join(String(d.roomName ?? ''), made);
        handlers['room:list']({});
      },
      // Explicit /leave only: ends membership (and the read marker). Switching never sends it.
      'room:leave': (d) => {
        const r = roomOfD(d);
        if (!r) return;
        store(true, (db, ctx) => leaveRoom(db, ctx, r.id));
        joined.delete(r.id);
        if (room?.id === r.id) room = null;
      },
      'room:message': (d) => {
        const r = roomOfD(d);
        if (!r) return;
        const id = r.id;
        const clientId = String(d.clientId ?? newId('pl'));
        const sent = store(true, (db, ctx) => postMessage(db, ctx, id, { content: String(d.message ?? ''), clientId }));
        reply('room:message:ack', { clientId, id: sent.id });
      },
      // edit, delete, react, unreact reach the actor and the room through the relay.
      'chat:edit': (d) => { store(true, (db, ctx) => editMessage(db, ctx, str(d, 'messageId', 'id'), { content: str(d, 'content', 'message') })); },
      'chat:delete': (d) => { store(true, (db, ctx) => deleteMessage(db, ctx, str(d, 'messageId', 'id'))); },
      'chat:react': (d) => { store(true, (db, ctx) => react(db, ctx, str(d, 'messageId', 'id'), { emoji: str(d, 'emoji') })); },
      'chat:unreact': (d) => { store(true, (db, ctx) => unreact(db, ctx, str(d, 'messageId', 'id'), str(d, 'emoji'))); },
      'chat:reactions:list': (d) => { const id = str(d, 'messageId', 'id'); reply('chat:reactions:list', { messageId: id, counts: counts(id) }); },
      'chat:dm': (d) => {
        const to = full(str(d, 'to', 'username', 'user'));
        const message = str(d, 'message', 'content');
        store(true, (db, ctx) => postDm(db, ctx, to, { content: message, clientId: newId('pl') }));
        reply('chat:dm', { direction: 'sent', from: short(me), to: short(to), message, isGroup: false });
        sendThreads();
      },
      'chat:group-dm': (d) => {
        const people = (Array.isArray(d.participants) ? d.participants : []).filter((x): x is string => typeof x === 'string').map(full);
        const message = str(d, 'message', 'content');
        store(true, (db, ctx) => postDmGroup(db, ctx, { participants: people, content: message, clientId: newId('pl') }));
        reply('chat:dm', { direction: 'sent', from: short(me), message, isGroup: true, participants: people.map(short) });
        sendThreads();
      },
      'chat:dm-threads:list': () => sendThreads(),
      'chat:dm-history': (d) => {
        const threadId = str(d, 'threadId');
        const rows = store(false, (db, ctx) => dmHistory(db, ctx, threadId, { limit: d.limit }));
        reply('chat:dm-history', { threadId, messages: rows.map((h) => ({ ...msgOf(h), sender_username: short(h.user), senderUsername: short(h.user), from: short(h.user) })) });
      },
      'chat:presence': (d) => { store(true, (db, ctx) => setPresence(db, ctx, { status: str(d, 'status') || 'online', text: str(d, 'custom', 'text') })); },
      'chat:whois': (d) => {
        const username = str(d, 'username', 'user');
        try { reply('chat:profile', { found: true, ...store(false, (db, ctx) => profileOf(db, ctx, full(username))) }); }
        catch (e) { if (!(e instanceof SurfaceError)) throw e; reply('chat:profile', { found: false, user: username }); }
      },
      'chat:ignore': (d) => { store(true, (db, ctx) => addIgnore(db, ctx, { user: full(str(d, 'user', 'username')) })); ignoreList(); },
      'chat:unignore': (d) => { store(true, (db, ctx) => removeIgnore(db, ctx, full(str(d, 'user', 'username')))); ignoreList(); },
      'chat:ignore-list': ignoreList,
      'chat:prefs': () => reply('chat:prefs', { prefs: store(false, (db, ctx) => getPrefs(db, ctx)) }),
      'chat:prefs-set': (d) => { store(true, (db, ctx) => setPrefs(db, ctx, d.prefs)); },
      // /discord [on|off]: same replies as the board's federation bridge (chat-session-bridge.ts).
      'chat:discord': (d) => {
        const text = (on: boolean): string => `Discord mirror is ${on ? 'ON' : 'OFF'} for this board.`;
        try {
          const on = typeof d.on === 'boolean'
            ? store(true, (db, ctx) => setDiscordMirror(db, ctx, { on: d.on }))
            : store(false, (db, ctx) => getDiscordMirror(db, ctx));
          reply('chat:discord', { message: text(on), on });
        } catch (e) {
          if (e instanceof SurfaceError && e.status === 403) reply('chat:discord', { message: 'Only the sysop can change the Discord mirror.' });
          else throw e;
        }
      },
      'chat:emoji:list': () => reply('chat:emoji-list', { emojis: store(false, (_db) => listEmoji(_db)) }),
      'chat:typing': (d) => needRoom(d, (id) => { store(true, (db, ctx) => setTyping(db, ctx, id, { text: str(d, 'text') })); }),
      // The door sends one event per key (like the board's chat:keystroke); the store keeps the whole line, so fold them here.
      'chat:keystroke': (d) => { const c = str(d, 'char'); typed = c === 'BACKSPACE' ? typed.slice(0, -1) : typed + c; showTyped(); },
      'chat:keystroke-clear': () => { typed = ''; showTyped(); },
      'chat:keystroke-submit': () => { typed = ''; showTyped(); },
      // Notification sound cue: the caller's board plays it (S frame), as the web client plays audio:play in LC.
      'audio:play': (d) => { const cue = str(d, 'soundId'); if (cue) info.sound?.(cue); },
      'room:topic': (d) => needRoom(d, (id) => { store(true, (db, ctx) => setTopic(db, ctx, id, { topic: str(d, 'topic') })); }),
      'room:motd': (d) => needRoom(d, (id) => { store(true, (db, ctx) => setRoomMotd(db, ctx, id, { motd: str(d, 'motd') })); }),
      'room:mode': (d) => needRoom(d, (id) => { store(true, (db, ctx) => setMode(db, ctx, id, { modes: str(d, 'modeString', 'modes'), params: Array.isArray(d.params) ? d.params.join(' ') : str(d, 'params') })); }),
      'room:invite': (d) => needRoom(d, (id) => { store(true, (db, ctx) => invite(db, ctx, id, { user: target(d) }, true)); }),
      'room:revoke-invite': (d) => needRoom(d, (id) => { store(true, (db, ctx) => invite(db, ctx, id, {}, false, target(d))); }),
      'room:kick': moderation('kick'),
      'chat:kick': moderation('kick'),
      'admin:kick-user': moderation('kick'),
      'admin:ban-user': moderation('ban'),
      // /op @user, /op -@user, /deop @user: the door sends room:op {username, op}; the hub answers with an op event.
      'room:op': (d) => needRoom(d, (id) => { store(true, (db, ctx) => setOp(db, ctx, id, { user: target(d) }, d.op !== false)); }),
      'admin:clear-channel-history': (d) => { const id = roomIdOf(d); if (id) store(true, (db, ctx) => clearRoom(db, ctx, id)); },
      'admin:delete-channel': (d) => { const id = roomIdOf(d); if (id) store(true, (db, ctx) => deleteRoom(db, ctx, id)); },
      'chat:ban': moderation('ban'),
      'chat:unban': moderation('unban'),
      'chat:mute': moderation('mute'),
      'chat:unmute': moderation('unmute'),
      'chat:pin:add': (d) => needRoom(d, (id) => { store(true, (db, ctx) => pin(db, ctx, id, { messageId: str(d, 'messageId', 'id') }, true)); pinList(id); }),
      'chat:pin:remove': (d) => needRoom(d, (id) => { store(true, (db, ctx) => pin(db, ctx, id, {}, false, str(d, 'messageId', 'id'))); pinList(id); }),
      'chat:pin:list': (d) => needRoom(d, (id) => pinList(id)),
      // A hub thread is the replies to one message; the title is its first reply.
      'chat:thread:create': (d) => {
        const messageId = str(d, 'messageId', 'id');
        const title = str(d, 'title') || 'Thread';
        store(true, (db, ctx) => postThread(db, ctx, messageId, { content: title, clientId: newId('pl') }));
        reply('chat:thread:created', { threadId: messageId, messageId, title });
      },
      'chat:thread:reply': (d) => {
        const threadId = str(d, 'threadId');
        store(true, (db, ctx) => postThread(db, ctx, threadId, { content: str(d, 'message', 'content'), clientId: newId('pl') }));
        reply('chat:thread:reply', { threadId });
      },
      'chat:thread:messages': (d) => {
        const threadId = str(d, 'threadId');
        reply('chat:thread:messages', { threadId, messages: store(false, (db, ctx) => threadHistory(db, ctx, threadId)).map(msgOf) });
      },
      'chat:search': (d) => {
        const query = str(d, 'query', 'q');
        const hits = store(false, (db, ctx) => search(db, ctx, { q: query, room: str(d, 'roomId', 'room') || undefined, user: str(d, 'username', 'user') || undefined, limit: d.limit }));
        reply('chat:search:results', { query, count: hits.length, results: hits.map((h) => ({ id: h.id, messageId: h.id, roomId: h.room, username: short(h.user), content: h.content, createdAt: when(h.at) })) });
      },
    };

    // Out of scope for the Partyline host: dropped quietly (the door never waits on these).
    const DROPPED = /^(audio|voice|video|door):|^admin:archive-channel$|^chat:auth-token$|^chat:keystroke/;
    // Voice/video: the hub-wide registry fans out between callers; browser media rides M frames.
    const voice = joinVoiceHub({
      userId: short(me), username: short(me), room: () => room?.id ?? null,
      event: (ev, data) => reply(ev, data),
      media: (p) => info.media?.(p),
    });
    const onEmit = (ev: string, data: Payload, ack?: number): void => {
      if (voice.onDoorEmit(ev, data, ack === undefined ? undefined : (result) => tell({ t: 'ack', id: ack, result }))) return;
      const h = handlers[ev];
      if (!h) { log(`[partyline-livechat] ${DROPPED.test(ev) ? 'dropped' : 'unhandled'} ${ev}`); return; }
      try { h(data); } catch (e) {
        log(`[partyline-livechat] ${ev} failed: ${(e as Error).message}`);
        if (e instanceof SurfaceError) reply('room:error', { message: e.message });
      }
    };

    // Entry: a member of every public room (a banned or full room is skipped); the door picks the one to show.
    store(true, (db, ctx) => { for (const r of listRooms(db, ctx)) if (r.visibility === 'public') { try { joinRoom(db, ctx, r.id); joined.set(r.id, r.name); } catch (e) { if (!(e instanceof SurfaceError)) throw e; } } });

    // What the hub says about the caller's room, DMs and presence reaches the door as its own events.
    let cursor = withAchievementsDb(ach, (db) => headSeq(db));
    const off = onEvents(() => {
      if (closed) return;
      const evs = withAchievementsDb(ach, (db) => fetchVisibleEvents(db, info.sid, me, cursor, info.boardId));
      for (const e of evs) {
        cursor = Math.max(cursor, e.seq);
        const mine = e.user === me;
        // `here`: the caller is in the event's room (active or not). Every such event carries `channel`.
        const chan = e.room_id ? joined.get(e.room_id) : undefined;
        const here = chan !== undefined;
        const active = !!room && e.room_id === room.id;
        const ch = { channel: chan };
        const at = when(e.at);
        if (active && files.onEvent(e)) continue;
        switch (e.type) {
          case 'message':
            if (here && !mine && e.label.startsWith('thread:')) reply('chat:thread:reply', { ...ch, threadId: e.label.slice(7), messageId: e.ref, username: short(e.user), content: e.text, createdAt: at });
            else if (here && !mine) {
              if (active) store(true, (db, ctx) => markRead(db, ctx, e.room_id!, { seq: roomHeadSeq(db, e.room_id!) }));
              reply('chat:message', { ...ch, id: e.ref, channelId: e.room_id, userId: e.user, username: short(e.user), content: e.text, type: 'message', createdAt: at });
            } break;
          case 'edit': if (here) reply('chat:edited', { ...ch, messageId: e.ref, username: short(e.user), content: e.text, createdAt: at }); break;
          case 'delete': if (here && e.ref !== '*') reply('chat:deleted', { ...ch, messageId: e.ref }); break;
          case 'react': case 'unreact': if (here) reply('chat:reaction', { ...ch, messageId: e.ref, username: short(e.user), emoji: e.text, action: e.type === 'react' ? 'add' : 'remove', counts: counts(e.ref) }); break;
          case 'typing': if (here && !mine) reply('chat:typing', { ...ch, channelId: e.room_id, userId: e.user, username: short(e.user), text: e.text }); break;
          case 'topic': if (here) reply('room:topic', { ...ch, roomId: e.room_id, topic: e.text, by: short(e.user) }); break;
          case 'room_motd': if (here) reply('room:motd', { ...ch, motd: e.text }); break;
          case 'mode': if (here) reply('room:mode', { ...ch, applied: e.text, by: short(e.user) }); break;
          // The board's own activity: the door prints it as [EVENT] lines (payload as the web board's bbs:event).
          case 'bbs': {
            const data = Object.fromEntries(new URLSearchParams(e.text));
            reply('bbs:event', { type: e.ref, username: short(e.user), nodeId: Number(e.label) || 0, timestamp: e.at * 1000, data });
            break;
          }
          // Same wording as the board bridge (chat-session-bridge.ts); the switcher already got the /discord reply.
          case 'discord_mirror':
            if (!mine && e.ref.toUpperCase() === info.boardId.toUpperCase()) reply('chat:discord', { message: `Discord mirror switched ${e.text === '1' ? 'ON' : 'OFF'} for ${e.ref.toUpperCase()}.` });
            break;
          case 'presence': { const [status, ...custom] = e.text.split('|'); reply('chat:presence', { userId: e.user, username: short(e.user), status, custom: custom.join('|') }); break; }
          case 'pin': if (here) pinList(e.room_id!, 'chat:pin:updated'); break;
          case 'joined': case 'left': if (here && !mine) reply(`room:user-${e.type}`, { ...ch, userId: e.user, username: short(e.user) }); break;
          case 'op': case 'deop': if (here) reply('room:op-changed', { ...ch, username: short(e.user), op: e.type === 'op', by: short(e.ref) }); break;
          // Every user is a member of every public room: join a room created after entry (membership only, active room unchanged).
          case 'room_created':
            if (e.room_id && !joined.has(e.room_id)) {
              const made = store(true, (db, ctx) => {
                const r = listRooms(db, ctx).find((x) => x.id === e.room_id);
                if (!r || r.visibility !== 'public') return null;
                try { joinRoom(db, ctx, r.id); return r.name; } catch (err) { if (err instanceof SurfaceError) return null; throw err; }
              });
              if (made) { joined.set(e.room_id, made); handlers['room:list']({}); }
            }
            break;
          case 'room_deleted':
            reply('room:deleted', { channel: e.text, roomId: e.room_id, roomName: e.text });
            if (e.room_id) joined.delete(e.room_id);
            if (active) room = null;
            break;
          case 'kicked': case 'banned': case 'muted':
            if (here && e.user === me) {
              const left = e.type === 'muted' ? store(false, (db) => muteSecondsLeft(db, e.room_id!, e.user)) : null;
              reply(`chat:${e.type}`, { ...ch, reason: e.text, ...(left !== null ? { duration: left } : {}) });
              if (e.type !== 'muted') { joined.delete(e.room_id!); if (active) room = null; }
            }
            break;
          case 'dm': if (!mine) {
            const isGroup = e.label.startsWith('dg');
            const people = isGroup ? store(false, (db, ctx) => dmParticipants(db, ctx, e.label)) : [];
            reply('chat:dm', { direction: 'received', from: short(e.user), message: e.text, isGroup, ...(isGroup ? { participants: people.map(short) } : {}) });
            sendThreads();
          } break;
          default: break;
        }
      }
    });

    handlers['room:list']({}); // unreadCount and mention per room, before the door asks

    child.on('message', (m: FromChild) => {
      if (m.t === 'out') push('D', m.s);
      else if (m.t === 'gfx') push('G', m.s);
      else if (m.t === 'emit') onEmit(m.ev, m.data, m.ack);
      else if (m.t === 'term') {
        if (m.choice !== undefined) info.ctrl?.(`terminal-choice ${m.choice ? 1 : 0}`);
        if (m.responsive) info.ctrl?.(`responsive-doors ${m.responsive}`);
        if (m.mode) info.ctrl?.(`terminal-mode ${m.mode}`);
      }
      else if (m.t === 'end' && m.error) log(`[partyline-livechat] door ended with error: ${m.error}`);
    });
    child.on('exit', () => { off(); voice.close(); if (!closed) info.quit?.(); });

    return {
      resize(c: number, r: number) { cols = c; rows = r; tell({ t: 'resize', cols: c, rows: r }); },
      input(bytes: Buffer) { tell({ t: 'input', s: bytes.toString(enc) }); },
      media(payload: Buffer) { voice.onMedia(payload); },
      upload(payload: Buffer) { files.onUploadResult(payload.toString('latin1')); },
      render(full: boolean) { if (full) tell({ t: 'repaint' }); const parts = out; out = []; return parts; },
      close() { closed = true; off(); voice.close(); child.kill(); },
    };
  };
}
