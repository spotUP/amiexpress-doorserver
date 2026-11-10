/**
 * Relay boards (`as`) on direct messages: POST /dm/:peer, POST /dm-group and
 * GET /dm/:threadId/history.txt, and the relay board's event stream carrying
 * the `dm` events of its users. Driven through the real HTTP routes.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { CHAT_LIMITS } from '../contract/chat-types';

let fx: AchievementsFixture;
let discordAuth: string;
beforeEach(async () => {
  fx = makeAchievementsFixture({ admin: true });
  const token = await fx.adminToken();
  const made = await request(fx.app).post('/achievements/v1/admin/boards').set('Authorization', `Bearer ${token}`).send({ id: 'discord', name: 'Discord' });
  expect(made.status).toBe(200);
  discordAuth = `Board ${made.body.key as string}`;
  const rel = await request(fx.app).post('/achievements/v1/admin/boards/discord/relay').set('Authorization', `Bearer ${token}`);
  expect(rel.status).toBe(200);
});
afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

type S = { sid: string; auth: string; user: string };
async function login(auth: string, handle: string): Promise<S> {
  const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', auth).send({ handle });
  expect(r.status).toBe(201);
  return { sid: r.body.sid as string, user: r.body.user as string, auth };
}
const call = (s: S, method: 'get' | 'post', path: string) =>
  request(fx.app)[method](`/chat/v1${path}`).set('Authorization', s.auth).set('X-Chat-Session', s.sid);
let n = 0;
const cid = (): string => `c${++n}`;
const rowsOf = (text: string): string[][] => text.split('\r\n').slice(1).filter((l) => l).map((l) => l.split('|'));
const events = async (s: S, since: number) => rowsOf((await call(s, 'get', `/events.txt?since=${since}&wait=0`)).text);

describe('relay boards: as on direct messages', () => {
  it('POST /dm/:peer as zed sends from zed@DISCORD; history reads as zed; other boards and other boards users are refused', async () => {
    const bridge = await login(discordAuth, 'bridge');
    const alice = await login(fx.auth, 'alice');
    const peer = alice.user;

    const sent = await call(bridge, 'post', `/dm/${peer}`).send({ content: 'hi alice', clientId: cid(), as: 'zed' });
    expect(sent.status).toBe(201);
    const threadId = sent.body.threadId as string;

    const aliceHist = rowsOf((await call(alice, 'get', `/dm/${threadId}/history.txt`)).text);
    expect(aliceHist.find((r) => r[1] === sent.body.id)?.[2]).toBe('zed@DISCORD');

    // history read as zed through the relay session; the bridge itself is not a participant
    expect((await call(bridge, 'get', `/dm/${threadId}/history.txt`)).text).not.toContain(sent.body.id);
    const asZed = rowsOf((await call(bridge, 'get', `/dm/${threadId}/history.txt?as=zed`)).text);
    expect(asZed.some((r) => r[1] === sent.body.id)).toBe(true);
    const asYan = rowsOf((await call(bridge, 'get', `/dm/${threadId}/history.txt?as=yan`)).text);
    expect(asYan.some((r) => r[1] === sent.body.id)).toBe(false);

    // negatives
    const spoof = await call(alice, 'post', `/dm/${bridge.user}`).send({ content: 'x', clientId: cid(), as: 'zed' });
    expect(spoof.status).toBe(403);
    expect(spoof.body.error).toBe('not_relay');
    const spoofHist = await call(alice, 'get', `/dm/${threadId}/history.txt?as=zed`);
    expect(spoofHist.status).toBe(403);
    const other = await call(bridge, 'post', `/dm/${peer}`).send({ content: 'x', clientId: cid(), as: 'zed@UPROUGH' });
    expect(other.status).toBe(400);
  });

  it('POST /dm-group as zed sends from zed@DISCORD and enforces a rate limit per relayed author', async () => {
    const bridge = await login(discordAuth, 'bridge');
    const alice = await login(fx.auth, 'alice');
    const bob = await login(fx.auth, 'bob');
    const sent = await call(bridge, 'post', '/dm-group').send({ participants: [alice.user, bob.user], content: 'group hi', clientId: cid(), as: 'zed' });
    expect(sent.status).toBe(201);
    const hist = rowsOf((await call(bob, 'get', `/dm/${sent.body.threadId as string}/history.txt`)).text);
    expect(hist.find((r) => r[1] === sent.body.id)?.[2]).toBe('zed@DISCORD');

    const spoof = await call(alice, 'post', '/dm-group').send({ participants: [bob.user, bridge.user], content: 'x', clientId: cid(), as: 'zed' });
    expect(spoof.status).toBe(403);

    // rate limit is zed's own: exhaust zed, yan still sends
    let limited = 0;
    for (let i = 0; i < CHAT_LIMITS.messagesPerSession + 2; i++) {
      const r = await call(bridge, 'post', `/dm/${alice.user}`).send({ content: `m${i}`, clientId: cid(), as: 'zed' });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    expect((await call(bridge, 'post', `/dm/${alice.user}`).send({ content: 'yan', clientId: cid(), as: 'yan' })).status).toBe(201);
  });

  it('the relay board event stream carries dm events of its users (1:1 and group, sent and received); other boards do not see them', async () => {
    const bridge = await login(discordAuth, 'bridge');
    const alice = await login(fx.auth, 'alice');
    const bob = await login(fx.auth, 'bob');
    const carol = await login(fx.auth, 'carol');
    const seed = await call(bridge, 'post', `/dm/${alice.user}`).send({ content: 'seed', clientId: cid(), as: 'zed' });
    const since = seed.body.seq as number;

    // received: alice -> zed@DISCORD (bridge's own user is bridge@DISCORD, not zed)
    const toZed = await call(alice, 'post', '/dm/zed@DISCORD').send({ content: 'hello zed', clientId: cid() });
    expect(toZed.status).toBe(201);
    // group with a DISCORD member, among others
    const grp = await call(alice, 'post', '/dm-group').send({ participants: ['zed@DISCORD', bob.user], content: 'group to zed', clientId: cid() });
    expect(grp.status).toBe(201);
    // sent by a DISCORD user to a plain board user
    const fromYan = await call(bridge, 'post', `/dm/${bob.user}`).send({ content: 'from yan', clientId: cid(), as: 'yan' });
    // unrelated dm between two plain-board users
    await call(bob, 'post', `/dm/${carol.user}`).send({ content: 'private', clientId: cid() });

    const rows = await events(bridge, since);
    const dms = rows.filter((r) => r[1] === 'dm');
    expect(dms.map((r) => r[7])).toEqual(['hello zed', 'group to zed', 'from yan']);
    expect(dms[0].slice(0, 5)).toEqual([String(toZed.body.seq), 'dm', toZed.body.threadId, alice.user, toZed.body.id]);
    expect(dms[1][2]).toBe(grp.body.threadId);
    expect(dms[2][3]).toBe('yan@DISCORD');
    expect(String(fromYan.body.seq)).toBe(dms[2][0]);

    // a non-relay board never sees a dm it is not a participant of
    const carolRows = (await events(carol, since)).filter((r) => r[1] === 'dm');
    expect(carolRows.map((r) => r[7])).toEqual(['private']);
  });
});
