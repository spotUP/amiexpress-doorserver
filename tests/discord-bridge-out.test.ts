/**
 * Discord bridge phase 3 (thoughts/shared/plans/2026-11-09-livechat-discord-bridge.md):
 * hub -> Discord. One reachability test drives startBridge against the real
 * hub app on an ephemeral port, with the real discord.js REST pointed at a
 * local fake Discord API; the sentinel is the fake's webhook call count.
 * Text rules are table-tested where they live (text.ts).
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { startBridge } from '../src/discord-bridge/bridge';
import { RestDiscordOut, WEBHOOK_NAME } from '../src/discord-bridge/discord-out';
import { boardOf, createOutbound } from '../src/discord-bridge/outbound';
import { composeContent, escapeDiscord, quoteLine, webhookName } from '../src/discord-bridge/text';
import type { BridgeConfig } from '../src/discord-bridge/config';
import type { BridgeEvent } from '../src/discord-bridge/wire';

jest.setTimeout(30000);

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/** Minimal Discord API: one webhook per channel, message ids m1, m2, ... */
function fakeDiscord(): Promise<{ calls: Call[]; api: string; close: () => Promise<void>; webhookPosts: () => Call[] }> {
  const calls: Call[] = [];
  let next = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      calls.push({ method: req.method ?? '', url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
      const send = (status: number, body?: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (/\/channels\/[^/]+\/webhooks$/.test(url)) {
        if (req.method === 'GET') return send(200, []);
        return send(200, { id: 'wh1', token: 'tok', name: WEBHOOK_NAME, guild_id: 'G1' });
      }
      if (/\/webhooks\/wh1\/tok\?wait=true$/.test(url) && req.method === 'POST') return send(200, { id: `m${++next}` });
      if (/\/webhooks\/wh1\/tok\/messages\/m\d+$/.test(url)) return req.method === 'DELETE' ? send(204) : send(200, {});
      send(404, { message: 'unknown route' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        calls,
        api: `http://127.0.0.1:${port}/api`,
        webhookPosts: () => calls.filter((c) => c.method === 'POST' && c.url.includes('/webhooks/wh1/tok')),
        close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
      });
    });
  });
}

describe('hub -> Discord through the bridge', () => {
  let fx: AchievementsFixture;
  let server: Server;
  let discordKey: string;
  let otherKey: string;
  let stateDir: string;
  let n = 0;

  beforeEach(async () => {
    fx = makeAchievementsFixture({ admin: true });
    const token = await fx.adminToken();
    const admin = (p: string) => request(fx.app).post(`/achievements/v1/admin/${p}`).set('Authorization', `Bearer ${token}`);
    discordKey = (await admin('boards').send({ id: 'discord', name: 'Discord' })).body.key as string;
    expect((await admin('boards/discord/relay')).status).toBe(200);
    otherKey = (await admin('boards').send({ id: 'other', name: 'Other' })).body.key as string;
    server = await new Promise<Server>((resolve) => { const s = fx.app.listen(0, '127.0.0.1', () => resolve(s)); });
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-out-'));
  });
  afterEach(async () => {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    _stopChatSweepersForTests();
    fx.cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(cond()).toBe(true);
  }

  type S = { sid: string; auth: string };
  const login = async (auth: string, handle: string, sysop = false): Promise<S> => {
    const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', auth).send({ handle, sysop });
    expect(r.status).toBe(201);
    return { sid: r.body.sid as string, auth };
  };
  const call = (s: S, method: 'get' | 'post' | 'put' | 'delete', p: string) =>
    request(fx.app)[method](`/chat/v1${p}`).set('Authorization', s.auth).set('X-Chat-Session', s.sid);

  function configFor(room: string): BridgeConfig {
    return {
      hubUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      boardKey: discordKey,
      rooms: new Map([[room, '777']]),
      discordToken: 'unused',
      dbPath: path.join(stateDir, 'bridge.db'),
      healthPath: path.join(stateDir, 'bridge.health'),
      waitSeconds: 1,
      handle: 'bridge',
    };
  }

  it('mirrors opted-in boards only: webhook payload, edit, delete and reply reach the twin', async () => {
    const alice = await login(fx.auth, 'alice', true); // UPROUGH sysop
    const bob = await login(`Board ${otherKey}`, 'bob'); // OTHER: mirror stays off
    const room = (await call(alice, 'post', '/rooms').send({ name: 'bridge' })).body.id as string;
    for (const s of [alice, bob]) expect((await call(s, 'post', `/rooms/${room}/join`)).status).toBe(200);
    expect((await call(alice, 'put', '/discord').send({ on: true })).status).toBe(200);
    const say = async (s: S, content: string, replyTo?: string): Promise<string> => {
      const r = await call(s, 'post', `/rooms/${room}/messages`).send({ content, clientId: `c${++n}`, ...(replyTo ? { replyTo } : {}) });
      expect(r.status).toBe(201);
      return r.body.id as string;
    };

    const discord = await fakeDiscord();
    const out = RestDiscordOut.fromToken('fake-token', discord.api);
    await out.prepare(['777']);
    const config = configFor(room);
    const logs: string[] = [];
    const bridge = await startBridge(config, (hub, state) => ({
      onEvent: createOutbound({ rooms: config.rooms, state, out, fetchBoards: () => hub.mirrorBoards(), log: (l) => logs.push(l) }),
    }), { log: (l) => logs.push(l) });
    try {
      // The webhook was created by the bridge, named for it.
      expect(discord.calls.find((c) => c.method === 'POST' && c.url.endsWith('/webhooks'))?.body).toEqual({ name: WEBHOOK_NAME });

      await say(bob, 'hidden from discord');
      const first = await say(alice, 'hello *world* @everyone');
      await until(() => discord.webhookPosts().length === 1);
      // Sentinel: exactly one webhook execute, and it is alice's, not bob's.
      expect(discord.webhookPosts()[0].body).toEqual({
        username: 'alice',
        content: 'hello \\*world\\* @​everyone',
        allowed_mentions: { parse: [] },
      });

      expect((await call(alice, 'put', `/messages/${first}`).send({ content: 'hello edited' })).status).toBe(200);
      await until(() => discord.calls.some((c) => c.method === 'PATCH'));
      const patch = discord.calls.find((c) => c.method === 'PATCH');
      expect(patch?.url).toContain('/webhooks/wh1/tok/messages/m1');
      expect(patch?.body).toEqual({ content: 'hello edited', allowed_mentions: { parse: [] } });

      await say(alice, 'a reply', first);
      await until(() => discord.webhookPosts().length === 2);
      expect(discord.webhookPosts()[1].body?.content).toBe(
        '> alice: hello edited ([jump](https://discord.com/channels/G1/777/m1))\na reply',
      );

      expect((await call(alice, 'delete', `/messages/${first}`)).status).toBe(200);
      await until(() => discord.calls.some((c) => c.method === 'DELETE'));
      expect(discord.calls.find((c) => c.method === 'DELETE')?.url).toContain('/webhooks/wh1/tok/messages/m1');

      // Bob's message never produced a call; nothing beyond the two posts.
      expect(discord.webhookPosts()).toHaveLength(2);
      expect(discord.calls.some((c) => JSON.stringify(c.body).includes('hidden'))).toBe(false);
    } finally {
      await bridge.stop();
      out.close();
      await discord.close();
    }
  });

  it('retries a failing event, then skips it and moves on without stalling', async () => {
    const alice = await login(fx.auth, 'alice', true);
    const room = (await call(alice, 'post', '/rooms').send({ name: 'bridge' })).body.id as string;
    await call(alice, 'post', `/rooms/${room}/join`);
    const attempts = new Map<string, number>();
    const done: string[] = [];
    const logs: string[] = [];
    const bridge = await startBridge(configFor(room), {
      onEvent: (ev: BridgeEvent) => {
        if (ev.type !== 'message') return;
        attempts.set(ev.text, (attempts.get(ev.text) ?? 0) + 1);
        if (ev.text === 'poison') throw new Error('discord down');
        done.push(ev.text);
      },
    }, { log: (l) => logs.push(l), eventAttempts: 3, eventBackoffMs: 5 });
    await call(alice, 'post', `/rooms/${room}/messages`).send({ content: 'poison', clientId: 'p1' });
    await call(alice, 'post', `/rooms/${room}/messages`).send({ content: 'after', clientId: 'p2' });
    await until(() => done.includes('after'));
    expect(attempts.get('poison')).toBe(3);
    expect(logs.some((l) => l.includes('giving up'))).toBe(true);
    await until(() => (bridge.state.getSeq() ?? 0) > 0);
    await bridge.stop();
  });
});

describe('createOutbound without a hub', () => {
  const ev = (over: Partial<BridgeEvent>): BridgeEvent => ({ seq: 1, type: 'message', room: 'r', user: 'a@B', ref: 'h1', at: '', roleColor: '', text: 'hi', replyTo: '', label: 'a', ...over });

  it('filters by board list, never mirrors DISCORD authors, refreshes on discord_mirror and after 60 s', async () => {
    const { BridgeState } = await import('../src/discord-bridge/state');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ob-'));
    const state = new BridgeState(path.join(dir, 's.db'));
    const posts: string[] = [];
    let fetches = 0;
    let boards = new Set(['B']);
    let t = 0;
    const handler = createOutbound({
      rooms: new Map([['r', 'c']]),
      state,
      out: {
        prepare: async () => undefined,
        post: async (_c, p) => { posts.push(p.username); return `d${posts.length}`; },
        edit: async () => undefined,
        remove: async () => undefined,
        jumpLink: () => undefined,
      },
      fetchBoards: async () => { fetches++; return { rev: fetches, boards }; },
      log: () => undefined,
      now: () => t,
    });
    await handler(ev({ ref: 'h1', user: 'a@B', label: 'a' }));
    await handler(ev({ ref: 'h2', user: 'z@DISCORD', label: 'z' })); // loop guard
    await handler(ev({ ref: 'h3', user: 'c@NOPE', label: 'c' }));
    expect(posts).toEqual(['a']);
    expect(fetches).toBe(1); // cached across the three events
    boards = new Set(['B', 'NOPE']);
    await handler(ev({ ref: 'h4', user: 'c@NOPE', label: 'c' }));
    expect(posts).toEqual(['a']); // still cached
    await handler(ev({ type: 'discord_mirror', ref: 'NOPE', user: 'sys@NOPE', text: '1' }));
    await handler(ev({ ref: 'h5', user: 'c@NOPE', label: 'c' }));
    expect(posts).toEqual(['a', 'c']);
    boards = new Set();
    t = 60000;
    await handler(ev({ ref: 'h6', user: 'a@B', label: 'a' })); // aged out: refetched, now off
    expect(posts).toEqual(['a', 'c']);
    // A replayed message already has its twin: no second post.
    boards = new Set(['B']);
    t = 200000;
    await handler(ev({ ref: 'h1' }));
    expect(posts).toEqual(['a', 'c']);
    // Edit/delete of a message with no twin do nothing and do not throw.
    await handler(ev({ type: 'edit', ref: 'ghost' }));
    await handler(ev({ type: 'delete', ref: 'ghost' }));
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('boardOf reads the part after the last @', () => {
    expect([boardOf('a@uprough'), boardOf('a@b@C'), boardOf('plain')]).toEqual(['UPROUGH', 'C', '']);
  });
});

describe('text.ts', () => {
  it.each([
    ['plain', 'plain'],
    ['*bold* _it_ ~s~ `c` ||sp||', '\\*bold\\* \\_it\\_ \\~s\\~ \\`c\\` \\|\\|sp\\|\\|'],
    ['back\\slash', 'back\\\\slash'],
    ['<@123> <#9> <:x:5>', '\\<@123\\> \\<#9\\> \\<:x:5\\>'],
    ['@everyone and @HERE', '@​everyone and @​HERE'],
    ['# head\n- item\n1. one', '\\# head\n\\- item\n1\\. one'],
    ['[link](http://x)', '\\[link\\]\\(http://x\\)'],
    ['a-b #tag 3.5', 'a-b #tag 3.5'],
    ['> quote', '\\> quote'],
  ])('escapeDiscord(%j)', (input, expected) => {
    expect(escapeDiscord(input)).toBe(expected);
  });

  it.each([
    ['alice', 'alice'],
    ['Discordian', 'D​iscordian'],
    ['clyde', 'c​lyde'],
    ['', 'unknown'],
    ['x'.repeat(100), 'x'.repeat(80)],
  ])('webhookName(%j)', (input, expected) => {
    expect(webhookName(input)).toBe(expected);
  });

  it('quoteLine flattens, truncates to 80 characters and adds the jump link', () => {
    expect(quoteLine({ label: 'bob', text: 'a\nb  c' })).toBe('> bob: a b c');
    expect(quoteLine({ label: 'bob', text: 'y'.repeat(100), link: 'https://l' })).toBe(`> bob: ${'y'.repeat(80)}... ([jump](https://l))`);
  });

  it('composeContent caps at 2000 characters', () => {
    expect(composeContent('z'.repeat(5000))).toHaveLength(2000);
    expect(composeContent('t', { label: 'a', text: 'p' })).toBe('> a: p\nt');
  });
});
