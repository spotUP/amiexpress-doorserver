/**
 * Live room map for the Discord bridge (Phase 2).
 *
 * Two layers: the `DISCORD_BRIDGE_ROOMS` env seed (immutable, always wins)
 * and the hub's approved links (replaced on every refresh). The env seed
 * can never be removed by a refresh; revoking a hub link removes only
 * hub-sourced channels. Handlers read through this map on every event,
 * so a new link works without restarting the bridge.
 */
import type { RoomChannels } from './config';

/** What the handlers need: live channel lists, nothing more. */
export interface RoomLookup {
  /** The channels currently linked to `room` (env first, then hub); [] when unmapped. */
  get(room: string): readonly string[];
  /** Every mapped room with its current channels. */
  entries(): Iterable<[string, readonly string[]]>;
}

/** A plain map (or an older single-channel-per-room map) as a RoomLookup. */
export function asLookup(map: RoomChannels): RoomLookup {
  const get = (room: string): readonly string[] => {
    const v = map.get(room);
    return v === undefined ? [] : typeof v === 'string' ? [v] : v;
  };
  return {
    get,
    *entries(): Iterable<[string, readonly string[]]> {
      for (const room of map.keys()) yield [room, get(room)];
    },
  };
}

/** Every linked channel of every room in the lookup. */
export function allLookupChannels(lookup: RoomLookup): string[] {
  const out: string[] = [];
  for (const [, channels] of lookup.entries()) out.push(...channels);
  return out;
}

export interface RoomDiff {
  /** Channels that became linked since the last replace, grouped by room. */
  added: { room: string; channels: string[] }[];
  /** Channels that stopped being linked (hub link revoked). */
  removedChannels: string[];
}

export class LiveRooms implements RoomLookup {
  private readonly env: Map<string, readonly string[]>;
  private hub = new Map<string, readonly string[]>();

  constructor(seed: RoomChannels) {
    this.env = new Map();
    for (const [room, v] of seed) this.env.set(room, typeof v === 'string' ? [v] : [...v]);
  }

  get(room: string): readonly string[] {
    return [...(this.env.get(room) ?? []), ...(this.hub.get(room) ?? [])];
  }

  *entries(): Iterable<[string, readonly string[]]> {
    const rooms = new Set<string>([...this.env.keys(), ...this.hub.keys()]);
    for (const room of rooms) yield [room, this.get(room)];
  }

  /**
   * Replace the hub layer with `next` (room -> channels from links.txt).
   * A hub channel already present in the env seed is skipped: env wins, so
   * one channel never maps to two rooms.
   */
  replace(next: ReadonlyMap<string, readonly string[]>): RoomDiff {
    const before = new Map(this.entries());
    const envChannels = new Set(allLookupChannels(asLookup(this.env)));
    const filtered = new Map<string, string[]>();
    for (const [room, channels] of next) {
      const kept = channels.filter((c) => !envChannels.has(c));
      if (kept.length > 0) filtered.set(room, kept);
    }
    this.hub = new Map(filtered);
    const after = new Map(this.entries());
    const added: { room: string; channels: string[] }[] = [];
    for (const [room, channels] of after) {
      const prev = new Set(before.get(room) ?? []);
      const fresh = channels.filter((c) => !prev.has(c));
      if (fresh.length > 0) added.push({ room, channels: fresh });
    }
    const afterChannels = new Set(allLookupChannels({ get: (r) => after.get(r) ?? [], entries: () => after.entries() }));
    const removedChannels = allLookupChannels({ get: (r) => before.get(r) ?? [], entries: () => before.entries() }).filter(
      (c) => !afterChannels.has(c),
    );
    return { added, removedChannels };
  }

  /** Drop hub-sourced `channels` (a failed prepare); env entries are untouched. */
  drop(channels: readonly string[]): void {
    const gone = new Set(channels);
    for (const [room, list] of this.hub) {
      const kept = list.filter((c) => !gone.has(c));
      if (kept.length === 0) this.hub.delete(room);
      else this.hub.set(room, kept);
    }
  }
}
