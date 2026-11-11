/**
 * Configuration for the Discord bridge process, all from the environment.
 *
 * The BoardKey and the bot token live only in the host .env, never in git.
 * Same rule as src/config.ts: configured, or refuse to start with a message
 * that names the variable. The bridge never reads the hub's own config.
 */
import { dirname, join } from 'node:path';

export class BridgeConfigError extends Error {}

export interface BridgeConfig {
  /** Hub base URL without a trailing slash, e.g. http://doorserver:3010. */
  hubUrl: string;
  /** The BoardKey of the relay board DISCORD (`<id>.<secret>`). */
  boardKey: string;
  /** Hub room id -> the Discord channels linked to it (one per guild). */
  rooms: RoomChannels;
  /** Discord bot token. */
  discordToken: string;
  /** Bridge-local SQLite file (seq + id map). */
  dbPath: string;
  /** Long-poll seconds asked of the hub. */
  waitSeconds: number;
  /** Handle of the bridge's own hub user (`bridge@DISCORD`). */
  handle: string;
  /** Health file, rewritten after every hub poll (health.ts). */
  healthPath: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new BridgeConfigError(`${name} is not set; the Discord bridge refuses to start without it`);
  return value;
}

/**
 * Room -> channels as the handlers take it: the parsed config (a list per
 * room), or a single channel id per room (older call sites and tests).
 */
export type RoomChannels = ReadonlyMap<string, string | readonly string[]>;

/** The channels linked to one room, in config order ([] when unmapped). */
export function channelsOf(rooms: RoomChannels, room: string): readonly string[] {
  const v = rooms.get(room);
  return v === undefined ? [] : typeof v === 'string' ? [v] : v;
}

/** Every linked channel of every room. */
export function allChannels(rooms: RoomChannels): string[] {
  return [...rooms.keys()].flatMap((r) => [...channelsOf(rooms, r)]);
}

/** Channel id -> the room it is linked to. */
export function roomOfChannel(rooms: RoomChannels): Map<string, string> {
  return new Map([...rooms.keys()].flatMap((r) => channelsOf(rooms, r).map((c) => [c, r] as [string, string])));
}

/**
 * `roomId=channelId,roomId=channelId`; several guilds per room as
 * `roomId=channelA|channelB` (multi-guild). The first channel of a room is
 * the one it had before multi-guild (claimLegacyLinks). Rejects empty parts,
 * a room listed twice, a channel linked twice and an empty map.
 */
export function parseRoomMap(raw: string, name = 'DISCORD_BRIDGE_ROOMS'): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const room = eq < 0 ? '' : trimmed.slice(0, eq).trim();
    const channels = eq < 0 ? [] : trimmed.slice(eq + 1).split('|').map((c) => c.trim());
    if (!room || channels.length === 0 || channels.some((c) => !c)) throw new BridgeConfigError(`${name} entry "${trimmed}" is not roomId=channelId or roomId=channelId|channelId`);
    if (map.has(room)) throw new BridgeConfigError(`${name} maps room ${room} twice; list its channels as roomId=channelA|channelB`);
    for (const c of channels) {
      if (seen.has(c)) throw new BridgeConfigError(`${name} links channel ${c} twice; a channel belongs to one room`);
      seen.add(c);
    }
    map.set(room, channels);
  }
  if (map.size === 0) throw new BridgeConfigError(`${name} maps no rooms; expected roomId=channelId,roomId=channelId`);
  return map;
}

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const hubUrl = required(env, 'DISCORD_BRIDGE_HUB_URL').replace(/\/+$/, '');
  try {
    new URL(hubUrl);
  } catch {
    throw new BridgeConfigError(`DISCORD_BRIDGE_HUB_URL is not a URL: ${hubUrl}`);
  }
  const dbPath = required(env, 'DISCORD_BRIDGE_DB');
  return {
    hubUrl,
    boardKey: required(env, 'DISCORD_BRIDGE_BOARD_KEY'),
    rooms: parseRoomMap(required(env, 'DISCORD_BRIDGE_ROOMS')),
    discordToken: required(env, 'DISCORD_BOT_TOKEN'),
    dbPath,
    waitSeconds: 25,
    handle: 'bridge',
    healthPath: env.DISCORD_BRIDGE_HEALTH?.trim() || join(dirname(dbPath), 'discord-bridge.health'),
  };
}
