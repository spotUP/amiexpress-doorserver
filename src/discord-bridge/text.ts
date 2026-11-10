/**
 * Pure text rules for the Discord side. Hub -> Discord (phase 3) lives here;
 * phase 5 adds Discord -> hub conversion to this module.
 */

const ZWSP = '​';
export const DISCORD_MESSAGE_LIMIT = 2000;
export const DISCORD_NAME_LIMIT = 80;
export const QUOTE_EXCERPT = 80;

/**
 * Make hub text literal in Discord: backslash-escape markdown, break up
 * mention syntax (`<@id>`, `<#id>`, `<:emoji:id>`, @everyone, @here). The
 * webhook also sends allowed_mentions none; this keeps the text from
 * rendering as a mention at all.
 */
export function escapeDiscord(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([*_~`|<>[\]()])/g, '\\$1')
    .replace(/@(everyone|here)/gi, `@${ZWSP}$1`)
    .replace(/^(\s*)([#+-])(?=\s)/gm, '$1\\$2')
    .replace(/^(\s*\d+)\.(?=\s)/gm, '$1\\.');
}

/**
 * Discord rejects webhook usernames that contain "discord" or "clyde" and
 * limits them to 80 characters. A zero-width space after the first letter
 * keeps the name readable and accepted.
 */
export function webhookName(label: string): string {
  const cleaned = label.replace(/(d)(iscord)|(c)(lyde)/gi, (_m, a?: string, b?: string, c?: string, d?: string) => `${a ?? c}${ZWSP}${b ?? d}`);
  const name = cleaned.trim().slice(0, DISCORD_NAME_LIMIT);
  return name || 'unknown';
}

export interface ReplyQuote {
  label: string;
  text: string;
  /** Jump link to the parent's Discord twin, when it has one. */
  link?: string;
}

/** One quote line for a reply: webhooks cannot carry message_reference. */
export function quoteLine(q: ReplyQuote): string {
  const flat = q.text.replace(/\s+/g, ' ').trim();
  const excerpt = flat.length > QUOTE_EXCERPT ? `${flat.slice(0, QUOTE_EXCERPT)}...` : flat;
  const link = q.link ? ` ([jump](${q.link}))` : '';
  return `> ${escapeDiscord(q.label)}: ${escapeDiscord(excerpt)}${link}`;
}

/** Final webhook content: optional quote line, then the escaped text, capped at Discord's limit. */
export function composeContent(text: string, quote?: ReplyQuote): string {
  const body = escapeDiscord(text);
  const full = quote ? `${quoteLine(quote)}\n${body}` : body;
  return full.length > DISCORD_MESSAGE_LIMIT ? `${full.slice(0, DISCORD_MESSAGE_LIMIT - 3)}...` : full;
}
