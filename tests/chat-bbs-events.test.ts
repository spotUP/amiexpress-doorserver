/**
 * bbs events: a board relays its own BBS events (login, upload, door activity
 * and so on) through POST /chat/v1/bbs-events; only chat sessions of that board
 * see them. Driven through the real POST /chat/v1/bbs-events and
 * GET /chat/v1/events.txt.
 */
import request from 'supertest';
import Database from 'better-sqlite3';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { createBoard } from '../src/achievements/boards';
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
async function bbsRows(auth: string, sid: string): Promise<string[][]> {
  const r = await request(fx.app).get('/chat/v1/events.txt?since=0&wait=0').set('Authorization', auth).set('X-Chat-Session', sid);
  expect(r.status).toBe(200);
  return r.text.split('\r\n').filter((l) => l !== '').slice(1).map((l) => l.split('|')).filter((c) => c[1] === 'bbs');
}

describe('POST /chat/v1/bbs-events', () => {
  it('shows a relayed event to sessions of the posting board only', async () => {
    const alice = await login(fx.auth, 'alice');
    const otherAuth = mint('otherbbs', 'Other BBS');
    const olga = await login(otherAuth, 'olga');

    const r = await request(fx.app).post('/chat/v1/bbs-events').set('Authorization', fx.auth).send({
      type: 'upload', username: 'bob', nodeId: 2,
      data: { fileName: 'demo.lha', fileSize: 2048, conferenceName: 'Amiga', secret: 'dropped', nested: { a: 1 } },
    });
    expect(r.status).toBe(204);

    const rows = await bbsRows(fx.auth, alice);
    expect(rows).toHaveLength(1);
    // seq|type|label|user|ref|at|roleColor|text|replyTo
    expect(rows[0].slice(1, 5)).toEqual(['bbs', '2', 'bob', 'upload']);
    expect(rows[0][5]).toMatch(/^\d+$/);
    const data = new URLSearchParams(rows[0][7]);
    expect(Object.fromEntries(data)).toEqual({ fileName: 'demo.lha', fileSize: '2048', conferenceName: 'Amiga' });

    expect(await bbsRows(otherAuth, olga)).toHaveLength(0);
  });

  it('relays a board system notice with no user to that board only', async () => {
    // The board's SYSTEM UPDATE countdown: LIVECHAT68 prints it in its chat log.
    const alice = await login(fx.auth, 'alice');
    const otherAuth = mint('otherbbs', 'Other BBS');
    const olga = await login(otherAuth, 'olga');

    const r = await request(fx.app).post('/chat/v1/bbs-events').set('Authorization', fx.auth).send({
      type: 'system_notice', username: '', nodeId: 0, data: { message: 'SYSTEM UPDATE: restarting in 60 seconds' },
    });
    expect(r.status).toBe(204);

    const rows = await bbsRows(fx.auth, alice);
    expect(rows).toHaveLength(1);
    expect(rows[0][4]).toBe('system_notice');
    expect(new URLSearchParams(rows[0][7]).get('message')).toBe('SYSTEM UPDATE: restarting in 60 seconds');
    expect(await bbsRows(otherAuth, olga)).toHaveLength(0);
  });

  it('still refuses an empty user on a user event', async () => {
    const r = await request(fx.app).post('/chat/v1/bbs-events').set('Authorization', fx.auth).send({ type: 'user_login', username: '', nodeId: 1 });
    expect(r.status).toBe(400);
  });

  it('refuses an unknown type, a bad node and a missing board key', async () => {
    const bad = await request(fx.app).post('/chat/v1/bbs-events').set('Authorization', fx.auth).send({ type: 'reboot', username: 'bob', nodeId: 1 });
    expect(bad.status).toBe(400);
    const node = await request(fx.app).post('/chat/v1/bbs-events').set('Authorization', fx.auth).send({ type: 'user_login', username: 'bob', nodeId: 1.5 });
    expect(node.status).toBe(400);
    const anon = await request(fx.app).post('/chat/v1/bbs-events').send({ type: 'user_login', username: 'bob', nodeId: 1 });
    expect(anon.status).toBe(401);
  });
});
