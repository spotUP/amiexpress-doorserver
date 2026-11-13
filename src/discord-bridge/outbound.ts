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
import type { DiscordOut, WebhookAttachment } from './discord-out';
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
  /** Bytes of a hub file, to upload a shared picture to Discord. Absent: pictures go as a text line. */
  fetchFile?: (fileId: string) => Promise<Buffer>;
}

/** Discord's webhook upload limit is 25 MB on current servers; stay under the 10 MB older servers allow. */
export const PICTURE_UPLOAD_MAX = 8 * 1024 * 1024;

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
  /** Uploaded with the post (a shared picture). */
  attachment?: WebhookAttachment;
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
      const failed = new Failures();
      for (const channel of channelsOf(deps.rooms, m.room)) {
        if (channel === skipChannel) continue; // never echo to the channel it came from
        if (deps.state.byHubIn(m.hubMessageId, channel)) continue; // replayed or retried: already posted here
        try {
          const id = await deps.out.post(channel, { username: webhookName(m.label), ...composeMessage(m.text, quoteOf(m.replyTo, channel, m.hubMessageId), resolverFor(channel)), ...(m.attachment ? { attachment: m.attachment } : {}) });
          deps.state.putLink({ hubMessageId: m.hubMessageId, discordMessageId: id, roomId: m.room, channelId: channel, createdAt: now(), authorLabel: m.label, content: m.text });
        } catch (err) {
          failed.add(`post ${m.hubMessageId}`, channel, err); // the other servers still get their copy; a retry only redoes this channel
        }
      }
      failed.throwIfAny();
    },
    async edit(hubMessageId, text, replyTo, skipChannel) {
      const links = deps.state.linksOf(hubMessageId).filter((l) => !l.source && l.channelId !== skipChannel);
      if (links.length === 0) log(`[INFO] edit ${hubMessageId}: no Discord twin, skipped`);
      const failed = new Failures();
      for (const l of links) {
        const channel = l.channelId ?? '';
        if (!channel) {
          log(`[INFO] edit ${hubMessageId}: twin ${l.discordMessageId} has no channel (legacy row), skipped`);
          continue;
        }
        try {
          await deps.out.edit(channel, l.discordMessageId, composeMessage(text, quoteOf(replyTo, channel, hubMessageId), resolverFor(channel)));
        } catch (err) {
          if (isGone(err)) {
            log(`[INFO] edit ${hubMessageId}: twin ${l.discordMessageId} in ${channel} is gone, row dropped`);
            deps.state.removeByDiscord(l.discordMessageId);
          } else failed.add(`edit ${hubMessageId}`, channel, err);
        }
      }
      deps.state.setCopyContent(hubMessageId, text);
      failed.throwIfAny();
    },
    async remove(hubMessageId, skipChannel) {
      const links = deps.state.linksOf(hubMessageId).filter((l) => !l.source && l.channelId !== skipChannel);
      if (links.length === 0) log(`[INFO] delete ${hubMessageId}: no Discord twin, skipped`);
      const failed = new Failures();
      for (const l of links) {
        const channel = l.channelId ?? '';
        if (!channel) {
          log(`[INFO] delete ${hubMessageId}: twin ${l.discordMessageId} has no channel (legacy row), skipped`);
          continue;
        }
        try {
          await deps.out.remove(channel, l.discordMessageId);
        } catch (err) {
          if (!isGone(err)) {
            failed.add(`delete ${hubMessageId}`, channel, err);
            continue;
          }
          log(`[INFO] delete ${hubMessageId}: twin ${l.discordMessageId} in ${channel} was already gone`);
        }
        deps.state.removeByDiscord(l.discordMessageId);
      }
      failed.throwIfAny();
    },
  };
}

/** Discord answered 404 (10008 Unknown Message, 10003 Unknown Channel, 10015 Unknown Webhook): the twin no longer exists. */
export function isGone(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; code?: unknown };
  return e.status === 404 || e.code === 10008 || e.code === 10003 || e.code === 10015;
}

/** Collects per-channel errors so one bad channel does not stop the others; throws once at the end. */
class Failures {
  private readonly lines: string[] = [];
  add(what: string, channel: string, err: unknown): void {
    this.lines.push(`${what} in ${channel}: ${err instanceof Error ? err.message : String(err)}`);
  }
  throwIfAny(): void {
    if (this.lines.length > 0) throw new Error(this.lines.join('; '));
  }
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

  /**
   * file_shared text is `name|size|kind` in the hub, but the EVENTS text wire escapes every `|` in a cell to `!`
   * (src/text-format.ts esc), so the bridge reads `name!size!kind`. Accept both, like the C door (livechat.c shared_add).
   * The name may itself hold `!` or `|`, so take size and kind from the right.
   */
  function parseShared(text: string): { name: string; size: number; kind: string } {
    const parts = text.split(/[|!]/);
    const kind = parts.pop() ?? '';
    const size = Number(parts.pop());
    return { name: parts.join('|'), size: Number.isFinite(size) ? size : 0, kind };
  }

  function sizeLabel(n: number): string {
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;
  }

  /** A shared picture goes up as an attachment; any other file (or a picture too big / unreadable) as a text line with no link, the hub download needs a session. */
  async function onFileShared(ev: BridgeEvent): Promise<void> {
    if (fromDiscord(ev)) return; // an attachment copied in from Discord already sits in its own channel
    if (channelsOf(deps.rooms, ev.room).every((c) => deps.state.byHubIn(ev.ref, c))) return;
    if (!(await mirrored(boardOf(ev.user)))) return;
    const { name, size, kind } = parseShared(ev.text);
    const base = { hubMessageId: ev.ref, room: ev.room, label: ev.label || ev.user };
    if (kind === 'image' && deps.fetchFile && size <= PICTURE_UPLOAD_MAX) {
      let data: Buffer | undefined;
      try {
        data = await deps.fetchFile(ev.ref);
      } catch (err) {
        (deps.log ?? console.log)(`[INFO] file ${ev.ref}: could not read the picture (${(err as Error).message}); posting a text line`);
      }
      if (data) return fanout.post({ ...base, text: name, attachment: { name: name || 'picture', data } });
    }
    await fanout.post({ ...base, text: `shared file ${name} (${sizeLabel(size)})` });
  }

  return async (ev) => {
    if (ev.type === 'discord_mirror') {
      cache = null;
      return;
    }
    if (ev.type === 'file_shared') {
      if (channelsOf(deps.rooms, ev.room).length === 0) return;
      return onFileShared(ev);
    }
    if (ev.type === 'file_deleted') {
      if (channelsOf(deps.rooms, ev.room).length === 0) return;
      await fanout.remove(ev.ref);
      deps.state.removeByHub(ev.ref);
      return;
    }
    if (ev.type !== 'message' && ev.type !== 'edit' && ev.type !== 'delete') return;
    if (channelsOf(deps.rooms, ev.room).length === 0) return;
    if (ev.type === 'message') return onMessage(ev);
    // The actor's board says nothing about the author's: a BBS sysop can edit or delete a Discord-origin
    // message. Webhook copies follow; the original in its own server is the author's and stays (the bot cannot edit it).
    const source = deps.state.linksOf(ev.ref).find((l) => l.source);
    if (ev.type === 'edit') {
      // Echo of inbound.ts's own edit: the hub text equals what the source row holds, copies already follow.
      if (fromDiscord(ev) && (!source || source.content === ev.text)) return;
      return fanout.edit(ev.ref, ev.text, ev.replyTo);
    }
    if (fromDiscord(ev) && !source) return; // nothing of ours left to delete
    await fanout.remove(ev.ref);
    deps.state.removeByHub(ev.ref); // the hub message is gone; so are the source row and any legacy rows
  };
}
