/**
 * Discord bridge phase 1 (thoughts/shared/plans/2026-11-09-livechat-discord-bridge.md):
 * a relay board speaks `as` its own users through one session, every other
 * board is refused with not_relay; a board sysop's /discord on|off; and the
 * D7 display labels with the ` [Discord]` marker. Driven through the real
 * HTTP routes: the admin relay route, POST /rooms/:id/messages and the
 * message routes, GET history.txt / members.txt / who.txt / events.txt and
 * PUT /discord.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { displayLabels, markOrigin } from '../src/chat/render';

let fx: AchievementsFixture;
let discordAuth: string;
beforeEach(async () => {
  fx = makeAchievementsFixture({ admin: true });
  const token = await fx.adminToken();
  const made = await request(fx.app).post('/achievements/v1/admin/boards').set('Authorization', `Bearer ${token}`).send({ id: 'discord', name: 'Discord' });
  expect(made.status).toBe(200);
  discordAuth = `Board ${made.body.key as string}`;
});
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

async function markRelay(relay: boolean): Promise<request.Response> {
  const token = await fx.adminToken();
  return request(fx.app).post(`/achievements/v1/admin/boards/discord/${relay ? 'relay' : 'unrelay'}`).set('Authorization', `Bearer ${token}`);
}
async function login(auth: string, handle: string, sysop = false): Promise<{ sid: string; user: string; auth: string }> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', auth).send({ handle, sysop });
  expect(r.status).toBe(201);
  return { sid: r.body.sid as string, user: r.body.user as string, auth };
}
type S = { sid: string; auth: string };
const call = (s: S, method: 'get' | 'post' | 'put' | 'delete', path: string) =>
  request(fx.app)[method](`/chat/v1${path}`).set('Authorization', s.auth).set('X-Chat-Session', s.sid);
let n = 0;
const say = (s: S, room: string, content: string, as?: string) =>
  call(s, 'post', `/rooms/${room}/messages`).send({ content, clientId: `c${++n}`, ...(as === undefined ? {} : { as }) });
const rowsOf = (text: string): string[][] => text.split('\r\n').slice(1).filter((l) => l).map((l) => l.split('|'));

async function lobbyWith(...sessions: S[]): Promise<string> {
  const owner = await login(fx.auth, 'sys', true);
  const id = (await call(owner, 'post', '/rooms').send({ name: 'bridge' })).body.id as string;
  for (const s of [owner, ...sessions]) expect((await call(s, 'post', `/rooms/${id}/join`)).status).toBe(200);
  return id;
}

describe('relay boards (as)', () => {
  it('a relay BoardKey posts as handle@DISCORD; a normal BoardKey is refused not_relay', async () => {
    const summary = await markRelay(true);
    expect(summary.status).toBe(200);
    expect(summary.body.chatRelay).toBe(true);

    const bridge = await login(discordAuth, 'bridge');
    const caller = await login(fx.auth, 'alice');
    const room = await lobbyWith(bridge, caller);

    const posted = await say(bridge, room, 'hello from discord', 'zed');
    expect(posted.status).toBe(201);

    // Sentinel: the stored author is the relayed user, not the bridge session's user.
    const hist = await call(caller, 'get', `/rooms/${room}/history.txt`);
    const row = rowsOf(hist.text).find((r) => r[1] === posted.body.id);
    expect(row?.[2]).toBe('zed@DISCORD');
    expect(row?.[7]).toBe('hello from discord [Discord]');
    expect(row?.[8]).toBe('zed');

    const refused = await say(caller, room, 'spoof', 'zed');
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('not_relay');

    expect((await markRelay(false)).body.chatRelay).toBe(false);
    const after = await say(bridge, room, 'no longer relay', 'zed');
    expect(after.status).toBe(403);
    expect(after.body.error).toBe('not_relay');
  });

  it('edit, delete, react and unreact act as the relayed author; author-only rules hold per relayed user', async () => {
    await markRelay(true);
    const bridge = await login(discordAuth, 'bridge');
    const caller = await login(fx.auth, 'alice');
    const room = await lobbyWith(bridge, caller);
    const id = (await say(bridge, room, 'first', 'zed')).body.id as string;

    const notAuthor = await call(bridge, 'put', `/messages/${id}`).send({ content: 'hijack', as: 'yan' });
    expect(notAuthor.status).toBe(403);
    expect((await call(bridge, 'put', `/messages/${id}`).send({ content: 'edited', as: 'zed' })).status).toBe(200);

    expect((await call(bridge, 'post', `/messages/${id}/react`).send({ emoji: 'thumbsup', as: 'zed' })).body.count).toBe(1);
    expect((await call(bridge, 'post', `/messages/${id}/react`).send({ emoji: 'thumbsup', as: 'yan' })).body.count).toBe(2);
    expect((await call(bridge, 'delete', `/messages/${id}/react/thumbsup?as=yan`)).body.count).toBe(1);

    const events = await call(caller, 'get', '/events.txt?since=0&wait=0');
    const edit = rowsOf(events.text).find((r) => r[1] === 'edit' && r[4] === id);
    expect(edit?.[3]).toBe('zed@DISCORD');
    expect(edit?.[7]).toBe('edited [Discord]');
    expect(edit?.[9]).toBe('zed');

    expect((await call(bridge, 'delete', `/messages/${id}?as=yan`)).status).toBe(403);
    expect((await call(bridge, 'delete', `/messages/${id}?as=zed`)).status).toBe(200);
    const hist = await call(caller, 'get', `/rooms/${room}/history.txt`);
    expect(rowsOf(hist.text).some((r) => r[1] === id)).toBe(false);
  });

  it('a room ban or mute on the relayed user stops that user only', async () => {
    await markRelay(true);
    const bridge = await login(discordAuth, 'bridge');
    const owner = await login(fx.auth, 'sys', true);
    const id = (await call(owner, 'post', '/rooms').send({ name: 'modded' })).body.id as string;
    await call(owner, 'post', `/rooms/${id}/join`);
    await call(bridge, 'post', `/rooms/${id}/join`);

    expect((await call(owner, 'post', `/rooms/${id}/mute`).send({ user: 'zed@DISCORD', minutes: 5 })).status).toBe(200);
    const muted = await say(bridge, id, 'muted?', 'zed');
    expect(muted.status).toBe(403);
    expect(muted.body.error).toBe('muted');
    expect((await say(bridge, id, 'fine', 'yan')).status).toBe(201);

    expect((await call(owner, 'post', `/rooms/${id}/ban`).send({ user: 'yan@DISCORD' })).status).toBe(200);
    const banned = await say(bridge, id, 'banned?', 'yan');
    expect(banned.status).toBe(403);
    expect(banned.body.error).toBe('banned');
  });

  it('as must be a valid handle', async () => {
    await markRelay(true);
    const bridge = await login(discordAuth, 'bridge');
    const room = await lobbyWith(bridge);
    const bad = await say(bridge, room, 'x', 'zed@UPROUGH');
    expect(bad.status).toBe(400);
  });
});

describe('discord mirror (/discord on|off)', () => {
  it('only the board sysop switches it; the bridge reads boards.txt; sessions see the event', async () => {
    const sysop = await login(fx.auth, 'sys', true);
    const caller = await login(fx.auth, 'alice');

    // A new board starts mirrored; the relay board itself is never listed.
    expect((await call(caller, 'get', '/discord')).body.on).toBe(true);
    const bridge0 = await login(discordAuth, 'bridge');
    expect(rowsOf((await call(bridge0, 'get', '/discord/boards.txt')).text)).toEqual([['UPROUGH']]);
    const refused = await call(caller, 'put', '/discord').send({ on: false });
    expect(refused.status).toBe(403);
    expect((await call(sysop, 'put', '/discord').send({ on: false })).body.on).toBe(false);
    expect((await call(caller, 'get', '/discord')).body.on).toBe(false);
    expect((await call(sysop, 'put', '/discord').send({ on: 'yes' })).status).toBe(400);

    const on = await call(sysop, 'put', '/discord').send({ on: true });
    expect(on.status).toBe(200);
    expect(on.body.on).toBe(true);
    expect((await call(caller, 'get', '/discord')).body.on).toBe(true);

    const bridge = await login(discordAuth, 'bridge');
    const boards = await call(bridge, 'get', '/discord/boards.txt');
    expect(boards.text.split('\r\n')[0]).toMatch(/^DISCORD\|1\|\d+\|1$/);
    expect(rowsOf(boards.text)).toEqual([['UPROUGH']]);

    const events = rowsOf((await call(bridge, 'get', '/events.txt?since=0&wait=0')).text).filter((r) => r[1] === 'discord_mirror');
    expect(events).toHaveLength(2);
    expect(events[1][4]).toBe('UPROUGH');
    expect(events.map((r) => r[7])).toEqual(['0', '1']);

    await call(sysop, 'put', '/discord').send({ on: true }); // no change: no second event
    await call(sysop, 'put', '/discord').send({ on: false });
    const after = rowsOf((await call(bridge, 'get', '/events.txt?since=0&wait=0')).text).filter((r) => r[1] === 'discord_mirror');
    expect(after.map((r) => r[7])).toEqual(['0', '1', '0']);
    expect(rowsOf((await call(bridge, 'get', '/discord/boards.txt')).text)).toEqual([]);
  });
});

describe('D7 labels', () => {
  it('bare handle unless two present users share it', () => {
    const l = displayLabels(['zed@UPROUGH', 'zed@DISCORD', 'alice@UPROUGH', 'ALICE@UPROUGH']);
    expect(l.get('zed@UPROUGH')).toBe('zed@UPROUGH');
    expect(l.get('zed@DISCORD')).toBe('zed@DISCORD');
    expect(l.get('alice@UPROUGH')).toBe('alice');
    expect(markOrigin('zed@DISCORD', 'hi')).toBe('hi [Discord]');
    expect(markOrigin('zed@UPROUGH', 'hi')).toBe('hi');
  });

  it('a clash with a room member shows @BOARD in history, members and who', async () => {
    await markRelay(true);
    const bridge = await login(discordAuth, 'bridge');
    const zedHere = await login(fx.auth, 'zed');
    const alice = await login(fx.auth, 'alice');
    const room = await lobbyWith(bridge, zedHere, alice);
    await say(bridge, room, 'twin', 'zed');
    await say(alice, room, 'solo');

    const hist = rowsOf((await call(alice, 'get', `/rooms/${room}/history.txt`)).text);
    expect(hist.find((r) => r[2] === 'zed@DISCORD')?.[8]).toBe('zed@DISCORD');
    expect(hist.find((r) => r[2] === 'alice@UPROUGH')?.[8]).toBe('alice');

    const members = rowsOf((await call(alice, 'get', `/rooms/${room}/members.txt`)).text);
    expect(members.every((r) => r.length === 8)).toBe(true);
    expect(members.find((r) => r[0] === 'alice@UPROUGH')?.[7]).toBe('alice');

    const who = rowsOf((await call(alice, 'get', '/who.txt')).text);
    expect(who.every((r) => r.length === 8)).toBe(true);
  });
});
