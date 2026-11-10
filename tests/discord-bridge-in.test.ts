/**
 * Discord bridge phase 4: Discord -> hub. One reachability test drives
 * startBridge (outbound and inbound handlers together) against the real hub
 * app on an ephemeral port; a fake DiscordIn emits create, update, delete and
 * reply. Sentinel: the history.txt row count. The handle sanitiser is
 * table-tested where it lives (inbound.ts).
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
import { createInbound, toHandle } from '../src/discord-bridge/inbound';
import type { InboundMessage, InboundSink } from '../src/discord-bridge/inbound';
import { createOutbound } from '../src/discord-bridge/outbound';
import type { DiscordOut, WebhookPost } from '../src/discord-bridge/discord-out';
import { discordToHub } from '../src/discord-bridge/text';
import type { BridgeConfig } from '../src/discord-bridge/config';

jest.setTimeout(30000);

describe('toHandle', () => {
  const table: [string, string, string][] = [
    ['plain', '1234567890', 'plain'],
    ['Bob Smith', '1234567890', 'Bob_Smith'],
    ['a@b|c', '1234567890', 'abc'],
    ['   ', '1234567890', 'user7890'],
    ['@@||', '1234567890', 'user7890'],
    ['', '5550001234', 'user1234'],
    ['x'.repeat(40), '1234567890', 'x'.repeat(32)],
    ['tab\tname', '1234567890', 'tab_name'],
  ];
  it.each(table)('%j -> %j', (name, id, want) => {
    expect(toHandle(name, id)).toBe(want);
  });
});

describe('discordToHub', () => {
  it('appends attachment URLs, replaces non-Latin-1, caps at 500', () => {
    expect(discordToHub('hi \u4e2d', ['https://cdn/x.png'])).toBe('hi ? https://cdn/x.png');
    expect(discordToHub('', ['https://cdn/x.png'])).toBe('https://cdn/x.png');
    expect(discordToHub('a'.repeat(600))).toHaveLength(500);
  });

  const names = { users: { '111': 'spot', '222': 'user0222' }, roles: { '333': 'Sysops' }, channels: { '444': 'lobby' } };
  it.each<[string, string, string]>([
    // emoji
    ['unicode emoji to door code', 'nice \u{1F44D}', 'nice :thumbsup:'],
    ['skin tone folds into the base emoji', '\u{1F44D}\u{1F3FD}', ':thumbsup:'],
    ['emoji with no door alias keeps its shortcode', 'pizza \u{1F355}', 'pizza :pizza:'],
    ['ZWJ sequence is one shortcode', '\u{1F937}‍♂️ ok', ':shrug: ok'],
    ['VS16 heart', '❤️', ':heart:'],
    ['flag', '\u{1F1F8}\u{1F1EA}', ':sweden:'],
    ['custom emoji', 'gg <:amigaball:123456789012345678>', 'gg :amigaball:'],
    ['animated custom emoji', '<a:spin:123456789012345678>', ':spin:'],
    // mentions
    ['user mention', 'hi <@111>', 'hi @spot'],
    ['nickname-style mention', 'hi <@!222>', 'hi @user0222'],
    ['unknown user', 'hi <@999>', 'hi @unknown'],
    ['role mention', '<@&333> look', '@Sysops look'],
    ['channel mention', 'see <#444>', 'see #lobby'],
    ['slash command mention', 'try </who:42>', 'try /who'],
    ['timestamp', 'at <t:0:R>', 'at 1970-01-01 00:00 UTC'],
    // markdown
    ['bold italic underline strike', '**b** *i* __u__ ~~s~~ ***bi*** _j_', 'b i u s bi j'],
    ['snake_case and 2*3*4 stay', 'my_var_name 2*3*4', 'my_var_name 2*3*4'],
    ['spoiler', 'it was ||the butler||', 'it was [spoiler: the butler]'],
    ['heading, subtext, quotes', '# Title\n-# small\n> quoted\n>>> block', 'Title small quoted block'],
    ['inline code keeps marks', 'run `**x** <@111>` now', 'run **x** <@111> now'],
    ['code fence drops language', '```js\nconst a_b = 1;\n```', 'const a_b = 1;'],
    ['masked link', '[docs](https://x.org/a_b_c)', 'docs (https://x.org/a_b_c)'],
    ['masked link with same label', '[https://x.org](https://x.org)', 'https://x.org'],
    ['embed-suppressed link', '<https://x.org/__init__>', 'https://x.org/__init__'],
    ['bare URL keeps underscores', 'see https://x.org/_a_ now', 'see https://x.org/_a_ now'],
    ['escaped marks', '\\*not bold\\* and \\_x\\_', '*not bold* and _x_'],
    ['line breaks become spaces', 'one\n\ntwo\r\nthree', 'one two three'],
    // Latin-1
    ['Latin-1 letters stay', 'Smörgåsbord été © ½', 'Smörgåsbord été © ½'],
    ['decomposed accents compose', 'été', 'été'],
    ['diacritic outside Latin-1 to base letter', 'Dvořák Łódź ő', 'Dvorák ?ódz o'],
    ['smart punctuation', '“it’s” — wait… • €5', '"it\'s" - wait... * EUR5'],
    ['zero-width characters dropped', 'a​b', 'ab'],
  ])('%s', (_label, input, expected) => {
    expect(discordToHub(input, [], names)).toBe(expected);
  });
});

describe('Discord -> hub through the bridge', () => {
  let fx: AchievementsFixture;
  let server: Server;
  let discordKey: string;
  let stateDir: string;

  beforeEach(async () => {
    fx = makeAchievementsFixture({ admin: true });
    const token = await fx.adminToken();
    const admin = (p: string) => request(fx.app).post(`/achievements/v1/admin/${p}`).set('Authorization', `Bearer ${token}`);
    discordKey = (await admin('boards').send({ id: 'discord', name: 'Discord' })).body.key as string;
    expect((await admin('boards/discord/relay')).status).toBe(200);
    server = await new Promise<Server>((resolve) => { const s = fx.app.listen(0, '127.0.0.1', () => resolve(s)); });
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-in-'));
  });
  afterEach(async () => {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    _stopChatSweepersForTests();
    fx.cleanup();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
    let ok = false;
    for (let i = 0; i < 200 && !(ok = await cond()); i++) await new Promise((r) => setTimeout(r, 50));
    expect(ok).toBe(true);
  }

  const msg = (over: Partial<InboundMessage> & { id: string }): InboundMessage => ({
    channelId: '777', authorName: 'Bob Smith', authorId: '1234567890', authorBot: false, content: '', attachmentUrls: [], ...over,
  });

  it('relays create, update, reply and delete as handle@DISCORD, drops webhook and bot messages, never echoes', async () => {
    const login = await request(fx.app).post('/chat/v1/sessions').set('Authorization', fx.auth).send({ handle: 'alice', sysop: true });
    const alice = { 'X-Chat-Session': login.body.sid as string };
    const call = (method: 'get' | 'post' | 'put', p: string) => request(fx.app)[method](`/chat/v1${p}`).set('Authorization', fx.auth).set(alice);
    const room = (await call('post', '/rooms').send({ name: 'bridge' })).body.id as string;
    await call('post', `/rooms/${room}/join`);
    expect((await call('put', '/discord').send({ on: true })).status).toBe(200);
    const history = async (): Promise<string[][]> => {
      const t = (await call('get', `/rooms/${room}/history.txt`)).text.split('\r\n').filter(Boolean);
      return t.slice(1).map((l) => l.split('|'));
    };

    const webhookPosts: WebhookPost[] = [];
    const out: DiscordOut = {
      prepare: async () => undefined,
      post: async (_c, p) => { webhookPosts.push(p); return `w${webhookPosts.length}`; },
      edit: async () => { throw new Error('outbound must not edit a Discord-origin message'); },
      remove: async () => { throw new Error('outbound must not delete a Discord-origin message'); },
      jumpLink: () => undefined,
    };
    const config: BridgeConfig = {
      hubUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      boardKey: discordKey,
      rooms: new Map([[room, '777']]),
      discordToken: 'unused',
      dbPath: path.join(stateDir, 'bridge.db'),
      healthPath: path.join(stateDir, 'bridge.health'),
      waitSeconds: 1,
      handle: 'bridge',
    };
    const logs: string[] = [];
    let sink!: InboundSink;
    const bridge = await startBridge(config, (hub, state) => {
      sink = createInbound({ rooms: config.rooms, hub, state, log: (l) => logs.push(l) });
      return { onEvent: createOutbound({ rooms: config.rooms, state, out, fetchBoards: () => hub.mirrorBoards(), log: (l) => logs.push(l) }) };
    }, { log: (l) => logs.push(l), eventAttempts: 2, eventBackoffMs: 5 });
    try {
      // create: sentinel is the history row, authored Bob_Smith@DISCORD.
      await sink.create(msg({ id: 'd1', content: '**hello** ☺ <@7>', mentions: { users: { '7': 'amy' } }, attachmentUrls: ['https://cdn.example/a.png'] }));
      let rows = await history();
      expect(rows).toHaveLength(1);
      expect(rows[0][2]).toBe('Bob_Smith@DISCORD');
      expect(rows[0][7]).toContain('hello :relaxed: @amy https://cdn.example/a.png');
      const hubId = rows[0][1];

      // loop guard: webhook and bot messages post nothing
      await sink.create(msg({ id: 'd2', content: 'from our webhook', webhookId: 'wh1' }));
      await sink.create(msg({ id: 'd3', content: 'from a bot', authorBot: true }));
      await sink.create(msg({ id: 'd4', content: 'unmapped channel', channelId: '999' }));
      expect(await history()).toHaveLength(1);

      // edit
      await sink.update({ ...msg({ id: 'd1', content: 'hello edited' }), contentChanged: true });
      rows = await history();
      expect(rows[0][7]).toContain('hello edited');
      await sink.update({ ...msg({ id: 'd1', content: 'ignored unfurl' }), contentChanged: false });
      expect((await history())[0][7]).toContain('hello edited');

      // reply carries the twin's hub id
      await sink.create(msg({ id: 'd5', authorName: 'carol', content: 'a reply', referenceId: 'd1' }));
      rows = await history();
      expect(rows).toHaveLength(2);
      expect(rows[1][2]).toBe('carol@DISCORD');
      expect(rows[1][4]).toBe(hubId);

      // delete lands; unknown twin is skipped and logged
      await sink.remove({ id: 'd1', channelId: '777' });
      rows = await history();
      expect(rows.map((r) => r[2])).toEqual(['carol@DISCORD']);
      await sink.remove({ id: 'nope', channelId: '777' });
      expect(logs.some((l) => l.includes('delete nope: no hub twin'))).toBe(true);

      // Fence: a real hub message after all the relayed events. The outbound
      // path has seen them in order once this one reaches the webhook.
      await call('post', `/rooms/${room}/messages`).send({ content: 'fence', clientId: 'fence1' });
      await until(() => webhookPosts.length === 1);
      expect(webhookPosts[0].content).toBe('fence');
      expect(webhookPosts).toHaveLength(1); // no relayed row was echoed back to Discord
    } finally {
      await bridge.stop();
    }
  });

  it('logs and drops a hub refusal without retrying', async () => {
    const posts: string[] = [];
    const sink = createInbound({
      rooms: new Map([['r1', '777']]),
      hub: {
        postAs: async () => { posts.push('x'); throw new (await import('../src/discord-bridge/hub-client')).HubError('POST -> 403 muted', 403); },
        editAs: async () => undefined,
        deleteAs: async () => undefined,
      },
      state: { byDiscord: () => undefined, putLink: () => undefined } as never,
      log: (l) => posts.push(l),
    });
    await sink.create(msg({ id: 'd9', content: 'hi' }));
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain('hub refused post d9');
  });
});
