/**
 * A browser re-drive could not make a new room: the hub refused the seventh room a board
 * created in an hour (rate_limited). The old chat has no such cap, and limiters on this
 * board block real users, so room creation is uncapped.
 */
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom } from '../src/chat/store';
import { makeAchievementsFixture } from './achievements/helpers';

const fx = makeAchievementsFixture();
const chat = loadChatConfig();
afterAll(() => { _stopChatSweepersForTests(); fx.cleanup?.(); });

test('a board can create more than six rooms in an hour', () => {
  const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'roomer', sysop: false, client: 'test' }).sid);
  for (let i = 0; i < 12; i++) {
    expect(() => withAchievementsDb(fx.ach, (db) => createRoom(db, resolveSession(db, chat, sid, fx.boardId), { name: `room${i}` }))).not.toThrow();
  }
});
