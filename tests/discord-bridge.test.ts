/**
 * Discord bridge phase 2 (thoughts/shared/plans/2026-11-09-livechat-discord-bridge.md):
 * the skeleton reaches the real hub over HTTP. One reachability test drives
 * startBridge against the real app on an ephemeral port, with a counting
 * handler as the sentinel; the config parser and state store are tested
 * where they live.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { startBridge } from '../src/discord-bridge/bridge';
import { BridgeState } from '../src/discord-bridge/state';
import { loadBridgeConfig, parseRoomMap, BridgeConfigError } from '../src/discord-bridge/config';
import { parseEvents, parseTextTable } from '../src/discord-bridge/wire';
import type { BridgeConfig } from '../src/discord-bridge/config';
import type { BridgeEvent } from '../src/discord-bridge/wire';

jest.setTimeout(30000);

describe('bridge against the real hub', () => {
  let fx: AchievementsFixture;
  let server: Server;
  let discordKey: string;
  let stateDir: string;
  let n = 0;

  beforeEach(async () => {
    fx = makeAchievementsFixture({ admin: true });
    const token = await fx.adminToken();
    const made = await request(fx.app).post('/achievements/v1/admin/boards').set('Authorization', `Bearer ${token}`).send({ id: 'discord', name: 'Discord' });
    expect(made.status).toBe(200);
    discordKey = made.body.key as string;
    expect((await request(fx.app).post('/achievements/v1/admin/boards/discord/relay').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    server = await new Promise<Server>((resolve) => { const s = fx.app.listen(0, '127.0.0.1', () => resolve(s)); });
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-state-'));
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

  it('delivers each hub message once, resuming from the stored seq after a restart', async () => {
    const login = async (handle: string, sysop = false) => {
      const r = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle, sysop });
      expect(r.status).toBe(201);
      return { sid: r.body.sid as string };
    };
    const caller = await login('alice', true);
    const call = (method: 'post', p: string) => request(fx.app)[method](`/chat/v1${p}`).set('Authorization', fx.auth).set('X-Chat-Session', caller.sid);
    const room = (await call('post', '/rooms').send({ name: 'bridge' })).body.id as string;
    expect((await call('post', `/rooms/${room}/join`)).status).toBe(200);
    const say = async (text: string) => expect((await call('post', `/rooms/${room}/messages`).send({ content: text, clientId: `c${++n}` })).status).toBe(201);

    const config: BridgeConfig = {
      hubUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      boardKey: discordKey,
      rooms: new Map([[room, '111222333']]),
      discordToken: 'unused',
      dbPath: path.join(stateDir, 'bridge.db'),
      healthPath: path.join(stateDir, 'bridge.health'),
      waitSeconds: 1,
      handle: 'bridge',
    };
    const seen: BridgeEvent[] = [];
    const handlers = { onEvent: (ev: BridgeEvent) => { seen.push(ev); } };
    const messages = () => seen.filter((e) => e.type === 'message');

    const polled: number[] = [];
    const first = await startBridge(config, handlers, { log: () => undefined, onPolled: (seq) => polled.push(seq) });
    expect(polled.length).toBe(1);
    await say('first message');
    await until(() => messages().length === 1);
    await until(() => polled.includes(messages()[0].seq));
    expect(messages()[0].room).toBe(room);
    expect(messages()[0].text).toBe('first message');
    expect(messages()[0].user).toBe('alice@UPROUGH');
    await until(() => first.state.getSeq() === messages()[0].seq);
    const seqAfterFirst = first.state.getSeq() as number;
    expect(seqAfterFirst).toBeGreaterThan(0);
    await first.stop();

    await say('second message');
    const second = await startBridge(config, handlers, { log: () => undefined });
    await until(() => messages().length === 2);
    expect(messages().map((e) => e.text)).toEqual(['first message', 'second message']);
    expect(second.state.getSeq()).toBeGreaterThanOrEqual(messages()[1].seq);
    expect(messages()[1].seq).toBeGreaterThan(seqAfterFirst);
    await second.stop();
  });

  it('opens a new session after the hub drops it (401)', async () => {
    const caller = (await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle: 'alice', sysop: true })).body.sid as string;
    const callAs = (method: 'post', p: string) => request(fx.app)[method](`/chat/v1${p}`).set('Authorization', fx.auth).set('X-Chat-Session', caller);
    const room = (await callAs('post', '/rooms').send({ name: 'bridge' })).body.id as string;
    await callAs('post', `/rooms/${room}/join`);
    const config: BridgeConfig = {
      hubUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, boardKey: discordKey, rooms: new Map([[room, 'c']]),
      discordToken: 'x', dbPath: path.join(stateDir, 'b.db'), waitSeconds: 1, handle: 'bridge', healthPath: path.join(stateDir, 'b.health'),
    };
    const seen: BridgeEvent[] = [];
    const errors: string[] = [];
    const bridge = await startBridge(config, { onEvent: (e) => { seen.push(e); } }, { log: (l) => errors.push(l), minBackoffMs: 20 });
    // Kill every bridge session on the hub side.
    const db = fx.openAchievements();
    try { expect(db.prepare("DELETE FROM chat_sessions WHERE user LIKE 'bridge@%'").run().changes).toBe(1); } finally { db.close(); }
    await until(() => errors.some((e) => e.includes('401')));
    await callAs('post', `/rooms/${room}/messages`).send({ content: 'after expiry', clientId: 'x1' });
    await until(() => seen.some((e) => e.type === 'message' && e.text === 'after expiry'));
    await bridge.stop();
  });
});

describe('BridgeState', () => {
  it('stores seq and an id map both ways and prunes by age', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-st-'));
    const file = path.join(dir, 's.db');
    const s = new BridgeState(file);
    expect(s.getSeq()).toBeNull();
    s.setSeq(42);
    s.putLink({ hubMessageId: 'h1', discordMessageId: 'd1', roomId: 'r', createdAt: 100 });
    s.putLink({ hubMessageId: 'h2', discordMessageId: 'd2', roomId: 'r', createdAt: 200 });
    expect(s.byHub('h1')?.discordMessageId).toBe('d1');
    expect(s.byDiscord('d2')?.hubMessageId).toBe('h2');
    expect(s.byHub('nope')).toBeUndefined();
    expect(s.pruneOlderThan(150)).toBe(1);
    expect(s.byHub('h1')).toBeUndefined();
    expect(s.byHub('h2')).toBeDefined();
    s.close();
    const again = new BridgeState(file);
    expect(again.getSeq()).toBe(42);
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('bridge config', () => {
  const ok = {
    DISCORD_BRIDGE_HUB_URL: 'http://hub:3010/', DISCORD_BRIDGE_BOARD_KEY: 'discord.secret',
    DISCORD_BRIDGE_ROOMS: 'r1=c1, r2=c2', DISCORD_BOT_TOKEN: 'tok', DISCORD_BRIDGE_DB: '/data/b.db',
  };
  it('parses a full environment', () => {
    const c = loadBridgeConfig(ok);
    expect(c.hubUrl).toBe('http://hub:3010');
    expect([...c.rooms]).toEqual([['r1', 'c1'], ['r2', 'c2']]);
    expect(c.discordToken).toBe('tok');
  });
  it.each(Object.keys(ok))('fails fast naming %s when missing', (name) => {
    const env: NodeJS.ProcessEnv = { ...ok };
    delete env[name];
    expect(() => loadBridgeConfig(env)).toThrow(new RegExp(name));
    expect(() => loadBridgeConfig(env)).toThrow(BridgeConfigError);
  });
  it('rejects malformed room maps', () => {
    expect(() => parseRoomMap('r1')).toThrow(/roomId=channelId/);
    expect(() => parseRoomMap('r1=c1,r1=c2')).toThrow(/twice/);
    expect(() => parseRoomMap(' , ')).toThrow(/no rooms/);
  });
});

describe('wire reader', () => {
  it('parses an EVENTS body and pads short rows', () => {
    const body = 'EVENTS|1|7|2\r\n5|message|r|a@B|m1|t|c|hi|\r\n7|edit|r|a@B|m1|t|c|hi2||a\r\n';
    const { revision, events } = parseEvents(body);
    expect(revision).toBe(7);
    expect(events.map((e) => [e.seq, e.type, e.text, e.label])).toEqual([[5, 'message', 'hi', ''], [7, 'edit', 'hi2', 'a']]);
    expect(() => parseTextTable('EVENTS|1|7|3\r\n5|x\r\n')).toThrow(/header says 3/);
  });
});
