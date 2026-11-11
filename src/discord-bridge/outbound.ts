/**
 * Hub -> Discord: turns hub events into webhook calls. Message events are
 * posted under the author's display label, edits and deletes find their
 * twin through the id map, replies carry one quote line (webhooks cannot
 * send message_reference).
 *
 * Multi-guild (2026-11-12): a room may be linked to one channel in each of
 * several guilds. createFanout owns the per-channel webhook work and is
 * shared with inbound.ts, which uses it to copy a message posted in one
 * guild to the room's other guilds (never back to its own channel).
 */
import { CHAT_DISCORD_BOARD } from '../../contract/chat-types';
import { channelsOf } from './config';
import type { RoomChannels } from './config';
import { composeMessage, webhookName } from './text';
import type { MentionResolver, ReplyQuote } from './text';
import type { DiscordOut } from './discord-out';
import type { BridgeState } from './state';
import type { BridgeEvent } from './wire';

export const BOARDS_MAX_AGE_MS = 60000;

export interface MirrorBoards {
  rev: number;
  boards: Set<string>;
}

export interface FanoutDeps {
  /** Hub room id -> its linked Discord channel(s). */
  rooms: RoomChannels;
  state: BridgeState;
  out: DiscordOut;
  /** Discord channel id + hub `@name` -> Discord user id (gateway member cache). Absent: no pings. */
  resolveMention?: (channelId: string, name: string) => string | undefined;
  log?: (line: string) => void;
  now?: () => number;
}

export interface OutboundDeps extends FanoutDeps {
  /** GET /discord/boards.txt */
  fetchBoards: () => Promise<MirrorBoards>;
}

/** One hub message as the fan-out posts it. */
export interface FanoutMessage {
  hubMessageId: string;
  room: string;
  /** Webhook display name (escaped by webhookName). */
  label: string;
  /** Hub text (hub form; composeMessage turns it into Discord form per channel). */
  text: string;
  /** Hub id of the parent message, '' or undefined when not a reply. */
  replyTo?: string;
}

export interface Fanout {
  /** Post to every linked channel of the room that has no twin yet, except `skipChannel`. */
  post(m: FanoutMessage, skipChannel?: string): Promise<void>;
  /** Edit every webhook twin of the hub message, except the one in `skipChannel`. */
  edit(hubMessageId: string, text: string, replyTo?: string, skipChannel?: string): Promise<void>;
  /** Delete every webhook twin of the hub message, except the one in `skipChannel`; each map row goes as its twin goes. */
  remove(hubMessageId: string, skipChannel?: string): Promise<void>;
}

/** The part of `user` after the last `@`, upper-cased; '' when there is none. */
export function boardOf(user: string): string {
  const at = user.lastIndexOf('@');
  return at < 0 ? '' : user.slice(at + 1).toUpperCase();
}

export function createFanout(deps: FanoutDeps): Fanout {
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? Date.now;

  function resolverFor(channel: string): MentionResolver | undefined {
    const r = deps.resolveMention;
    return r ? (name) => r(channel, name) : undefined;
  }

  /** The parent's twin in this channel, falling back to any twin for the text (a legacy row has no channel). */
  function quoteOf(replyTo: string | undefined, channel: string, ref: string): ReplyQuote | undefined {
    if (!replyTo) return undefined;
    const here = deps.state.byHubIn(replyTo, channel);
    const parent = here ?? deps.state.byHub(replyTo);
    if (parent && parent.content !== undefined) {
      return { label: parent.authorLabel || '?', text: parent.content, link: here ? deps.out.jumpLink(channel, here.discordMessageId) : undefined };
    }
    log(`[INFO] reply ${ref}: parent ${replyTo} has no twin; posting without a quote`);
    return undefined;
  }

  return {
    async post(m, skipChannel) {
      for (const channel of channelsOf(deps.rooms, m.room)) {
        if (channel === skipChannel) continue; // never echo to the channel it came from
        if (deps.state.byHubIn(m.hubMessageId, channel)) continue; // replayed or retried: already posted here
        const id = await deps.out.post(channel, { username: webhookName(m.label), ...composeMessage(m.text, quoteOf(m.replyTo, channel, m.hubMessageId), resolverFor(channel)) });
        deps.state.putLink({ hubMessageId: m.hubMessageId, discordMessageId: id, roomId: m.room, channelId: channel, createdAt: now(), authorLabel: m.label, content: m.text });
      }
    },
    async edit(hubMessageId, text, replyTo, skipChannel) {
      const links = deps.state.linksOf(hubMessageId).filter((l) => !l.source && l.channelId !== skipChannel);
      if (links.length === 0) log(`[INFO] edit ${hubMessageId}: no Discord twin, skipped`);
      for (const l of links) {
        const channel = l.channelId ?? '';
        await deps.out.edit(channel, l.discordMessageId, composeMessage(text, quoteOf(replyTo, channel, hubMessageId), resolverFor(channel)));
      }
      deps.state.setContent(hubMessageId, text);
    },
    async remove(hubMessageId, skipChannel) {
      const links = deps.state.linksOf(hubMessageId).filter((l) => !l.source && l.channelId !== skipChannel);
      if (links.length === 0) log(`[INFO] delete ${hubMessageId}: no Discord twin, skipped`);
      for (const l of links) {
        await deps.out.remove(l.channelId ?? '', l.discordMessageId);
        deps.state.removeByDiscord(l.discordMessageId);
      }
    },
  };
}

export function createOutbound(deps: OutboundDeps): (ev: BridgeEvent) => Promise<void> {
  const now = deps.now ?? Date.now;
  const fanout = createFanout(deps);
  let cache: (MirrorBoards & { at: number }) | null = null;

  /** D5: cached by rev, refreshed on a discord_mirror event or after 60 s. */
  async function mirrored(board: string): Promise<boolean> {
    if (!cache || now() - cache.at >= BOARDS_MAX_AGE_MS) cache = { ...(await deps.fetchBoards()), at: now() };
    return cache.boards.has(board);
  }

  const fromDiscord = (ev: BridgeEvent): boolean => boardOf(ev.user) === CHAT_DISCORD_BOARD.toUpperCase();

  async function onMessage(ev: BridgeEvent): Promise<void> {
    // Loop guard: a Discord-origin message was already copied guild-to-guild by inbound.ts.
    if (fromDiscord(ev)) return;
    // Every linked channel has its twin: replayed after a restart, nothing to fetch.
    if (channelsOf(deps.rooms, ev.room).every((c) => deps.state.byHubIn(ev.ref, c))) return;
    if (!(await mirrored(boardOf(ev.user)))) return;
    await fanout.post({ hubMessageId: ev.ref, room: ev.room, label: ev.label || ev.user, text: ev.text, replyTo: ev.replyTo });
  }

  return async (ev) => {
    if (ev.type === 'discord_mirror') {
      cache = null;
      return;
    }
    if (ev.type !== 'message' && ev.type !== 'edit' && ev.type !== 'delete') return;
    if (channelsOf(deps.rooms, ev.room).length === 0) return;
    if (ev.type === 'message') return onMessage(ev);
    if (fromDiscord(ev)) return; // echo guard: the edit/delete came from Discord, inbound.ts fanned it out
    if (ev.type === 'edit') return fanout.edit(ev.ref, ev.text, ev.replyTo);
    return fanout.remove(ev.ref);
  };
}
