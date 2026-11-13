/**
 * Discord join wizard phase 1 (thoughts/shared/plans/2026-11-13-discord-join-wizard.md):
 * hub storage and routes. A sysop's request links a channel at once (no
 * approval); a linked channel answers 409; the bridge board publishes the
 * application id and reports failures; links.txt lists linked rows only;
 * the admin DELETE unlinks.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';

let fx: AchievementsFixture;
let discordAuth: string;
beforeEach(async () => {
  fx = makeAchievementsFixture({ admin: true });
  const token = await fx.adminToken();
  const made = await request(fx.app).post('/achievements/v1/admin/boards').set('Authorization', `Bearer ${token}`).send({ id: 'discord', name: 'Discord' });
  expect(made.status).toBe(200);
  discordAuth = `Board ${made.body.key as string}`;
  await makeLobby();
});
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

type S = { sid: string; auth: string };
async function login(auth: string, handle: string, sysop = false): Promise<S> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', auth).send({ handle, sysop });
  expect(r.status).toBe(201);
  return { sid: r.body.sid as string, auth };
}
const call = (s: S, method: 'get' | 'post' | 'put', path: string) =>
  request(fx.app)[method](`/chat/v1${path}`).set('Authorization', s.auth).set('X-Chat-Session', s.sid);
const CH = '123456789012345678';
/** The shared room is the one named lobby (CHAT_DEFAULT_ROOM_KEY); the hub operator creates it. */
async function makeLobby(): Promise<void> {
  const owner = await login(fx.auth, 'owner', true);
  expect((await call(owner, 'post', '/rooms').send({ name: 'lobby' })).status).toBe(201);
}

describe('discord join', () => {
  it('refuses a non-sysop and a bad channel id', async () => {
    const user = await login(fx.auth, 'alice');
    expect((await call(user, 'post', '/discord/join').send({ channelId: CH })).status).toBe(403);
    const sys = await login(fx.auth, 'sys', true);
    expect((await call(sys, 'post', '/discord/join').send({ channelId: 'abc' })).status).toBe(400);
    expect((await call(sys, 'post', '/discord/join').send({})).status).toBe(400);
  });

  it('links at once, lists own requests, answers 409 for a linked channel', async () => {
    const sys = await login(fx.auth, 'sys', true);
    const a = await call(sys, 'post', '/discord/join').send({ channelId: CH });
    expect(a.status).toBe(201);
    expect(a.body.status).toBe('linked');
    const list = await call(sys, 'get', '/discord/join');
    expect(list.body).toEqual([{ id: a.body.id, channelId: CH, status: 'linked', error: '' }]);
    const dup = await call(sys, 'post', '/discord/join').send({ channelId: CH });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('conflict');
  });

  it('invite is 404 until the bridge publishes the application id; only the bridge board may publish', async () => {
    const sys = await login(fx.auth, 'sys', true);
    const bridge = await login(discordAuth, 'bridge');
    expect((await call(sys, 'get', '/discord/invite')).status).toBe(404);
    expect((await call(sys, 'put', '/discord/app').send({ applicationId: '987654321098765432' })).status).toBe(403);
    expect((await call(bridge, 'put', '/discord/app').send({ applicationId: 'nope' })).status).toBe(400);
    expect((await call(bridge, 'put', '/discord/app').send({ applicationId: '987654321098765432' })).status).toBe(200);
    const inv = await call(sys, 'get', '/discord/invite');
    expect(inv.status).toBe(200);
    expect(inv.body.applicationId).toBe('987654321098765432');
    expect(inv.body.url).toContain('client_id=987654321098765432');
  });

  it('links.txt lists linked rows; a reported failure drops the row, shows the error, and the channel can be requested again', async () => {
    const sys = await login(fx.auth, 'sys', true);
    const bridge = await login(discordAuth, 'bridge');
    const a = await call(sys, 'post', '/discord/join').send({ channelId: CH });
    const txt = await call(bridge, 'get', '/discord/links.txt');
    const lines = txt.text.split('\r\n').filter((l) => l);
    expect(lines[0]).toMatch(/^DISCORD_LINKS\|/);
    expect(lines).toHaveLength(2);
    expect(lines[1].split('|').slice(2, 3)).toEqual([CH]);

    expect((await call(sys, 'post', `/discord/links/${a.body.id}/error`).send({ error: 'x' })).status).toBe(403);
    expect((await call(bridge, 'post', `/discord/links/${a.body.id}/error`).send({ error: 'Missing Access' })).status).toBe(200);
    expect((await call(bridge, 'get', '/discord/links.txt')).text.split('\r\n').filter((l) => l)).toHaveLength(1);
    const list = await call(sys, 'get', '/discord/join');
    expect(list.body[0]).toMatchObject({ status: 'failed', error: 'Missing Access' });
    const again = await call(sys, 'post', '/discord/join').send({ channelId: CH });
    expect(again.status).toBe(201);
    expect((await call(sys, 'get', '/discord/join')).body).toHaveLength(1);
  });

  it('admin DELETE unlinks; it needs the admin token', async () => {
    const sys = await login(fx.auth, 'sys', true);
    const a = await call(sys, 'post', '/discord/join').send({ channelId: CH });
    const url = `/achievements/v1/admin/discord/links/${a.body.id as number}`;
    expect([401, 403]).toContain((await request(fx.app).delete(url)).status);
    const token = await fx.adminToken();
    expect((await request(fx.app).delete(url).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(fx.app).delete(url).set('Authorization', `Bearer ${token}`)).status).toBe(404);
    expect((await call(sys, 'post', '/discord/join').send({ channelId: CH })).status).toBe(201);
  });
});
