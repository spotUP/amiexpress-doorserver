/**
 * LIVECHAT drops a deleted channel for every connected user: ChannelOps.delete broadcasts
 * 'chat:channel-deleted' (board/Doors/livechat/services/channel-ops.ts:51). The hub must hand
 * `room_deleted` to every session that could list the room, public or private, even though
 * deleteRoom removes the members before the other session's poll runs.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, deleteRoom, archiveRoom, invite, joinRoom } from '../src/chat/store';
import { fetchVisibleEvents, headSeq } from '../src/chat/events';

describe('room_deleted reaches the other user (LIVECHAT channel-deleted parity)', () => {
  let fx: AchievementsFixture;
  const chat = loadChatConfig();
  beforeEach(() => { fx = makeAchievementsFixture(); });
  afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

  it.each([
    ['public', 'delete'], ['private', 'delete'], ['private', 'archive'],
  ] as const)('a %s room %s reaches the other member', (visibility, how) => {
    withAchievementsDb(fx.ach, (db) => {
      const bob = createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid;
      const alice = createSession(db, chat, fx.boardId, { handle: 'alice', sysop: false, client: 'test' }).sid;
      const bobCtx = resolveSession(db, chat, bob, fx.boardId);
      const aliceCtx = resolveSession(db, chat, alice, fx.boardId);
      const id = createRoom(db, bobCtx, { name: 'doomed', visibility }).id;
      if (visibility === 'private') invite(db, bobCtx, id, { user: aliceCtx.user }, true);
      joinRoom(db, aliceCtx, id);
      const since = headSeq(db);
      if (how === 'delete') deleteRoom(db, bobCtx, id); else archiveRoom(db, bobCtx, id);
      const seen = fetchVisibleEvents(db, alice, aliceCtx.user, since, fx.boardId);
      expect(seen.some((e) => e.type === 'room_deleted' && e.room_id === id)).toBe(true);
    });
  });
});
