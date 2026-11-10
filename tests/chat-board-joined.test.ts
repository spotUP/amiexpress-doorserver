/**
 * board_joined: the first chat session a board ever opens announces the board
 * to every session; a second session of the same board, an admin mint and a
 * board that chatted before the migration announce nothing. Driven through the
 * real POST /chat/v1/sessions and GET /chat/v1/events.txt.
 */
import request from 'supertest';
import Database from 'better-sqlite3';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { createBoard } from '../src/achievements/boards';
import { backfillChatFirstSeen } from '../src/achievements/migrations';
import { _stopChatSweepersForTests } from '../src/chat/sessions';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

function withDb<T>(f: (db: Database.Database) => T): T {
  const db = new Database(fx.achievementsDbPath);
  try { return f(db); } finally { db.close(); }
}
const mint = (id: string, name: string): string => withDb((db) => `Board ${createBoard(db, id, name, null).key}`);

async function login(auth: string, handle: string): Promise<string> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', auth).send({ handle });
  expect(r.status).toBe(201);
  return r.body.sid as string;
}
async function joinedRows(auth: string, sid: string, name: string): Promise<string[][]> {
  const r = await request(fx.app).get('/chat/v1/events.txt?since=0&wait=0').set('Authorization', auth).set('X-Chat-Session', sid);
  expect(r.status).toBe(200);
  return r.text.split('\r\n').filter((l) => l !== '').slice(1).map((l) => l.split('|')).filter((c) => c[1] === 'board_joined' && c[7] === name);
}

describe('board_joined', () => {
  it('announces a board once, on its first chat session, to every board', async () => {
    const alice = await login(fx.auth, 'alice');
    const newAuth = mint('newbbs', 'New BBS');
    expect(await joinedRows(fx.auth, alice, 'New BBS')).toHaveLength(0); // minting is not joining

    await login(newAuth, 'carol');
    const rows = await joinedRows(fx.auth, alice, 'New BBS');
    expect(rows).toHaveLength(1);
    // seq|type|room|user|ref|at|roleColor|text|replyTo|label
    expect(rows[0].slice(1, 5)).toEqual(['board_joined', '', '', '']);
    expect(rows[0][5]).toMatch(/^\d+$/);
    expect(rows[0].slice(6)).toEqual(['', 'New BBS', '', '']);

    await login(newAuth, 'dave'); // second session of the same board
    expect(await joinedRows(fx.auth, alice, 'New BBS')).toHaveLength(1);
  });

  it('does not announce a board that chatted before the migration (backfill)', async () => {
    const alice = await login(fx.auth, 'alice');
    const oldAuth = mint('oldbbs', 'Old BBS');
    withDb((db) => {
      db.prepare("INSERT INTO chat_sessions (sid, board_id, handle, user, sysop, client, created_at, last_seen) VALUES ('x','oldbbs','z','z@OLDBBS',0,'',1,1)").run();
      backfillChatFirstSeen(db);
      db.prepare("DELETE FROM chat_sessions WHERE sid = 'x'").run();
    });
    await login(oldAuth, 'olga');
    expect(await joinedRows(fx.auth, alice, 'Old BBS')).toHaveLength(0);
  });
});
