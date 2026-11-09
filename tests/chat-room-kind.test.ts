/**
 * Channel type: creating a room records whether it is text, voice or art.
 * Default is text, an unknown kind is refused, and both the JSON create reply
 * and the plain-text rooms.txt (last field) carry it. Driven through the real
 * POST /chat/v1/rooms and GET /chat/v1/rooms.txt.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { CHAT_TEXT_FORMATS } from '../contract/chat-types';

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string): Promise<string> {
  return (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop: true })).body.sid as string;
}
const call = (method: 'get' | 'post', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

describe('room kind', () => {
  it('stores text, voice or art, defaults to text, refuses anything else', async () => {
    const sid = await login('sys');
    const plain = await call('post', '/rooms', sid).send({ name: 'lobby' });
    expect(plain.status).toBe(201);
    expect(plain.body.kind).toBe('text');
    expect((await call('post', '/rooms', sid).send({ name: 'talk', kind: 'voice' })).body.kind).toBe('voice');
    expect((await call('post', '/rooms', sid).send({ name: 'paint', kind: 'art' })).body.kind).toBe('art');
    expect((await call('post', '/rooms', sid).send({ name: 'bad', kind: 'video' })).status).toBe(400);

    const txt = await call('get', '/rooms.txt', sid);
    expect(txt.status).toBe(200);
    const kindAt = CHAT_TEXT_FORMATS.ROOMS.indexOf('kind');
    expect(kindAt).toBe(CHAT_TEXT_FORMATS.ROOMS.length - 1);
    const kinds = Object.fromEntries(txt.text.split('\r\n').filter((l) => l !== '').slice(1).map((l) => l.split('|')).map((c) => [c[1], c[kindAt]]));
    expect(kinds).toEqual({ lobby: 'text', talk: 'voice', paint: 'art' });
  });
});
