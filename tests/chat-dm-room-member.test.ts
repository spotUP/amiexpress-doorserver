/**
 * Partyline sysop retest: "/msg @regress hi" said "unknown user". regress was a room member
 * (listed in the sidebar, so Tab completed the nick) whose chat session had ended and who had
 * never posted, so the DM target check did not count them. A room member is a known person.
 */
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, resolveSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import type { ChatCtx } from '../src/chat/sessions';
import { createRoom, joinRoom, postDm } from '../src/chat/store';
import { makeAchievementsFixture } from './achievements/helpers';
import type Database from 'better-sqlite3';

const fx = makeAchievementsFixture();
const chat = loadChatConfig();
const peek = <T>(sid: string, fn: (db: Database.Database, ctx: ChatCtx) => T): T =>
  withAchievementsDb(fx.ach, (db) => fn(db, resolveSession(db, chat, sid, fx.boardId)));
afterAll(() => { _stopChatSweepersForTests(); fx.cleanup?.(); });

test('a DM to a room member with no live session and no messages is delivered', () => {
  const spot = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'spot', sysop: true, client: 'test' }).sid);
  const reg = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'regress', sysop: false, client: 'test' }));
  const room = peek(spot, (db, ctx) => createRoom(db, ctx, { name: 'general' }).id);
  peek(reg.sid, (db, ctx) => joinRoom(db, ctx, room));
  const regressUser = peek(reg.sid, (_db, ctx) => ctx.user);
  withAchievementsDb(fx.ach, (db) => db.prepare('DELETE FROM chat_sessions WHERE sid = ?').run(reg.sid)); // session ended, membership stays
  expect(() => peek(spot, (db, ctx) => postDm(db, ctx, regressUser, { content: 'hi', clientId: 'c1' }))).not.toThrow();
});

test('a DM to a handle the hub has never seen is still refused', () => {
  const spot = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'spot2', sysop: false, client: 'test' }).sid);
  const ghost = peek(spot, (_db, ctx) => `nobody${ctx.user.slice(ctx.user.indexOf('@'))}`);
  expect(() => peek(spot, (db, ctx) => postDm(db, ctx, ghost, { content: 'hi', clientId: 'c2' }))).toThrow(/unknown user/);
});
