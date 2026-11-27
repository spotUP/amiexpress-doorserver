/**
 * Partyline "Add Note" and "View History" live in the hub (sysop 2026-11-26), so the
 * telnet screen, web /chat and the Amiga client share one store. Any caller may add a
 * note; a sysop reads every note on a user, anyone else only their own. History is the
 * user's own top-level messages, newest 15 by default, oldest first.
 * Driven through the real routes.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';

// The history test posts 16+ messages through the routes; under machine load that passes 5 s.
jest.setTimeout(30_000);
let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function login(handle: string, sysop: boolean): Promise<string> {
  return (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop })).body.sid as string;
}
const call = (method: 'get' | 'post', path: string, sid: string) => request(fx.app)[method](`/chat/v1${path}`).set('Authorization', fx.auth).set('X-Chat-Session', sid);

describe('user notes', () => {
  it('any caller adds a note; the sysop reads all, others only their own', async () => {
    const amy = await login('amy', false);
    const zed = await login('zed', false);
    const sys = await login('spot', true);
    const add = await call('post', '/users/bob/notes', amy).send({ text: '  pays in\trare | mods  ' });
    expect(add.status).toBe(201);
    expect(add.body.id).toBeGreaterThan(0);
    expect((await call('post', '/users/bob/notes', zed).send({ text: 'second' })).status).toBe(201);
    expect((await call('post', '/users/bob/notes', zed).send({ text: '   ' })).status).toBe(400);

    const all = (await call('get', '/users/bob/notes', sys)).body as { author: string; text: string; target: string }[];
    expect(all.map((n) => n.text)).toEqual(['pays in rare mods', 'second']);
    expect(all[0].author.split('@')[0]).toBe('amy');
    expect(all[0].target.split('@')[0]).toBe('bob');
    const own = (await call('get', '/users/bob/notes', amy)).body as { text: string }[];
    expect(own.map((n) => n.text)).toEqual(['pays in rare mods']);

    const txt = await call('get', '/users/bob/notes.txt', sys);
    const lines = txt.text.split('\r\n').filter((l) => l);
    expect(lines[0]).toMatch(/^NOTES\|1\|\d+\|2$/);
    expect(lines[1].split('|')).toHaveLength(5);
  });
});

describe('user history', () => {
  it('returns the newest 15 of that user\'s messages, oldest first, room-scoped', async () => {
    const bob = await login('bob', false);
    const amy = await login('amy', false);
    const room = (await call('post', '/rooms', bob).send({ name: 'lobby' })).body.id as string;
    const other = (await call('post', '/rooms', bob).send({ name: 'other' })).body.id as string;
    for (const r of [room, other]) {
      await call('post', `/rooms/${r}/join`, bob).send({});
      await call('post', `/rooms/${r}/join`, amy).send({});
    }
    for (let i = 1; i <= 17; i++) await call('post', `/rooms/${room}/messages`, bob).send({ content: `m${i}`, clientId: `b${i}` });
    await call('post', `/rooms/${room}/messages`, amy).send({ content: 'amy talks', clientId: 'a1' });
    await call('post', `/rooms/${other}/messages`, bob).send({ content: 'elsewhere', clientId: 'o1' });

    const got = (await call('get', `/users/bob/history?room=${room}`, amy)).body as { text: string }[];
    expect(got.map((h) => h.text)).toEqual(Array.from({ length: 15 }, (_, i) => `m${i + 3}`));
    const anywhere = (await call('get', '/users/bob/history?limit=2', amy)).body as { text: string }[];
    expect(anywhere.map((h) => h.text)).toEqual(['m17', 'elsewhere']);
    expect((await call('get', `/users/nobody/history?room=${room}`, amy)).body).toEqual([]);
    const txt = await call('get', `/users/bob/history.txt?room=${room}&limit=1`, amy);
    expect(txt.text.split('\r\n')[0]).toMatch(/^HISTORY\|1\|\d+\|1$/);
  });
});
