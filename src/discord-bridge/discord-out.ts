/**
 * The bridge's Discord output: channel webhooks through discord.js REST
 * (which owns rate limits and 429 retries). Behind an interface so the
 * handler is tested against a fake; the REST implementation is tested
 * against a local HTTP server through REST's `api` option.
 */
import { REST, Routes } from 'discord.js';

export const WEBHOOK_NAME = 'LiveChat bridge';

/** Message text plus the Discord user ids it may ping (none when empty). */
export interface WebhookBody {
  content: string;
  users?: readonly string[];
}

export interface WebhookPost extends WebhookBody {
  username: string;
}

export interface DiscordOut {
  /** Find or create the bridge-owned webhook of each channel. */
  prepare(channelIds: Iterable<string>): Promise<void>;
  /** Execute the channel webhook; returns the Discord message id. */
  post(channelId: string, post: WebhookPost): Promise<string>;
  edit(channelId: string, messageId: string, body: WebhookBody): Promise<void>;
  remove(channelId: string, messageId: string): Promise<void>;
  /** https://discord.com/channels/<guild>/<channel>/<message>, once the channel is prepared. */
  jumpLink(channelId: string, messageId: string): string | undefined;
}

interface WebhookRec {
  id: string;
  token?: string;
  name?: string;
  guild_id?: string;
}
interface Target {
  id: string;
  token: string;
  guildId: string | undefined;
}

/** Never @everyone, @here or roles; users only when the bridge resolved them. */
function allowedMentions(users: readonly string[] | undefined): { parse: string[]; users?: string[] } {
  return users && users.length ? { parse: [], users: [...users] } : { parse: [] };
}

export class RestDiscordOut implements DiscordOut {
  private readonly targets = new Map<string, Target>();

  constructor(private readonly rest: REST) {}

  static fromToken(token: string, api?: string): RestDiscordOut {
    return new RestDiscordOut(new REST({ version: '10', ...(api ? { api } : {}) }).setToken(token));
  }

  async prepare(channelIds: Iterable<string>): Promise<void> {
    for (const channel of channelIds) {
      const existing = ((await this.rest.get(Routes.channelWebhooks(channel))) as WebhookRec[]).find((w) => w.name === WEBHOOK_NAME && w.token);
      const hook = existing ?? ((await this.rest.post(Routes.channelWebhooks(channel), { body: { name: WEBHOOK_NAME } })) as WebhookRec);
      if (!hook.token) throw new Error(`webhook ${hook.id} of channel ${channel} has no token`);
      this.targets.set(channel, { id: hook.id, token: hook.token, guildId: hook.guild_id });
    }
  }

  /** Stop REST's sweeper timers so the process (and a test run) can exit. */
  close(): void {
    this.rest.clearHashSweeper();
    this.rest.clearHandlerSweeper();
  }

  private target(channel: string): Target {
    const t = this.targets.get(channel);
    if (!t) throw new Error(`channel ${channel} has no prepared webhook`);
    return t;
  }

  async post(channelId: string, post: WebhookPost): Promise<string> {
    const t = this.target(channelId);
    const sent = (await this.rest.post(Routes.webhook(t.id, t.token), {
      auth: false,
      query: new URLSearchParams({ wait: 'true' }),
      body: { username: post.username, content: post.content, allowed_mentions: allowedMentions(post.users) },
    })) as { id: string };
    return sent.id;
  }

  async edit(channelId: string, messageId: string, body: WebhookBody): Promise<void> {
    const t = this.target(channelId);
    await this.rest.patch(Routes.webhookMessage(t.id, t.token, messageId), {
      auth: false,
      body: { content: body.content, allowed_mentions: allowedMentions(body.users) },
    });
  }

  async remove(channelId: string, messageId: string): Promise<void> {
    const t = this.target(channelId);
    await this.rest.delete(Routes.webhookMessage(t.id, t.token, messageId), { auth: false });
  }

  jumpLink(channelId: string, messageId: string): string | undefined {
    const g = this.targets.get(channelId)?.guildId;
    return g ? `https://discord.com/channels/${g}/${channelId}/${messageId}` : undefined;
  }
}
