/**
 * Multi-channel membership on the LIVECHAT host: switching the viewed room never leaves
 * the others, background rooms are relayed with `channel`, and unread survives a switch.
 * The door child is faked: the test plays the door's socket emits and reads the host's events.
 */
import { EventEmitter } from 'events';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import type { ChatCtx } from '../src/chat/sessions';
import { createRoom, joinRoom, listMemberships, listRooms, postMessage } from '../src/chat/store';
import { livechatScreen } from '../src/partyline/livechat-host';
import type { PartylineScreen, ScreenInfo } from '../src/partyline/session';
import { makeAchievementsFixture } from './achievements/helpers';
import type Database from 'better-sqlite3';

type Sent = { t: string; ev?: string; data?: Record<string, unknown> };
const kids: (EventEmitter & { sent: Sent[] })[] = [];
jest.mock('child_process', () => ({
  fork: () => {
    const c = Object.assign(new EventEmitter(), {
      connected: true, exitCode: null, pid: 1, stdout: null, stderr: null, channel: { ref() {}, unref() {} },
      sent: [] as Sent[], send(m: Sent) { this.sent.push(m); }, ref() {}, unref() {}, kill() {},
    });
    kids.push(c);
    return c;
  },
}));

const fx = makeAchievementsFixture();
const chat = loadChatConfig();
const peek = <T>(sid: string, fn: (db: Database.Database, ctx: ChatCtx) => T): T =>
  withAchievementsDb(fx.ach, (db) => fn(db, resolveSession(db, chat, sid, fx.boardId)));
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
  if (!ok()) throw new Error('timed out');
};

let alice: PartylineScreen;
let aliceKid: EventEmitter & { sent: Sent[] };
let aliceSid: string;
let bobSid: string;
const evs = (name: string): Record<string, unknown>[] => aliceKid.sent.filter((m) => m.t === 'event' && m.ev === name).map((m) => m.data ?? {});
const door = (ev: string, data: Record<string, unknown>): void => { aliceKid.emit('message', { t: 'emit', ev, data }); };
const unreadOf = (name: string): number => peek(aliceSid, (db, ctx) => listMemberships(db, ctx)).find((m) => m.name === name)?.unread ?? -1;

beforeAll(() => {
  aliceSid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'alice', sysop: false, client: 'test' }).sid);
  bobSid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: false, client: 'test' }).sid);
  for (const name of ['general', 'dev']) peek(bobSid, (db, ctx) => joinRoom(db, ctx, createRoom(db, ctx, { name }).id));
  const factory = livechatScreen(fx.ach, chat, '/nonexistent', () => {});
  alice = factory({ sid: aliceSid, user: 'alice', boardId: fx.boardId, hello: { cols: 80, rows: 25, access: 10, sysop: false } as ScreenInfo['hello'], markDirty: () => {}, quit: () => {}, ctrl: () => {} });
  aliceKid = kids[kids.length - 2]; // the spare started after the caller's child is last
});
afterAll(() => { alice.close?.(); _stopChatSweepersForTests(); fx.cleanup?.(); });

const say = (room: string, text: string): void => {
  const id = peek(bobSid, (db, ctx) => listRooms(db, ctx)).find((r) => r.name === room)!.id;
  peek(bobSid, (db, ctx) => postMessage(db, ctx, id, { content: text, clientId: `c${Math.random()}` }));
};

test('entry joins every public room and room:list carries unreadCount and mention', () => {
  const rooms = (evs('room:list').pop()?.rooms ?? []) as { room_name: string; unreadCount: number; mention: boolean }[];
  expect(rooms.map((r) => r.room_name).sort()).toEqual(['dev', 'general']);
  expect(rooms.every((r) => r.unreadCount === 0 && r.mention === false)).toBe(true);
  expect(peek(aliceSid, (db, ctx) => listMemberships(db, ctx)).map((m) => m.name).sort()).toEqual(['dev', 'general']);
});

test('switching rooms keeps membership; a background message is relayed with channel; unread clears on switching back', async () => {
  door('room:join', { roomName: 'general' });
  door('room:join', { roomName: 'dev' }); // switch: no room:leave
  expect(peek(aliceSid, (db, ctx) => listMemberships(db, ctx)).map((m) => m.name).sort()).toEqual(['dev', 'general']);
  say('general', 'hello background');
  await until(() => evs('chat:message').some((d) => d.content === 'hello background'));
  expect(evs('chat:message').find((d) => d.content === 'hello background')?.channel).toBe('general');
  expect(unreadOf('general')).toBe(1); // survives the switch, not cleared by the relay
  say('dev', 'hello active');
  await until(() => evs('chat:message').some((d) => d.content === 'hello active'));
  expect(evs('chat:message').find((d) => d.content === 'hello active')?.channel).toBe('dev');
  expect(unreadOf('dev')).toBe(0); // the viewed room reads as it arrives
  door('room:join', { roomName: 'general' });
  expect(unreadOf('general')).toBe(0);
  const joined = evs('room:joined').pop();
  expect(joined?.channel).toBe('general');
  expect((joined?.history as unknown[]).length).toBe(1);
});

test('room:leave is explicit and ends only that membership', () => {
  door('room:leave', { roomName: 'dev' });
  expect(peek(aliceSid, (db, ctx) => listMemberships(db, ctx)).map((m) => m.name)).toEqual(['general']);
});

test('a public room created after entry is joined automatically, active room unchanged', async () => {
  door('room:join', { roomName: 'general' });
  peek(bobSid, (db, ctx) => joinRoom(db, ctx, createRoom(db, ctx, { name: 'late' }).id));
  await until(() => ((evs('room:list').pop()?.rooms ?? []) as { room_name: string }[]).some((r) => r.room_name === 'late'));
  expect(peek(aliceSid, (db, ctx) => listMemberships(db, ctx)).map((m) => m.name)).toContain('late');
  expect(evs('room:joined').pop()?.channel).toBe('general');
});
