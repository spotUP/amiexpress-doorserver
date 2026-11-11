/**
 * Hub -> Discord: turns hub events into webhook calls. Message events are
 * posted under the author's display label, edits and deletes find their
 * twin through the id map, replies carry one quote line (webhooks cannot
 * send message_reference).
 */
import { CHAT_DISCORD_BOARD } from '../../contract/chat-types';
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

export interface OutboundDeps {
  /** Hub room id -> Discord channel id. */
  rooms: ReadonlyMap<string, string>;
  state: BridgeState;
  out: DiscordOut;
  /** GET /discord/boards.txt */
  fetchBoards: () => Promise<MirrorBoards>;
  /** Discord channel id + hub `@name` -> Discord user id (gateway member cache). Absent: no pings. */
  resolveMention?: (channelId: string, name: string) => string | undefined;
  log?: (line: string) => void;
  now?: () => number;
}

/** The part of `user` after the last `@`, upper-cased; '' when there is none. */
export function boardOf(user: string): string {
  const at = user.lastIndexOf('@');
  return at < 0 ? '' : user.slice(at + 1).toUpperCase();
}

export function createOutbound(deps: OutboundDeps): (ev: BridgeEvent) => Promise<void> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? Date.now;
  let cache: (MirrorBoards & { at: number }) | null = null;

  /** D5: cached by rev, refreshed on a discord_mirror event or after 60 s. */
  async function mirrored(board: string): Promise<boolean> {
    if (!cache || now() - cache.at >= BOARDS_MAX_AGE_MS) cache = { ...(await deps.fetchBoards()), at: now() };
    return cache.boards.has(board);
  }

  function resolverFor(channel: string): MentionResolver | undefined {
    const r = deps.resolveMention;
    return r ? (name) => r(channel, name) : undefined;
  }

  function quoteOf(ev: BridgeEvent, channel: string): ReplyQuote | undefined {
    if (!ev.replyTo) return undefined;
    const parent = deps.state.byHub(ev.replyTo);
    if (parent && parent.content !== undefined) {
      return { label: parent.authorLabel || '?', text: parent.content, link: deps.out.jumpLink(channel, parent.discordMessageId) };
    }
    log(`[INFO] reply ${ev.ref}: parent ${ev.replyTo} has no twin; posting without a quote`);
    return undefined;
  }

  async function onMessage(ev: BridgeEvent, channel: string): Promise<void> {
    const board = boardOf(ev.user);
    if (board === CHAT_DISCORD_BOARD.toUpperCase()) return; // loop guard
    if (deps.state.byHub(ev.ref)) return; // replayed after a restart: already posted
    if (!(await mirrored(board))) return;
    const label = ev.label || ev.user;
    const quote = quoteOf(ev, channel);
    const id = await deps.out.post(channel, { username: webhookName(label), ...composeMessage(ev.text, quote, resolverFor(channel)) });
    deps.state.putLink({ hubMessageId: ev.ref, discordMessageId: id, roomId: ev.room, createdAt: now(), authorLabel: label, content: ev.text });
  }

  async function onEdit(ev: BridgeEvent, channel: string): Promise<void> {
    if (boardOf(ev.user) === CHAT_DISCORD_BOARD.toUpperCase()) return; // echo guard: the edit came from Discord
    const link = deps.state.byHub(ev.ref);
    if (!link) return log(`[INFO] edit ${ev.ref}: no Discord twin, skipped`);
    await deps.out.edit(channel, link.discordMessageId, composeMessage(ev.text, quoteOf(ev, channel), resolverFor(channel)));
    deps.state.setContent(ev.ref, ev.text);
  }

  async function onDelete(ev: BridgeEvent, channel: string): Promise<void> {
    if (boardOf(ev.user) === CHAT_DISCORD_BOARD.toUpperCase()) return; // echo guard: the delete came from Discord
    const link = deps.state.byHub(ev.ref);
    if (!link) return log(`[INFO] delete ${ev.ref}: no Discord twin, skipped`);
    await deps.out.remove(channel, link.discordMessageId);
    deps.state.removeByHub(ev.ref);
  }

  return async (ev) => {
    if (ev.type === 'discord_mirror') {
      cache = null;
      return;
    }
    if (ev.type !== 'message' && ev.type !== 'edit' && ev.type !== 'delete') return;
    const channel = deps.rooms.get(ev.room);
    if (!channel) return;
    if (ev.type === 'message') return onMessage(ev, channel);
    if (ev.type === 'edit') return onEdit(ev, channel);
    return onDelete(ev, channel);
  };
}
