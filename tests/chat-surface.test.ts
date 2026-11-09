/**
 * The chat surface over the real app: auth, sessions, rooms, messages,
 * idempotent send, text replies framed with Content-Length, DMs, moderation.
 */
import request from 'supertest';
import { openAchievementsDb } from '../src/achievements/db';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { _resetRateLimitsForTests } from '../src/achievements/ratelimit';
import { CHAT_DEFAULT_ROOM_KEY, CHAT_LIMITS } from '../contract/chat-types';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string, sysop = false): Promise<string> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop });
  expect(r.status).toBe(201);
  return r.body.sid as string;
}
const as = (sid: string) => ({ Authorization: '', 'X-Chat-Session': sid });
function api(method: 'get' | 'post' | 'put' | 'delete', path: string, sid?: string) {
  const r = request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth);
  return sid ? r.set('X-Chat-Session', sid) : r;
}

describe('chat surface', () => {
  it('health needs no key and echoes the contract header', async () => {
    const r = await request(fx.app).get('/chat/v1/health');
    expect(r.status).toBe(200);
    expect(r.headers['x-chat-contract']).toBeDefined();
  });

  it('refuses a missing board key and a missing session', async () => {
    expect((await request(fx.app).get('/chat/v1/rooms')).status).toBe(401);
    expect((await api('get', '/rooms')).status).toBe(401);
    void as;
  });

  it('creates a room, joins, sends once per clientId, and reads text history with Content-Length', async () => {
    const sid = await login('alice');
    const room = await api('post', '/rooms', sid).send({ name: 'lobby' });
    expect(room.status).toBe(201);
    const id = room.body.id as string;
    expect((await api('post', `/rooms/${id}/join`, sid)).status).toBe(200);
    const a = await api('post', `/rooms/${id}/messages`, sid).send({ content: 'hello', clientId: 'c1' });
    const b = await api('post', `/rooms/${id}/messages`, sid).send({ content: 'hello', clientId: 'c1' });
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    const h = await api('get', `/rooms/${id}/history.txt`, sid);
    expect(h.status).toBe(200);
    expect(h.headers['content-length']).toBeDefined();
    expect(h.headers['transfer-encoding']).toBeUndefined();
    expect(h.headers.connection).toBe('close');
    expect(h.text.startsWith('HISTORY|')).toBe(true);
    expect(h.text.match(/hello/g)).toHaveLength(1);
    expect(h.text.endsWith('\r\n')).toBe(true);
  });

  it('lists the default room first even when another room sorts before it', async () => {
    const sid = await login('alice');
    for (const name of ['zeta', 'amiga', CHAT_DEFAULT_ROOM_KEY]) {
      expect((await api('post', '/rooms', sid).send({ name })).status).toBe(201);
    }
    const r = await api('get', '/rooms', sid);
    expect(r.status).toBe(200);
    const names = (r.body as { name: string }[]).map((x) => x.name);
    expect(names).toEqual([CHAT_DEFAULT_ROOM_KEY, 'amiga', 'zeta']);
  });

  it('delivers a direct message to the peer thread list', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const r = await api('post', '/dm/bob@UPROUGH', a).send({ content: 'psst', clientId: 'd1' });
    expect([200, 201]).toContain(r.status);
    const list = await api('get', '/dm.txt', b);
    expect(list.status).toBe(200);
    expect(list.text).toContain('alice');
  });

  describe('direct messages refuse unknown targets', () => {
    function count(table: string): number {
      const db = openAchievementsDb(fx.ach, { readonly: true });
      try { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; } finally { db.close(); }
    }
    const dmCount = (): number => count('chat_dm_messages');
    it('unknown board -> 404 not_found', async () => {
      const a = await login('alice');
      const r = await api('post', '/dm/bob@NOSUCHBOARD', a).send({ content: 'x', clientId: 'u1' });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('not_found');
      expect(dmCount()).toBe(0);
    });
    it('known board, user never seen -> 404; once seen (any case) -> 201', async () => {
      const a = await login('alice');
      const miss = await api('post', '/dm/ghost@UPROUGH', a).send({ content: 'x', clientId: 'u2' });
      expect(miss.status).toBe(404);
      expect(miss.body.error).toBe('not_found');
      await login('ghost');
      const hit = await api('post', '/dm/GHOST@uprough', a).send({ content: 'x', clientId: 'u3' });
      expect(hit.status).toBe(201);
    });
    it('a group with one unknown member is refused whole, names the member, inserts nothing', async () => {
      const a = await login('alice'); await login('bob');
      const r = await api('post', '/dm-group', a).send({ participants: ['bob@UPROUGH', 'nobody@UPROUGH'], content: 'x', clientId: 'u4' });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('not_found');
      expect(r.body.detail).toContain('nobody@UPROUGH');
      expect(r.body.detail).not.toContain('bob@');
      expect(dmCount()).toBe(0);
      expect(count('chat_dm_members')).toBe(0);
    });
  });

  describe('group direct messages', () => {
    const ppl = ['bob@UPROUGH', 'carol@UPROUGH'];
    it('a 3-member post reaches both recipients and not a non-member', async () => {
      const a = await login('alice'); const b = await login('bob'); const c = await login('carol'); const d = await login('dave');
      const r = await api('post', '/dm-group', a).send({ participants: ppl, content: 'hi trio', clientId: 'g1' });
      expect(r.status).toBe(201);
      expect(r.body.threadId).toMatch(/^dg[0-9a-f]{12}$/);
      const dup = await api('post', '/dm-group', a).send({ participants: ppl, content: 'hi trio', clientId: 'g1' });
      expect(dup.body.id).toBe(r.body.id);
      for (const sid of [b, c]) {
        const ev = await api('get', '/events.txt?since=0&wait=0', sid);
        expect(ev.text).toContain(`|dm|${r.body.threadId}|alice@UPROUGH|`);
        expect(ev.text).toContain('hi trio');
      }
      const evD = await api('get', '/events.txt?since=0&wait=0', d);
      expect(evD.text).not.toContain('hi trio');
    });
    it('rejects a group that has fewer than 3 unique members with the exact text', async () => {
      const a = await login('alice');
      const r = await api('post', '/dm-group', a).send({ participants: ['bob@UPROUGH', 'alice@UPROUGH'], content: 'x', clientId: 'g2' });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toContain('Group DM needs 3+ unique participants (use /msg for 1:1)');
    });
    it('dm.txt lists the group with comma-joined peers and history is member-only', async () => {
      const a = await login('alice'); const b = await login('bob'); await login('carol'); const d = await login('dave');
      const r = await api('post', '/dm-group', a).send({ participants: ppl, content: 'secret', clientId: 'g3' });
      const list = await api('get', '/dm.txt', b);
      expect(list.text).toContain(`${r.body.threadId}|alice@UPROUGH,carol@UPROUGH|`);
      expect(list.text).toMatch(new RegExp(`${r.body.threadId}\\|alice@UPROUGH,carol@UPROUGH\\|\\d+\\|1`));
      const h = await api('get', `/dm/${r.body.threadId}/history.txt`, b);
      expect(h.status).toBe(200);
      expect(h.text).toContain('secret');
      expect((await api('get', '/dm.txt', b)).text).toMatch(new RegExp(`${r.body.threadId}\\|[^|]*\\|\\d+\\|0`));
      const denied = await api('get', `/dm/${r.body.threadId}/history.txt`, d);
      expect(denied.status).toBe(403);
      expect((await api('get', '/dm.txt', d)).text).not.toContain(r.body.threadId);
    });
  });

  it('a non-member cannot moderate; the owner can kick', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const id = (await api('post', '/rooms', a).send({ name: 'den' })).body.id as string;
    await api('post', `/rooms/${id}/join`, b);
    const denied = await api('post', `/rooms/${id}/kick`, b).send({ user: 'alice@UPROUGH' });
    expect(denied.status).toBe(403);
    const ok = await api('post', `/rooms/${id}/kick`, a).send({ user: 'bob@UPROUGH' });
    expect(ok.status).toBe(200);
  });

  it('unknown route is a JSON 404 and a deleted session is expired', async () => {
    const sid = await login('alice');
    expect((await api('get', '/nope', sid)).status).toBe(404);
    expect((await api('delete', '/sessions/current', sid)).status).toBe(200);
    expect((await api('get', '/rooms', sid)).status).toBe(401);
  });

  it('refuses the message after the per-session limit with 429 and Retry-After', async () => {
    _resetRateLimitsForTests();
    const sid = await login('flood');
    const id = (await api('post', '/rooms', sid).send({ name: 'floodroom' })).body.id as string;
    expect((await api('post', `/rooms/${id}/join`, sid)).status).toBe(200);
    for (let i = 0; i < CHAT_LIMITS.messagesPerSession; i++) {
      expect((await api('post', `/rooms/${id}/messages`, sid).send({ content: `m${i}`, clientId: `f${i}` })).status).toBe(201);
    }
    const over = await api('post', `/rooms/${id}/messages`, sid).send({ content: 'one too many', clientId: 'over' });
    expect(over.status).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    _resetRateLimitsForTests();
  });
});
