/**
 * LIVECHAT host: a room_renamed event reaches the door as room:renamed, the host's
 * active-room and joined-map names follow it, and room:list is pushed again.
 * The door child is faked, as in partyline-livechat-multichannel.test.ts.
 */
import { EventEmitter } from 'events';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import type { ChatCtx } from '../src/chat/sessions';
import { createRoom, joinRoom, listRooms, postMessage, renameRoom } from '../src/chat/store';
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
let bobSid: string;
const evs = (name: string): Record<string, unknown>[] => aliceKid.sent.filter((m) => m.t === 'event' && m.ev === name).map((m) => m.data ?? {});

beforeAll(() => {
  const aliceSid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'alice', sysop: false, client: 'test' }).sid);
  bobSid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
  peek(bobSid, (db, ctx) => joinRoom(db, ctx, createRoom(db, ctx, { name: 'general' }).id));
  const factory = livechatScreen(fx.ach, chat, '/nonexistent', () => {});
  alice = factory({ sid: aliceSid, user: 'alice', boardId: fx.boardId, hello: { cols: 80, rows: 25, access: 10, sysop: false } as ScreenInfo['hello'], markDirty: () => {}, quit: () => {}, ctrl: () => {} });
  aliceKid = kids[kids.length - 2];
  aliceKid.emit('message', { t: 'emit', ev: 'room:join', data: { roomName: 'general' } });
});
afterAll(() => { alice.close?.(); _stopChatSweepersForTests(); fx.cleanup?.(); });

test('a renamed room is announced, the host follows the new name, and room:list is pushed', async () => {
  const id = peek(bobSid, (db, ctx) => listRooms(db, ctx)).find((r) => r.name === 'general')!.id;
  const lists = evs('room:list').length;
  peek(bobSid, (db, ctx) => renameRoom(db, ctx, id, { name: 'lounge' }));
  await until(() => evs('room:renamed').length > 0 && evs('room:list').length > lists);
  expect(evs('room:renamed').pop()).toMatchObject({ roomId: id, roomName: 'lounge', by: expect.stringContaining('bob') });
  expect(evs('room:renamed').pop()).toHaveProperty('channel');
  const rooms = (evs('room:list').pop()?.rooms ?? []) as { room_name: string }[];
  expect(rooms.map((r) => r.room_name)).toContain('lounge');
  // Active room and joined map carry the new name: a later message is relayed under it.
  peek(bobSid, (db, ctx) => postMessage(db, ctx, id, { content: 'after rename', clientId: 'ren-1' }));
  await until(() => evs('chat:message').some((d) => d.content === 'after rename'));
  expect(evs('chat:message').find((d) => d.content === 'after rename')?.channel).toBe('lounge');
});
