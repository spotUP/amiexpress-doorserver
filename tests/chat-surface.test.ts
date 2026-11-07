/**
 * The chat surface over the real app: auth, sessions, rooms, messages,
 * idempotent send, text replies framed with Content-Length, DMs, moderation.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';

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

  it('delivers a direct message to the peer thread list', async () => {
    const a = await login('alice');
    const b = await login('bob');
    const r = await api('post', '/dm/bob@UPROUGH', a).send({ content: 'psst', clientId: 'd1' });
    expect([200, 201]).toContain(r.status);
    const list = await api('get', '/dm.txt', b);
    expect(list.status).toBe(200);
    expect(list.text).toContain('alice');
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
});
