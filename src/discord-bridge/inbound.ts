/**
 * Discord -> hub: gateway events in mapped channels become relay posts
 * (`as=<handle>`, author `<handle>@DISCORD`). The gateway sits behind
 * DiscordIn so tests inject events; GatewayDiscordIn is the discord.js client.
 * A hub refusal (ban, mute, room mode) is logged and dropped, never retried.
 */
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { Message, PartialMessage } from 'discord.js';
import { validHandle } from '../chat/sessions';
import { HubError } from './hub-client';
import type { HubClient } from './hub-client';
import { discordToHub, type MentionNames } from './text';
import type { BridgeState } from './state';

export interface InboundMessage {
  id: string;
  channelId: string;
  /** Discord username of the author. */
  authorName: string;
  authorId: string;
  authorBot: boolean;
  /** Set on webhook posts, including the bridge's own. */
  webhookId?: string | null;
  content: string;
  attachmentUrls: string[];
  /** Id of the Discord message this one replies to. */
  referenceId?: string | null;
  /** Names for the user, role and channel ids the content mentions. */
  mentions?: MentionNames;
}

export interface InboundUpdate extends InboundMessage {
  /** False when the gateway sent an update without content (embed unfurl, uncached). */
  contentChanged: boolean;
}

export interface InboundSink {
  create(m: InboundMessage): Promise<void>;
  update(m: InboundUpdate): Promise<void>;
  remove(m: { id: string; channelId: string }): Promise<void>;
}

export interface DiscordIn {
  start(sink: InboundSink): Promise<void>;
  close(): Promise<void>;
}

/** Longest handle the hub accepts (sessions.ts HANDLE). */
const HANDLE_MAX = 32;

/**
 * A hub handle from a Discord username: whitespace to `_`, `@` and `|`
 * dropped, then the hub's own validHandle decides; failing that (empty,
 * too long after cleaning is cut) `user<last 4 of the id>`.
 */
export function toHandle(username: string, authorId: string): string {
  const cleaned = username.trim().replace(/\s+/g, '_').replace(/[@|]/g, '').slice(0, HANDLE_MAX);
  return validHandle(cleaned) ? cleaned : `user${authorId.slice(-4)}`;
}

export interface InboundDeps {
  rooms: ReadonlyMap<string, string>;
  hub: Pick<HubClient, 'postAs' | 'editAs' | 'deleteAs'>;
  state: BridgeState;
  log?: (line: string) => void;
  now?: () => number;
}

export function createInbound(deps: InboundDeps): InboundSink {
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = deps.now ?? Date.now;
  const roomOf = new Map([...deps.rooms].map(([room, channel]) => [channel, room]));

  /** Mapped channel, not a webhook post (the bridge's own), not a bot. */
  const accepted = (m: InboundMessage): string | null => {
    const room = roomOf.get(m.channelId);
    if (!room || m.webhookId || m.authorBot) return null;
    return room;
  };

  /** Hub refusals are final; anything else (network, 5xx) propagates to the gateway handler's log. */
  async function guarded(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (err instanceof HubError && err.status >= 400 && err.status < 500) return log(`[INFO] hub refused ${what}: ${err.message}`);
      log(`[ERROR] ${what}: ${(err as Error).message}`);
    }
  }

  return {
    async create(m) {
      const room = accepted(m);
      if (!room || deps.state.byDiscord(m.id)) return;
      const text = discordToHub(m.content, m.attachmentUrls, m.mentions);
      if (!text) return;
      const handle = toHandle(m.authorName, m.authorId);
      let replyTo: string | undefined;
      if (m.referenceId) {
        replyTo = deps.state.byDiscord(m.referenceId)?.hubMessageId;
        if (!replyTo) log(`[INFO] reply ${m.id}: parent ${m.referenceId} has no twin; posting without reply_to`);
      }
      await guarded(`post ${m.id}`, async () => {
        const hubId = await deps.hub.postAs(room, handle, text, `discord:${m.id}`.slice(0, 64), replyTo);
        deps.state.putLink({ hubMessageId: hubId, discordMessageId: m.id, roomId: room, createdAt: now(), authorLabel: handle, content: text });
      });
    },
    async update(m) {
      if (!accepted(m) || !m.contentChanged) return;
      const link = deps.state.byDiscord(m.id);
      if (!link) return log(`[INFO] edit ${m.id}: no hub twin, skipped`);
      const text = discordToHub(m.content, m.attachmentUrls, m.mentions);
      if (!text) return;
      await guarded(`edit ${m.id}`, async () => {
        await deps.hub.editAs(link.hubMessageId, toHandle(m.authorName, m.authorId), text);
        deps.state.setContent(link.hubMessageId, text);
      });
    },
    async remove(m) {
      if (!roomOf.has(m.channelId)) return;
      const link = deps.state.byDiscord(m.id);
      if (!link) return log(`[INFO] delete ${m.id}: no hub twin, skipped`);
      const as = link.authorLabel ?? '';
      await guarded(`delete ${m.id}`, async () => {
        await deps.hub.deleteAs(link.hubMessageId, as);
        deps.state.removeByHub(link.hubMessageId);
      });
    },
  };
}

const toInbound = (m: Message | PartialMessage): InboundMessage => ({
  id: m.id,
  channelId: m.channelId,
  authorName: m.author?.username ?? '',
  authorId: m.author?.id ?? m.id,
  authorBot: m.author?.bot ?? false,
  webhookId: m.webhookId,
  content: m.content ?? '',
  attachmentUrls: [...(m.attachments?.values() ?? [])].map((a) => a.url),
  referenceId: m.reference?.messageId,
  mentions: mentionNames(m),
});

/** Hub names for what the message mentions: users as hub handles, roles and channels by name. */
function mentionNames(m: Message | PartialMessage): MentionNames {
  const users: Record<string, string> = {};
  const roles: Record<string, string> = {};
  const channels: Record<string, string> = {};
  for (const u of m.mentions?.users?.values() ?? []) users[u.id] = toHandle(u.username, u.id);
  for (const r of m.mentions?.roles?.values() ?? []) roles[r.id] = r.name;
  for (const c of m.mentions?.channels?.values() ?? []) if ('name' in c && typeof c.name === 'string') channels[c.id] = c.name;
  return { users, roles, channels };
}

/** The real gateway: Guilds, GuildMessages, MessageContent. */
export class GatewayDiscordIn implements DiscordIn {
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel],
  });

  constructor(private readonly token: string, private readonly log: (line: string) => void = (l) => console.log(l)) {}

  async start(sink: InboundSink): Promise<void> {
    const swallow = (what: string) => (err: unknown): void => this.log(`[ERROR] gateway ${what}: ${(err as Error).message}`);
    this.client.on('messageCreate', (m) => void sink.create(toInbound(m)).catch(swallow('create')));
    this.client.on('messageUpdate', (oldM, newM) => {
      const changed = newM.content !== null && newM.content !== oldM.content;
      void sink.update({ ...toInbound(newM), contentChanged: changed }).catch(swallow('update'));
    });
    this.client.on('messageDelete', (m) => void sink.remove({ id: m.id, channelId: m.channelId }).catch(swallow('delete')));
    await this.client.login(this.token);
  }

  async close(): Promise<void> {
    await this.client.destroy();
  }
}
