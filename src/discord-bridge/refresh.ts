/**
 * Hub-link refresh (Phase 2): the bridge picks up approved Discord links
 * without a restart. Triggered by the hub `discord_link` event and a 60 s
 * fallback poll; overlapping runs are skipped, never queued.
 */
import { LiveRooms } from './rooms';
import type { HubClient } from './hub-client';
import type { DiscordOut } from './discord-out';

export interface RefreshDeps {
  hub: Pick<HubClient, 'discordLinks' | 'reportLinkError' | 'joinRoom'>;
  rooms: LiveRooms;
  out: Pick<DiscordOut, 'prepare'>;
  log?: (line: string) => void;
}

export interface RefreshResult {
  addedChannels: number;
  addedRooms: number;
  removedChannels: number;
  errors: number;
}

/**
 * One refresh pass: fetch the hub links, swap the hub layer, prepare new
 * channels and join new rooms. A channel whose webhook prepare fails is
 * reported to the hub (status failed, shown by `/discord status`) and left
 * out of the live map, so the next pass retries it.
 */
export async function refreshLinks(deps: RefreshDeps): Promise<RefreshResult> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const links = await deps.hub.discordLinks();
  const byId = new Map(links.map((l) => [l.channelId, l.id]));
  const next = new Map<string, string[]>();
  for (const l of links) {
    const list = next.get(l.room);
    if (list) {
      if (!list.includes(l.channelId)) list.push(l.channelId);
    } else next.set(l.room, [l.channelId]);
  }
  const diff = deps.rooms.replace(next);
  let errors = 0;
  for (const { room, channels } of diff.added) {
    try {
      await deps.out.prepare(channels);
      await deps.hub.joinRoom(room);
    } catch (err) {
      const msg = (err as Error).message.slice(0, 200);
      log(`[WARN] discord link to room ${room} failed (${channels.length} channel(s)): ${msg}`);
      for (const c of channels) {
        const id = byId.get(c);
        if (id !== undefined) await deps.hub.reportLinkError(id, msg).catch((e) => log(`[ERROR] reportLinkError: ${(e as Error).message}`));
      }
      deps.rooms.drop(channels);
      errors += 1;
    }
  }
  const addedChannels = diff.added.reduce((n, a) => n + a.channels.length, 0);
  log(`[OK] discord links refreshed: ${addedChannels} added channel(s) in ${diff.added.length} room(s), ${diff.removedChannels.length} removed, ${errors} error(s)`);
  return { addedChannels, addedRooms: diff.added.length, removedChannels: diff.removedChannels.length, errors };
}

/** Runs refreshLinks unless one is already in flight. */
export function createRefresher(deps: RefreshDeps): { refresh: (why: string) => Promise<RefreshResult | null> } {
  let running: Promise<RefreshResult> | null = null;
  return {
    refresh(why: string): Promise<RefreshResult | null> {
      if (running) {
        (deps.log ?? console.log)(`[INFO] discord refresh (${why}) skipped: one already running`);
        return Promise.resolve(null);
      }
      running = refreshLinks(deps).finally(() => {
        running = null;
      });
      return running;
    },
  };
}
