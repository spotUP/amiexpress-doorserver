/**
 * Discord bridge multi-guild (2026-11-12): one hub room linked to a channel
 * in each of several guilds. Hub messages fan out to every linked channel; a
 * message posted in one guild reaches the hub once and is copied to the other
 * guilds, never echoed to its own channel. Fake DiscordOut and hub; real
 * BridgeState on a temp file.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { parseRoomMap } from '../src/discord-bridge/config';
import { BridgeState } from '../src/discord-bridge/state';
import { createFanout, createOutbound } from '../src/discord-bridge/outbound';
import { createInbound } from '../src/discord-bridge/inbound';
import { guildLabel } from '../src/discord-bridge/text';
import type { InboundMessage } from '../src/discord-bridge/inbound';
import type { DiscordOut } from '../src/discord-bridge/discord-out';
import type { BridgeEvent } from '../src/discord-bridge/wire';

const tmpState = (): { state: BridgeState; file: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mg-'));
  const file = path.join(dir, 's.db');
  return { state: new BridgeState(file), file };
};

/** Records every webhook call as `op channel name-or-id`. */
function fakeOut(): { out: DiscordOut; calls: string[] } {
  const calls: string[] = [];
  let n = 0;
  const out: DiscordOut = {
    prepare: async () => undefined,
    post: async (channel, p) => { calls.push(`post ${channel} ${p.username}`); n++; return `w${n}`; },
    edit: async (channel, id) => { calls.push(`edit ${channel} ${id}`); },
    remove: async (channel, id) => { calls.push(`remove ${channel} ${id}`); },
    jumpLink: () => undefined,
  };
  return { out, calls };
}

describe('parseRoomMap with several guilds', () => {
  it('reads roomId=channelA|channelB and keeps the single-channel form', () => {
    expect([...parseRoomMap('r1=a|b, r2=c')]).toEqual([['r1', ['a', 'b']], ['r2', ['c']]]);
    expect(() => parseRoomMap('r1=a|a')).toThrow(/twice/);
    expect(() => parseRoomMap('r1=a,r2=a')).toThrow(/twice/);
    expect(() => parseRoomMap('r1=a|')).toThrow(/roomId=channelId/);
  });
});

describe('hub -> every linked guild', () => {
  const ev = (over: Partial<BridgeEvent>): BridgeEvent => ({ seq: 1, type: 'message', room: 'r', user: 'amy@B', ref: 'h1', at: '', roleColor: '', text: 'hi', replyTo: '', label: 'amy', ...over });

  it('posts, edits and deletes in each channel once', async () => {
    const { state } = tmpState();
    const { out, calls } = fakeOut();
    const handler = createOutbound({
      rooms: new Map([['r', ['A', 'B']]]), state, out,
      fetchBoards: async () => ({ rev: 1, boards: new Set(['B']) }), log: () => undefined,
    });
    await handler(ev({}));
    await handler(ev({})); // replay after a restart
    expect(calls).toEqual(['post A amy', 'post B amy']);
    await handler(ev({ type: 'edit', text: 'hi2' }));
    expect(calls.slice(2)).toEqual(['edit A w1', 'edit B w2']);
    await handler(ev({ type: 'delete' }));
    expect(calls.slice(4)).toEqual(['remove A w1', 'remove B w2']);
    expect(state.linksOf('h1')).toEqual([]);
  });
});

describe('guild -> hub and the other guilds', () => {
  const msg = (over: Partial<InboundMessage>): InboundMessage => ({
    id: 'd1', channelId: 'B', authorName: 'bob', authorId: '1234', authorBot: false, content: 'hello',
    attachmentUrls: [], guildName: 'Guild B', ...over,
  });

  function setup() {
    const { state } = tmpState();
    const { out, calls } = fakeOut();
    const rooms = new Map([['r', ['A', 'B', 'C']]]);
    const hubCalls: string[] = [];
    let n = 0;
    const hub = {
      postAs: async (room: string, as: string, text: string) => { hubCalls.push(`post ${room} ${as} ${text}`); n++; return `h${n}`; },
      editAs: async (id: string, _as: string, text: string) => { hubCalls.push(`edit ${id} ${text}`); },
      deleteAs: async (id: string) => { hubCalls.push(`delete ${id}`); },
      uploadFileAs: async () => { throw new Error('no files in this test'); },
    } as never;
    const fanout = createFanout({ rooms, state, out, log: () => undefined });
    const sink = createInbound({ rooms, hub, state, fanout, log: () => undefined });
    return { state, calls, hubCalls, sink };
  }

  it('posts to the hub once and copies to the other guilds with a guild label, never back', async () => {
    const { state, calls, hubCalls, sink } = setup();
    await sink.create(msg({}));
    expect(hubCalls).toEqual(['post r bob hello']);
    expect(calls).toEqual(['post A bob (Guild B)', 'post C bob (Guild B)']);
    expect(state.byDiscord('d1')).toMatchObject({ hubMessageId: 'h1', channelId: 'B', source: true });

    // The copies arrive back over the gateway as webhook posts: dropped.
    await sink.create(msg({ id: 'w1', channelId: 'A', webhookId: 'wh', guildName: 'Guild A' }));
    expect(hubCalls).toHaveLength(1);

    await sink.update({ ...msg({ content: 'hello again' }), contentChanged: true });
    expect(hubCalls[1]).toBe('edit h1 hello again');
    expect(calls.slice(2)).toEqual(['edit A w1', 'edit C w2']);
  });

  it('a guild moderator deleting a copy removes it in that guild only', async () => {
    const { state, calls, hubCalls, sink } = setup();
    await sink.create(msg({}));
    await sink.remove({ id: 'w1', channelId: 'A' });
    expect(hubCalls).toEqual(['post r bob hello']);
    expect(state.byDiscord('w1')).toBeUndefined();
    expect(state.linksOf('h1').map((l) => l.channelId)).toEqual(['B', 'C']);

    // The author deletes the original: hub and the remaining copy go.
    await sink.remove({ id: 'd1', channelId: 'B' });
    expect(hubCalls[1]).toBe('delete h1');
    expect(calls.slice(2)).toEqual(['remove C w2']);
    expect(state.linksOf('h1')).toEqual([]);
  });
});

describe('message map from before multi-guild', () => {
  it('migrates rows to the room\'s first channel as webhook copies', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mg-old-'));
    const file = path.join(dir, 's.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE message_map (hub_message_id TEXT PRIMARY KEY, discord_message_id TEXT NOT NULL UNIQUE,
      room_id TEXT NOT NULL, created_at INTEGER NOT NULL, author_label TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '');
      CREATE INDEX message_map_created ON message_map(created_at);
      INSERT INTO message_map VALUES ('h1', 'd1', 'r', 5, 'amy', 'hi');`);
    old.close();
    const state = new BridgeState(file);
    expect(state.claimLegacyLinks((room) => (room === 'r' ? 'A' : undefined))).toBe(1);
    expect(state.byHubIn('h1', 'A')).toMatchObject({ discordMessageId: 'd1', source: false, authorLabel: 'amy', content: 'hi' });
    expect(state.claimLegacyLinks(() => 'A')).toBe(0);
    state.close();
  });
});

describe('multi-guild review fixes (2026-11-12)', () => {
  const rooms = new Map([['r', ['A', 'B', 'C']]]);
  const nolog = (): void => undefined;
  const gone = (): Error & { status: number } => Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
  const ev = (over: Partial<BridgeEvent>): BridgeEvent => ({ seq: 1, type: 'delete', room: 'r', user: 'sys@BBS', ref: 'h1', at: '', roleColor: '', text: '', replyTo: '', label: '', ...over });
  const seed = (state: BridgeState, source = true): void => {
    if (source) state.putLink({ hubMessageId: 'h1', discordMessageId: 'd1', roomId: 'r', channelId: 'B', source: true, createdAt: 1, authorLabel: 'bob', content: 'hello' });
    state.putLink({ hubMessageId: 'h1', discordMessageId: 'w1', roomId: 'r', channelId: 'A', createdAt: 1, authorLabel: 'bob (Guild B)', content: 'hello' });
    state.putLink({ hubMessageId: 'h1', discordMessageId: 'w2', roomId: 'r', channelId: 'C', createdAt: 1, authorLabel: 'bob (Guild B)', content: 'hello' });
  };

  it('copies an attachment-only message to the hub and the other guilds as links', async () => {
    const { state } = tmpState();
    const { out, calls } = fakeOut();
    const posted: string[] = [];
    const hub = {
      postAs: async (_r: string, _a: string, text: string) => { posted.push(text); return 'h1'; },
      editAs: async () => undefined, deleteAs: async () => undefined, uploadFileAs: async () => undefined,
    } as never;
    const realFetch = global.fetch;
    global.fetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    try {
      const sink = createInbound({ rooms, hub, state, fanout: createFanout({ rooms, state, out, log: nolog }), log: nolog });
      await sink.create({
        id: 'd1', channelId: 'B', authorName: 'bob', authorId: '1234', authorBot: false, content: '', guildName: 'Guild B',
        attachmentUrls: ['https://cdn.example/a.png'], attachments: [{ id: 'a1', name: 'a.png', size: 10, url: 'https://cdn.example/a.png' }],
      });
    } finally { global.fetch = realFetch; }
    expect(posted).toEqual(['https://cdn.example/a.png']);
    expect(calls).toEqual(['post A bob (Guild B)', 'post C bob (Guild B)']);
  });

  it('a failing channel does not stop the others; a retry posts only where it failed', async () => {
    const { state } = tmpState();
    const calls: string[] = [];
    let n = 0;
    let broken = true;
    const out: DiscordOut = {
      prepare: async () => undefined,
      post: async (c) => { if (c === 'A' && broken) throw new Error('boom'); calls.push(`post ${c}`); n++; return `w${n}`; },
      edit: async () => undefined, remove: async () => undefined, jumpLink: () => undefined,
    };
    const fanout = createFanout({ rooms, state, out, log: nolog });
    const m = { hubMessageId: 'h1', room: 'r', label: 'amy', text: 'hi' };
    await expect(fanout.post(m)).rejects.toThrow(/post h1 in A: boom/);
    expect(calls).toEqual(['post B', 'post C']);
    broken = false;
    await fanout.post(m);
    expect(calls).toEqual(['post B', 'post C', 'post A']);
  });

  it('edit and remove: 404 means gone (row dropped), other errors are thrown at the end, empty channel skipped', async () => {
    const { state } = tmpState();
    seed(state, false);
    state.putLink({ hubMessageId: 'h1', discordMessageId: 'old', roomId: 'r', createdAt: 1, authorLabel: '', content: '' });
    const calls: string[] = [];
    const out: DiscordOut = {
      prepare: async () => undefined, post: async () => 'x', jumpLink: () => undefined,
      edit: async (c, id) => { calls.push(`edit ${c}`); if (c === 'A') throw gone(); if (c === 'C') throw new Error('boom'); void id; },
      remove: async (c) => { calls.push(`remove ${c}`); if (c === 'A') throw gone(); if (c === 'C') throw new Error('boom'); },
    };
    const fanout = createFanout({ rooms, state, out, log: nolog });
    await expect(fanout.edit('h1', 'new')).rejects.toThrow(/in C: boom/);
    expect(calls).toEqual(['edit A', 'edit C']); // legacy row with no channel: no call
    expect(state.byDiscord('w1')).toBeUndefined();
    expect(state.byDiscord('w2')).toMatchObject({ content: 'new' });
    state.putLink({ hubMessageId: 'h1', discordMessageId: 'w1', roomId: 'r', channelId: 'A', createdAt: 1, authorLabel: '', content: '' });
    calls.length = 0;
    await expect(fanout.remove('h1')).rejects.toThrow(/in C: boom/);
    expect([...calls].sort()).toEqual(['remove A', 'remove C']);
    expect(state.byDiscord('w1')).toBeUndefined();
    expect(state.byDiscord('w2')).toBeDefined(); // failed: kept for the retry
    expect(state.byDiscord('old')).toBeDefined();
  });

  it('a sysop deleting or editing a Discord-origin message reaches every webhook copy, not the original', async () => {
    const { state } = tmpState();
    const { out, calls } = fakeOut();
    seed(state);
    const handler = createOutbound({ rooms, state, out, fetchBoards: async () => ({ rev: 1, boards: new Set<string>() }), log: nolog });
    // Echo of the bridge's own edit (hub text equals the source row): nothing to do.
    await handler(ev({ type: 'edit', user: 'bob@DISCORD', text: 'hello' }));
    expect(calls).toEqual([]);
    // A sysop edit arriving under the author's identity differs from the source row: copies follow.
    await handler(ev({ type: 'edit', user: 'bob@DISCORD', text: 'moderated' }));
    expect(calls).toEqual(['edit A w1', 'edit C w2']);
    expect(state.byDiscord('d1')).toMatchObject({ source: true, content: 'hello' }); // source row keeps the hub's own text
    expect(state.byDiscord('w1')).toMatchObject({ content: 'moderated' });
    calls.length = 0;
    await handler(ev({ type: 'delete', user: 'sys@BBS' }));
    expect(calls).toEqual(['remove A w1', 'remove C w2']); // never remove B d1
    expect(state.linksOf('h1')).toEqual([]);
  });

  it('webhook name keeps the guild suffix when the handle is long', () => {
    const name = guildLabel('h'.repeat(100), 'Guild B');
    expect(name).toHaveLength(80);
    expect(name.endsWith(' (Guild B)')).toBe(true);
    const long = guildLabel('bob', 'G'.repeat(200));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.startsWith('bob (GGG')).toBe(true);
    expect(long.endsWith(')')).toBe(true);
    expect(guildLabel('d'.repeat(79), 'x').endsWith(' (x)')).toBe(true);
  });
});
