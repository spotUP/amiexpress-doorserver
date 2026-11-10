/**
 * Discord -> hub: gateway events in mapped channels become relay posts
 * (`as=<handle>`, author `<handle>@DISCORD`). The gateway sits behind
 * DiscordIn so tests inject events; GatewayDiscordIn is the discord.js client.
 * A hub refusal (ban, mute, room mode) is logged and dropped, never retried.
 */
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { Message, PartialMessage } from 'discord.js';
import { validHandle } from '../chat/sessions';
import { CHAT_LIMITS } from '../../contract/chat-types';
import { HubError } from './hub-client';
import type { HubClient } from './hub-client';
import { discordToHub, pickMember, type MentionNames } from './text';
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
  /** The same attachments with the metadata the file copy needs. */
  attachments?: { id: string; name: string; size: number; url: string }[];
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
  hub: Pick<HubClient, 'postAs' | 'editAs' | 'deleteAs' | 'uploadFileAs'>;
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

  /** Download one attachment and store it in the hub as `handle`. Never throws: the message text is already posted. */
  async function copyAttachment(room: string, handle: string, a: { id: string; name: string; size: number; url: string }): Promise<void> {
    if (a.size > CHAT_LIMITS.fileMaxBytes) return;
    try {
      const res = await fetch(a.url);
      if (!res.ok) return log(`[ERROR] attachment ${a.id}: download ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length === 0 || data.length > CHAT_LIMITS.fileMaxBytes) return;
      await deps.hub.uploadFileAs(room, handle, a.name, data, a.id.slice(0, 64));
    } catch (err) {
      if (err instanceof HubError && err.status >= 400 && err.status < 500) return log(`[INFO] hub refused attachment ${a.id}: ${err.message}`);
      log(`[ERROR] attachment ${a.id}: ${(err as Error).message}`);
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
      // Discord CDN links expire; keep a copy in the hub file store. After the text so it reads first.
      for (const a of m.attachments ?? []) await copyAttachment(room, handle, a);
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
  attachments: [...(m.attachments?.values() ?? [])].map((a) => ({ id: a.id, name: a.name ?? 'file', size: a.size, url: a.url })),
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

/**
 * The real gateway: Guilds, GuildMessages, MessageContent, GuildMembers.
 * GuildMembers (privileged: "Server Members Intent" in the developer portal)
 * keeps the member cache whole, so hub `@name` can ping any server member.
 */
export class GatewayDiscordIn implements DiscordIn {
  private readonly client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
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
    // Load every member once; the GuildMembers intent keeps the cache current after that.
    this.client.on('clientReady', (c) => {
      for (const g of c.guilds.cache.values()) {
        g.members.fetch().then(
          (all) => this.log(`[OK] guild ${g.id}: ${all.size} member(s) cached for mentions`),
          swallow(`members of guild ${g.id}`),
        );
      }
    });
    await this.client.login(this.token);
  }

  /** The member of the channel's guild a hub `@name` means (text.ts pickMember); undefined when unknown or ambiguous. */
  memberId(channelId: string, name: string): string | undefined {
    const ch = this.client.channels.cache.get(channelId);
    const guild = ch && 'guild' in ch ? ch.guild : undefined;
    if (!guild) return undefined;
    return pickMember(
      [...guild.members.cache.values()].map((m) => ({ id: m.id, username: m.user.username, globalName: m.user.globalName, nickname: m.nickname })),
      name,
    );
  }

  /** True once the gateway session is up (discord.js resumes on its own after drops). */
  get ready(): boolean {
    return this.client.isReady();
  }

  async close(): Promise<void> {
    await this.client.destroy();
  }
}
