/**
 * LIVECHAT file, upload and /draw events on the hub (src/partyline/livechat-files.ts), driven
 * against the real chat store with a stub door side, so no door child is needed.
 */
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import type { ChatCtx } from '../src/chat/sessions';
import { createRoom, joinRoom } from '../src/chat/store';
import { filesAndDrawing, UPLOAD_NOT_HERE } from '../src/partyline/livechat-files';
import type { FilesHost } from '../src/partyline/livechat-files';
import { makeAchievementsFixture } from './achievements/helpers';
import type Database from 'better-sqlite3';

const fx = makeAchievementsFixture();
const chat = loadChatConfig();
const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
const store: FilesHost['store'] = (_w, fn) => withAchievementsDb(fx.ach, (db: Database.Database) => fn(db, resolveSession(db, chat, sid, fx.boardId) as ChatCtx));
const art = store(true, (db, ctx) => createRoom(db, ctx, { name: 'art:test', kind: 'art' }));
const talk = store(true, (db, ctx) => createRoom(db, ctx, { name: 'talk' }));
for (const r of [art, talk]) store(true, (db, ctx) => joinRoom(db, ctx, r.id));

type Sent = { ev: string; data: Record<string, unknown> };
function setup(over: Partial<FilesHost> = {}, roomId = art.id): { sent: Sent[]; ctrl: string[]; f: ReturnType<typeof filesAndDrawing> } {
  const sent: Sent[] = [];
  const ctrl: string[] = [];
  const f = filesAndDrawing({
    store, reply: (ev, data) => sent.push({ ev, data }),
    str: (d, ...keys) => { for (const k of keys) if (typeof d[k] === 'string') return d[k] as string; return ''; },
    short: (u) => u.split('@')[0], room: () => ({ id: roomId, name: 'r' }), filesDir: null, uploadMode: 'web', ctrl: (t) => ctrl.push(t), ...over,
  });
  return { sent, ctrl, f };
}

afterAll(() => { _stopChatSweepersForTests(); fx.cleanup(); });

test('file list, share and preview answer from the hub when file sharing is off', () => {
  const { sent, f } = setup();
  f.handlers['file:list']({ path: '/x' });
  f.handlers['file:share']({});
  f.handlers['file:preview']({ fileId: 'nope', cols: 10, rows: 5, fmt: 'png' });
  expect(sent[0]).toEqual({ ev: 'file:list', data: { path: '/x', files: [], directories: [] } });
  expect(sent[1].ev).toBe('room:error');
  expect(sent[2]).toEqual({ ev: 'file:preview', data: { fileId: 'nope', fmt: 'png', error: 'files_disabled' } });
});

test('file upload asks the relay, refuses a second request, and ends on the relay answer', () => {
  const { sent, ctrl, f } = setup({ filesDir: '/tmp/none' });
  f.handlers['file:upload']({});
  expect(ctrl).toEqual([expect.stringMatching(/^upload \S+ 2097152 image web$/)]);
  f.handlers['file:upload']({});
  expect(sent.pop()!.data.error).toBe('A picture upload is already waiting.');
  f.onUploadResult('fail Transfer cancelled.');
  expect(sent.pop()!.data.error).toBe('Transfer cancelled.');
  f.handlers['file:upload']({});
  expect(ctrl).toHaveLength(2);
  f.onUploadResult('ok abc');
  f.handlers['file:upload']({});
  expect(ctrl).toHaveLength(3);
  const none = setup({ uploadMode: 'none' });
  none.f.handlers['file:upload']({});
  expect(none.sent[0].data.error).toBe(UPLOAD_NOT_HERE);
});

test('file_shared and canvas store events reach the door', () => {
  const { sent, f } = setup();
  expect(f.onEvent({ type: 'file_shared', room_id: 'r1', user: 'bob@b', ref: 'f1', text: 'a.png|12|image' })).toBe(true);
  expect(f.onEvent({ type: 'canvas', room_id: 'r1', user: 'bob@b', ref: '4', text: 'ops' })).toBe(true);
  expect(f.onEvent({ type: 'message', room_id: 'r1', user: 'bob@b', ref: '', text: '' })).toBe(false);
  expect(sent[0]).toEqual({ ev: 'file:shared', data: { id: 'f1', roomId: 'r1', username: 'bob', filename: 'a.png', size: 12, kind: 'image' } });
  expect(sent[1]).toEqual({ ev: 'draw:ops', data: { roomId: 'r1', rev: 4, user: 'bob', ops: 'ops' } });
});

test('draw get returns a snapshot and draw ops are refused outside an art room', () => {
  const { sent, f } = setup();
  f.handlers['draw:get']({});
  expect(sent[0].ev).toBe('draw:snapshot');
  expect(sent[0].data).toMatchObject({ roomId: art.id, rev: expect.any(Number), rows: expect.any(Array) });
  const plain = setup({}, talk.id);
  plain.f.handlers['draw:ops']({ base: 0, ops: 'x' });
  expect(plain.sent[0]).toMatchObject({ ev: 'draw:error', data: { roomId: talk.id, status: 403 } });
});
