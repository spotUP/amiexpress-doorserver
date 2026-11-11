/**
 * H4: typing events must not crowd the replay window. A poll returns at most
 * CHAT_LIMITS.eventsPerPoll events; a user typing keystroke by keystroke used to
 * fill it, so a real message behind the noise was not delivered. The latest
 * typing event per user and room is all the log keeps.
 */
import { CHAT_LIMITS } from '../contract/chat-types';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { emitEvent, fetchVisibleEvents } from '../src/chat/events';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => fx.cleanup());

describe('typing events and the replay window', () => {
  it('keeps one typing event per user and room, so a message behind the noise is still replayed', () => {
    const db = fx.openAchievements();
    try {
      const room = 'r1';
      const user = 'bob@uprough';
      db.prepare("INSERT INTO chat_members (room_id, sid, user, joined_at) VALUES (?, 's1', 'sys@uprough', 0)").run(room);
      for (let i = 0; i < CHAT_LIMITS.eventsPerPoll + 50; i++) emitEvent(db, { type: 'typing', roomId: room, user, text: `t${i}` });
      emitEvent(db, { type: 'typing', roomId: room, user: 'amy@uprough', text: 'other user' });
      emitEvent(db, { type: 'message', roomId: room, user, ref: 'm1', text: 'real message' });

      const evs = fetchVisibleEvents(db, 's1', 'sys@uprough', 0, 'uprough');
      expect(evs.filter((e) => e.type === 'message').map((e) => e.ref)).toEqual(['m1']);
      expect(evs.filter((e) => e.type === 'typing').map((e) => [e.user, e.text])).toEqual([
        [user, `t${CHAT_LIMITS.eventsPerPoll + 49}`],
        ['amy@uprough', 'other user'],
      ]);
    } finally {
      db.close();
    }
  });
});
