/**
 * resolveSession rewrites last_seen only when the stored stamp is at least the slack (15 s at the
 * 90 s TTL) old. Every hub request resolves its session; a write per request (voice PUTs at 2/s)
 * was the hub's p95 (2026-11-26: p95 601 ms hub-direct).
 */
import type Database from 'better-sqlite3';
import { withAchievementsDb } from '../src/achievements/db';
import { _setChatClockForTests, loadChatConfig } from '../src/chat/config';
import { createSession, lastSeenSlackSeconds, resolveSession, sweepSessions, _stopChatSweepersForTests } from '../src/chat/sessions';
import { _clearBoardKeyCacheForTests } from '../src/achievements/boards';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';

let fx: AchievementsFixture;
let now = 1_800_000_000;
beforeEach(() => { fx = makeAchievementsFixture(); now = 1_800_000_000; _setChatClockForTests(() => now); });
afterEach(() => { _setChatClockForTests(null); _stopChatSweepersForTests(); _clearBoardKeyCacheForTests(); fx.cleanup(); });

/** Count UPDATE chat_sessions SET last_seen statements prepared on this handle. */
function countTouches(db: Database.Database): () => number {
  let n = 0;
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => Database.Statement }).prepare = (sql: string) => {
    if (/UPDATE chat_sessions SET last_seen/.test(sql)) n++;
    return prepare(sql);
  };
  return () => n;
}

describe('resolveSession last_seen touch', () => {
  it('writes once within the slack window and again once the stamp is 15 s old', () => {
    const chat = loadChatConfig();
    expect(lastSeenSlackSeconds(chat)).toBe(15);
    withAchievementsDb(fx.ach, (db) => {
      const { sid } = createSession(db, chat, fx.boardId, { handle: 'bob', sysop: false, client: 'test' });
      const touches = countTouches(db);
      const stamp = (): number => (db.prepare('SELECT last_seen FROM chat_sessions WHERE sid = ?').get(sid) as { last_seen: number }).last_seen;

      now += 15; // stale by exactly the slack: rewritten
      resolveSession(db, chat, sid, fx.boardId);
      expect(touches()).toBe(1);
      now += 1;
      resolveSession(db, chat, sid, fx.boardId);
      now += 13; // 14 s after the write: still inside the window
      resolveSession(db, chat, sid, fx.boardId);
      expect(touches()).toBe(1);
      expect(stamp()).toBe(now - 14);
      now += 1; // 15 s after the write
      resolveSession(db, chat, sid, fx.boardId);
      expect(touches()).toBe(2);
      expect(stamp()).toBe(now);
    });
  });

  it('keeps a session alive whose requests come every ttl - slack seconds', () => {
    const chat = loadChatConfig();
    withAchievementsDb(fx.ach, (db) => {
      const { sid } = createSession(db, chat, fx.boardId, { handle: 'bob', sysop: false, client: 'test' });
      const gap = chat.sessionTtlSeconds - lastSeenSlackSeconds(chat);
      for (let i = 0; i < 5; i++) {
        now += 14; // a request just inside the slack: not written
        resolveSession(db, chat, sid, fx.boardId);
        now += gap; // the longest gap the slack still allows
        expect(sweepSessions(db, chat)).toBe(0);
        expect(resolveSession(db, chat, sid, fx.boardId).sid).toBe(sid);
      }
    });
  });

  it('scales the slack down for a short configured TTL', () => {
    expect(lastSeenSlackSeconds({ ...loadChatConfig(), sessionTtlSeconds: 12 })).toBe(2);
  });
});
