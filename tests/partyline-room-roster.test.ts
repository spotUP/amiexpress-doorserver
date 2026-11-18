/** The room:joined reply carries the members already in the room (LIVECHAT parity), so a late joiner sees them. */
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, doorRoster, joinRoom } from '../src/chat/store';
import { makeAchievementsFixture } from './achievements/helpers';

afterAll(() => _stopChatSweepersForTests());

test('a user who joins later gets the earlier user in the roster', () => {
  const fx = makeAchievementsFixture();
  const chat = loadChatConfig();
  const sid = (handle: string): string => withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle, sysop: false, client: 'test' }).sid);
  const as = <T>(s: string, fn: (db: Parameters<typeof doorRoster>[0], ctx: ReturnType<typeof resolveSession>) => T): T =>
    withAchievementsDb(fx.ach, (db) => fn(db, resolveSession(db, chat, s, fx.boardId)));
  const a = sid('chattest');
  const b = sid('spot');
  const room = as(a, (db, ctx) => createRoom(db, ctx, { name: 'lobby' }));
  as(a, (db, ctx) => joinRoom(db, ctx, room.id));
  as(b, (db, ctx) => joinRoom(db, ctx, room.id));
  const roster = withAchievementsDb(fx.ach, (db) => doorRoster(db, room.id));
  expect(roster.map((m) => m.user_id.split('@')[0]).sort()).toEqual(['chattest', 'spot']);
  expect(roster.every((m) => m.is_online)).toBe(true);
});
