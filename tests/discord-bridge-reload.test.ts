/**
 * Discord bridge runtime reload (Phase 2): hub links layer onto the env seed
 * without a restart. Fake hub + fake webhooks; real LiveRooms + BridgeState.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LiveRooms, asLookup, allLookupChannels } from '../src/discord-bridge/rooms';
import { refreshLinks, createRefresher } from '../src/discord-bridge/refresh';
import { BridgeState } from '../src/discord-bridge/state';
import { createFanout, createOutbound } from '../src/discord-bridge/outbound';
import type { DiscordOut } from '../src/discord-bridge/discord-out';
import type { BridgeEvent } from '../src/discord-bridge/wire';

const tmpState = (): { state: BridgeState; dir: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-reload-'));
  return { state: new BridgeState(path.join(dir, 's.db')), dir };
};

type Link = { id: number; room: string; channelId: string };

function fakeHub(initial: Link[]): {
  hub: {
    discordLinks: () => Promise<Link[]>;
    reportLinkError: (id: number, error: string) => Promise<void>;
    joinRoom: (room: string) => Promise<void>;
    setDiscordApp: (id: string) => Promise<void>;
  };
  links: Link[];
  errors: { id: number; error: string }[];
  joined: string[];
} {
  const links: Link[] = [...initial];
  const errors: { id: number; error: string }[] = [];
  const joined: string[] = [];
  return {
    links,
    errors,
    joined,
    hub: {
      discordLinks: async () => links.map((l) => ({ ...l })),
      reportLinkError: async (id, error) => {
        errors.push({ id, error });
      },
      joinRoom: async (room) => {
        joined.push(room);
      },
      setDiscordApp: async () => undefined,
    },
  };
}

function fakeOut(failPrepare: Set<string> = new Set()): { out: DiscordOut; prepared: string[]; posts: string[] } {
  const prepared: string[] = [];
  const posts: string[] = [];
  const out: DiscordOut = {
    prepare: async (channels) => {
      for (const c of channels) {
        if (failPrepare.has(c)) throw new Error(`webhook of ${c} is gone`);
        prepared.push(c);
      }
    },
    post: async (channel) => {
      posts.push(channel);
      return `w${posts.length}`;
    },
    edit: async () => undefined,
    remove: async () => undefined,
    jumpLink: () => undefined,
  };
  return { out, prepared, posts };
}

describe('LiveRooms', () => {
  it('serves the env seed and normalizes single-channel maps', () => {
    const rooms = new LiveRooms(new Map([['r1', 'a']]));
    expect(rooms.get('r1')).toEqual(['a']);
    expect(rooms.get('nope')).toEqual([]);
    expect([...rooms.entries()]).toEqual([['r1', ['a']]]);
  });

  it('layers hub links on, env always wins on a collision', () => {
    const rooms = new LiveRooms(new Map([['r1', ['a']]]));
    const diff = rooms.replace(new Map([['r1', ['b']], ['r2', ['a', 'c']]]));
    // channel a stays only in r1 (env); hub keeps b in r1 and c in r2.
    expect(rooms.get('r1')).toEqual(['a', 'b']);
    expect(rooms.get('r2')).toEqual(['c']);
    expect(diff.added).toEqual([
      { room: 'r1', channels: ['b'] },
      { room: 'r2', channels: ['c'] },
    ]);
  });

  it('a revoked hub link disappears, env entries stay', () => {
    const rooms = new LiveRooms(new Map([['r1', ['a']]]));
    rooms.replace(new Map([['r1', ['b']]]));
    const diff = rooms.replace(new Map());
    expect(rooms.get('r1')).toEqual(['a']);
    expect(diff.removedChannels).toEqual(['b']);
  });

  it('drop removes only hub channels', () => {
    const rooms = new LiveRooms(new Map([['r1', ['a']]]));
    rooms.replace(new Map([['r1', ['b']]]));
    rooms.drop(['a', 'b']);
    expect(rooms.get('r1')).toEqual(['a']);
  });
});

describe('refreshLinks', () => {
  it('prepares each new channel once and joins new rooms', async () => {
    const { state, dir } = tmpState();
    const rooms = new LiveRooms(new Map([['r1', ['a']]]));
    const f = fakeHub([{ id: 7, room: 'r1', channelId: 'b' }]);
    const o = fakeOut();
    const logs: string[] = [];
    const r1 = await refreshLinks({ hub: f.hub, rooms, out: o.out, log: (l) => logs.push(l) });
    expect(o.prepared).toEqual(['b']);
    expect(f.joined).toEqual(['r1']);
    expect(r1).toEqual({ addedChannels: 1, addedRooms: 1, removedChannels: 0, errors: 0 });
    const r2 = await refreshLinks({ hub: f.hub, rooms, out: o.out, log: () => undefined });
    expect(o.prepared).toEqual(['b']);
    expect(r2.errors).toBe(0);
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a failed prepare reports the error, drops the channel, and retries later', async () => {
    const { state, dir } = tmpState();
    const rooms = new LiveRooms(new Map());
    const f = fakeHub([{ id: 9, room: 'r2', channelId: 'bad' }]);
    const fail = new Set(['bad']);
    const o = fakeOut(fail);
    const logs: string[] = [];
    const r1 = await refreshLinks({ hub: f.hub, rooms, out: o.out, log: (l) => logs.push(l) });
    expect(f.errors).toEqual([{ id: 9, error: 'webhook of bad is gone' }]);
    expect(rooms.get('r2')).toEqual([]);
    expect(r1.errors).toBe(1);
    fail.clear();
    const r2 = await refreshLinks({ hub: f.hub, rooms, out: o.out, log: () => undefined });
    expect(rooms.get('r2')).toEqual(['bad']);
    expect(r2.errors).toBe(0);
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fanout reaches a refreshed channel without reconstruction', async () => {
    const { state, dir } = tmpState();
    const rooms = new LiveRooms(new Map([['r1', ['a']]]));
    const f = fakeHub([{ id: 7, room: 'r1', channelId: 'b' }]);
    const o = fakeOut();
    const fanout = createFanout({ rooms, state, out: o.out, log: () => undefined });
    await refreshLinks({ hub: f.hub, rooms, out: o.out, log: () => undefined });
    await fanout.post({ hubMessageId: 'h9', room: 'r1', label: 'amy', text: 'hi' });
    expect(o.posts).toEqual(['a', 'b']);
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a second refresh while one runs is skipped', async () => {
    const rooms = new LiveRooms(new Map());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeHub([]);
    const refresher = createRefresher({
      hub: { ...f.hub, discordLinks: () => gate.then(() => f.links) },
      rooms,
      out: fakeOut().out,
      log: () => undefined,
    });
    const first = refresher.refresh('event');
    const second = await refresher.refresh('event');
    expect(second).toBeNull();
    release();
    const r = await first;
    expect(r).not.toBeNull();
  });

  it('outbound ignores discord_link events (no channel post)', async () => {
    const { state, dir } = tmpState();
    const rooms = new LiveRooms(new Map([['r1', ['a']]]));
    const o = fakeOut();
    const outbound = createOutbound({ rooms, state, out: o.out, fetchBoards: async () => ({ rev: 1, boards: new Set() }), log: () => undefined });
    const ev: BridgeEvent = { seq: 3, type: 'discord_link', room: 'r1', user: 'sysop@B', ref: '7', at: '', roleColor: '', text: 'linked', replyTo: '', label: '' };
    await outbound(ev);
    expect(o.posts).toEqual([]);
    state.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('allLookupChannels', () => {
  it('lists every linked channel once', () => {
    const rooms = new LiveRooms(new Map([['r1', ['a']]]));
    rooms.replace(new Map([['r1', ['b']], ['r2', ['c']]]));
    expect(allLookupChannels(rooms).sort()).toEqual(['a', 'b', 'c']);
  });
});
