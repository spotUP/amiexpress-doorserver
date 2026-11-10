/**
 * Discord attachments are copied into the hub file store at arrival (CDN links
 * expire). ONE reachability test drives the inbound sink against the real hub
 * app, fetch stubbed only for cdn.discordapp.com; HubClient chunking is
 * pinned where it lives.
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
import { _resetRateLimitsForTests } from '../src/achievements/ratelimit';
import { fileStats } from '../src/chat/files';
import { startBridge } from '../src/discord-bridge/bridge';
import { HubClient } from '../src/discord-bridge/hub-client';
import { createInbound } from '../src/discord-bridge/inbound';
import type { InboundSink } from '../src/discord-bridge/inbound';
import { createOutbound } from '../src/discord-bridge/outbound';
import type { DiscordOut } from '../src/discord-bridge/discord-out';
import type { BridgeConfig } from '../src/discord-bridge/config';

jest.setTimeout(30000);

describe('HubClient file upload', () => {
  it('splits a 70 KB file into 3 chunks of at most 32 KB, then finishes', async () => {
    const calls: { method: string; url: string; len: number; type: string | null }[] = [];
    const real = global.fetch;
    global.fetch = (async (url: string, init: RequestInit) => {
      const body = init.body as Uint8Array | string | undefined;
      calls.push({ method: init.method ?? '', url, len: typeof body === 'string' ? 0 : body?.length ?? 0, type: (init.headers as Record<string, string>)['Content-Type'] });
      const json = url.endsWith('/files') ? { id: 'f1', chunkMax: 32768, received: 0 } : url.includes('/finish') ? { id: 'f1', sha256: 'x', kind: 'other' } : {};
      return new Response(JSON.stringify(json), { status: 200 });
    }) as typeof fetch;
    try {
      const c = new HubClient('http://hub', 'key', 'bridge', []);
      (c as unknown as { sid: string }).sid = 's';
      await c.uploadFileAs('r1', 'Bob@x', 'a.bin', Buffer.alloc(70 * 1024), 'att1');
    } finally {
      global.fetch = real;
    }
    const chunks = calls.filter((c) => c.method === 'PUT');
    expect(chunks.map((c) => c.len)).toEqual([32768, 32768, 70 * 1024 - 65536]);
    expect(chunks.every((c) => c.type === 'application/octet-stream')).toBe(true);
    expect(chunks.map((c) => c.url.match(/offset=(\d+)/)![1])).toEqual(['0', '32768', '65536']);
    expect(calls.filter((c) => c.url.includes('/finish'))).toHaveLength(1);
  });
});

describe('Discord attachment copy', () => {
  let fx: AchievementsFixture;
  let server: Server;
  let stateDir: string;
  let key: string;
  beforeEach(async () => {
    _resetRateLimitsForTests();
    fx = makeAchievementsFixture({ admin: true, chatFiles: true });
    const token = await fx.adminToken();
    const admin = (p: string) => request(fx.app).post(`/achievements/v1/admin/${p}`).set('Authorization', `Bearer ${token}`);
    key = (await admin('boards').send({ id: 'discord', name: 'Discord' })).body.key as string;
    expect((await admin('boards/discord/relay')).status).toBe(200);
    server = await new Promise<Server>((resolve) => { const s = fx.app.listen(0, '127.0.0.1', () => resolve(s)); });
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-files-'));
  });
  afterEach(async () => {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    _stopChatSweepersForTests();
    fx.cleanup();
    _resetRateLimitsForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('REACHABLE: a small attachment lands in chat_files as handle@DISCORD without its link in the text, a 3 MB one is only linked', async () => {
    const login = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle: 'alice', sysop: true });
    const call = (method: 'get' | 'post' | 'put', p: string) => request(fx.app)[method](`/chat/v1${p}`).set('Authorization', fx.auth).set({ 'X-Chat-Session': login.body.sid as string });
    const room = (await call('post', '/rooms').send({ name: 'bridge' })).body.id as string;
    await call('post', `/rooms/${room}/join`);
    expect((await call('put', '/discord').send({ on: true })).status).toBe(200);

    const config: BridgeConfig = {
      hubUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, boardKey: key, rooms: new Map([[room, '777']]), discordToken: 'unused',
      dbPath: path.join(stateDir, 'bridge.db'), healthPath: path.join(stateDir, 'bridge.health'), waitSeconds: 1, handle: 'bridge',
    };
    const out: DiscordOut = { prepare: async () => undefined, post: async () => 'w1', edit: async () => undefined, remove: async () => undefined, jumpLink: () => undefined };
    const logs: string[] = [];
    let sink!: InboundSink;
    const bridge = await startBridge(config, (hub, state) => {
      sink = createInbound({ rooms: config.rooms, hub, state, log: (l) => logs.push(l) });
      return { onEvent: createOutbound({ rooms: config.rooms, state, out, fetchBoards: () => hub.mirrorBoards(), log: (l) => logs.push(l) }) };
    }, { log: (l) => logs.push(l), eventAttempts: 2, eventBackoffMs: 5 });

    const small = Buffer.alloc(70 * 1024, 7);
    const downloaded: string[] = [];
    const real = global.fetch;
    global.fetch = ((url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://cdn.discordapp.com/')) {
        downloaded.push(String(url));
        return Promise.resolve(new Response(new Uint8Array(small), { status: 200 }));
      }
      return real(url, init);
    }) as typeof fetch;
    try {
      const smallUrl = 'https://cdn.discordapp.com/attachments/1/2/demo.bin?ex=abc';
      const bigUrl = 'https://cdn.discordapp.com/attachments/1/3/big.bin?ex=abc';
      const before = fileStats.chunkCalls;
      await sink.create({
        id: 'd1', channelId: '777', authorName: 'Bob Smith', authorId: '1234567890', authorBot: false, content: 'look',
        attachmentUrls: [smallUrl, bigUrl],
        attachments: [{ id: 'att1', name: 'demo.bin', size: small.length, url: smallUrl }, { id: 'att2', name: 'big.bin', size: 3 * 1024 * 1024, url: bigUrl }],
      });

      expect(fileStats.chunkCalls - before).toBe(3);
      expect(downloaded).toEqual([smallUrl]);
      const db = fx.openAchievements();
      const rows = db.prepare('SELECT name, uploader, size, status FROM chat_files').all() as { name: string; uploader: string; size: number; status: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'demo.bin', uploader: 'Bob_Smith@DISCORD', size: small.length, status: 'ready' });
      const ev = (await call('get', '/events.txt?since=0')).text;
      expect(ev).toContain('file_shared');
      const hist = (await call('get', `/rooms/${room}/history.txt`)).text;
      // The copied picture is announced by the hub; its CDN link (hex query) stays
      // out of the text, where it wrapped into hex scraps on telnet (sysop 2026-11-10).
      expect(hist).not.toContain(smallUrl);
      expect(hist).toContain(bigUrl);
      expect(hist.indexOf('look')).toBeGreaterThan(-1);

      // A picture with no text posts no message, only the file.
      const onlyUrl = 'https://cdn.discordapp.com/attachments/1/4/only.png?ex=6af33&hm=c46e7';
      await sink.create({
        id: 'd2', channelId: '777', authorName: 'Bob Smith', authorId: '1234567890', authorBot: false, content: '',
        attachmentUrls: [onlyUrl], attachments: [{ id: 'att3', name: 'only.png', size: small.length, url: onlyUrl }],
      });
      expect((db.prepare('SELECT COUNT(*) AS n FROM chat_files').get() as { n: number }).n).toBe(2);
      expect((await call('get', `/rooms/${room}/history.txt`)).text).not.toContain('only.png');

      // A copy that fails puts the link back into the text: it is the only way to the file.
      const deadUrl = 'https://cdn.discordapp.com/attachments/1/5/gone.png?ex=1';
      const ok = global.fetch;
      global.fetch = ((url: string, init?: RequestInit) => String(url) === deadUrl ? Promise.resolve(new Response('', { status: 404 })) : ok(url, init)) as typeof fetch;
      await sink.create({
        id: 'd3', channelId: '777', authorName: 'Bob Smith', authorId: '1234567890', authorBot: false, content: 'gone',
        attachmentUrls: [deadUrl], attachments: [{ id: 'att4', name: 'gone.png', size: 10, url: deadUrl }],
      });
      expect((await call('get', `/rooms/${room}/history.txt`)).text).toContain(`gone ${deadUrl}`);
    } finally {
      global.fetch = real;
      await bridge.stop();
    }
  });
});
