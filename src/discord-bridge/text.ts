/**
 * Pure text rules for the Discord side: hub -> Discord escaping (phase 3) and
 * Discord -> hub conversion to plain Latin-1 (phase 5).
 */

import { which as emojiName } from 'node-emoji';
import { toLatin1Safe } from '../text-format';

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
  return composeMessage(text, quote).content;
}

/** Discord's cap on allowed_mentions.users. */
export const MENTION_USERS_MAX = 100;

/** Webhook content plus the user ids it may ping (allowed_mentions.users). */
export interface ComposedMessage {
  content: string;
  users: string[];
}

/** Hub "@name" -> Discord user id, or undefined when the name is unknown or ambiguous. */
export type MentionResolver = (name: string) => string | undefined;

/**
 * `@name` in hub text, optionally suffixed `@discord` (the hub form of a
 * Discord user, `handle@DISCORD`). A name followed by any other `@board`
 * is a BBS caller and is never resolved against Discord.
 */
const HUB_MENTION = /(^|[^\w@.])@([\w.]*\w)(@[a-z0-9][a-z0-9-]*)?/gi;
const MARK_OPEN = '\uE000';
const MARK_CLOSE = '\uE001';

/**
 * Like composeContent, and turns each `@name` the resolver knows into a real
 * `<@id>` mention. Resolved names become private-use markers before escaping,
 * so the escape rules see the same text as before; the markers become `<@id>`
 * afterwards. Unresolved names stay literal text.
 */
export function composeMessage(text: string, quote?: ReplyQuote, resolve?: MentionResolver): ComposedMessage {
  const ids: string[] = [];
  let marked = text.replace(/[\uE000\uE001]/g, '');
  if (resolve) {
    marked = marked.replace(HUB_MENTION, (all, lead: string, name: string, board?: string) => {
      if (board && board.slice(1).toUpperCase() !== 'DISCORD') return all;
      const id = resolve(name);
      if (!id) return all;
      ids.push(id);
      return `${lead}${MARK_OPEN}${ids.length - 1}${MARK_CLOSE}`;
    });
  }
  const body = escapeDiscord(marked).replace(/\uE000(\d+)\uE001/g, (_m, n: string) => `<@${ids[Number(n)]}>`);
  const full = quote ? `${quoteLine(quote)}\n${body}` : body;
  const content = full.length > DISCORD_MESSAGE_LIMIT ? `${full.slice(0, DISCORD_MESSAGE_LIMIT - 3)}...` : full;
  const users = [...new Set(ids)].filter((id) => content.includes(`<@${id}>`)).slice(0, MENTION_USERS_MAX);
  return { content, users };
}

/** Names one Discord guild member answers to. */
export interface MemberNames {
  id: string;
  username: string;
  globalName?: string | null;
  nickname?: string | null;
}

/** Comparable form of a name: whitespace -> `_` (as inbound toHandle does), lower-case. */
export function mentionKey(name: string): string {
  return name.trim().replace(/\s+/g, '_').toLowerCase();
}

/**
 * The member a hub `@name` means: a unique username match first, else a
 * unique display name or nickname match. None or several: undefined, so the
 * name stays plain text and nobody is pinged by mistake.
 */
export function pickMember(members: Iterable<MemberNames>, name: string): string | undefined {
  const key = mentionKey(name);
  const byUsername = new Set<string>();
  const byDisplay = new Set<string>();
  for (const m of members) {
    if (mentionKey(m.username) === key) byUsername.add(m.id);
    else if ([m.globalName, m.nickname].some((n) => n && mentionKey(n) === key)) byDisplay.add(m.id);
  }
  if (byUsername.size) return byUsername.size === 1 ? [...byUsername][0] : undefined;
  return byDisplay.size === 1 ? [...byDisplay][0] : undefined;
}

/** Hub-side limit for Discord -> hub text (CHAT_LIMITS.contentMax). */
export const HUB_CONTENT_MAX = 500;

/** Names the gateway resolved for the ids a message mentions. */
export interface MentionNames {
  /** Discord user id -> hub handle (inbound.ts toHandle). */
  users?: Readonly<Record<string, string>>;
  roles?: Readonly<Record<string, string>>;
  channels?: Readonly<Record<string, string>>;
}

/**
 * Discord shortcode (node-emoji / GitHub names) -> the LiveChat door's
 * built-in code, so the doors draw their ASCII face for it. Source of the
 * door names: amiexpress-web board/Doors/livechat/utils/emojis.ts EMOJIS.
 * Names not listed here pass through as `:name:`.
 */
export const DOOR_EMOJI_ALIASES: Readonly<Record<string, string>> = {
  '+1': 'thumbsup',
  '-1': 'thumbsdown',
  grinning: 'grin',
  smiley: 'smile',
  slightly_smiling_face: 'smile',
  laughing: 'joy',
  rofl: 'joy',
  slightly_frowning_face: 'sad',
  frowning_face: 'sad',
  disappointed: 'sad',
  sob: 'cry',
  open_mouth: 'shock',
  astonished: 'shock',
  hushed: 'surprised',
  rage: 'angry',
  sunglasses: 'cool',
  stuck_out_tongue: 'tongue',
  stuck_out_tongue_winking_eye: 'tongue',
  kissing_heart: 'kiss',
  kissing: 'kiss',
  neutral_face: 'neutral',
  smiling_imp: 'evil',
  innocent: 'angel',
  hugs: 'hug',
  person_shrugging: 'shrug',
  man_shrugging: 'shrug',
  woman_shrugging: 'shrug',
  person_facepalming: 'facepalm',
  man_facepalming: 'facepalm',
  woman_facepalming: 'facepalm',
  dancer: 'dance',
  man_dancing: 'dance',
  runner: 'run',
  running_man: 'run',
  white_check_mark: 'check',
  heavy_check_mark: 'check',
  negative_squared_cross_mark: 'x',
  musical_note: 'music',
  notes: 'music',
  zap: 'lightning',
  gem: 'diamond',
  arrow_right: 'arrow',
  red_heart: 'heart',
};

/** Typographic characters Discord clients insert, folded to ASCII. */
const PUNCTUATION: Readonly<Record<string, string>> = {
  '‘': "'", '’': "'", '‚': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '…': '...', '•': '*', '™': 'TM', '€': 'EUR',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '​': '', '‌': '', '‍': '', '⁠': '', '﻿': '',
};

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * One grapheme above Latin-1 to Latin-1 text: an emoji to its `:name:`
 * (door alias first), typographic punctuation to ASCII, a letter with a
 * diacritic outside Latin-1 to its base letter. Anything else becomes `?`
 * in the final toLatin1Safe step.
 */
function foldGrapheme(g: string): string {
  if ([...g].every((c) => (c.codePointAt(0) ?? 0) <= 0xff)) return g;
  const punct = PUNCTUATION[g];
  if (punct !== undefined) return punct;
  const name = emojiName(g);
  if (name) return `:${DOOR_EMOJI_ALIASES[name] ?? name}:`;
  const base = g.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if ([...base].every((c) => (c.codePointAt(0) ?? 0) <= 0xff)) return base.normalize('NFC');
  return g;
}

const MARKDOWN_CHARS = /\\([\\*_~`|<>[\]()#>:-])/g;

/** `<t:unix[:style]>` as `YYYY-MM-DD HH:MM UTC`. */
function timestamp(unix: string): string {
  const d = new Date(Number(unix) * 1000);
  if (Number.isNaN(d.getTime())) return unix;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Discord message text to the hub's plain Latin-1 line: code fences and
 * inline code keep their text; mentions become `@handle`, `@role`,
 * `#channel`; custom emoji `<:x:id>` become `:x:`; markdown marks are
 * removed (masked links become `text (url)`, spoilers `[spoiler: x]`);
 * unicode emoji become `:name:`; line breaks become spaces; attachment URLs
 * are appended. The result is Latin-1 safe and capped at HUB_CONTENT_MAX.
 */
export function discordToHub(content: string, attachmentUrls: readonly string[] = [], names: MentionNames = {}): string {
  const kept: string[] = [];
  const keep = (text: string): string => `${kept.push(text) - 1}`;

  let t = content.normalize('NFC');
  // Code first: nothing inside a code span is markdown or a mention.
  t = t.replace(/```(?:[\w+-]*\n)?([\s\S]*?)```/g, (_m, code: string) => keep(code.trim()));
  t = t.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _f, code: string) => keep(code.trim()));
  // Discord tokens.
  t = t.replace(/<@!?(\d+)>/g, (_m, id: string) => keep(`@${names.users?.[id] ?? 'unknown'}`));
  t = t.replace(/<@&(\d+)>/g, (_m, id: string) => keep(`@${names.roles?.[id] ?? 'role'}`));
  t = t.replace(/<#(\d+)>/g, (_m, id: string) => keep(`#${names.channels?.[id] ?? 'channel'}`));
  t = t.replace(/<a?:(\w+):\d+>/g, (_m, name: string) => keep(`:${name}:`));
  t = t.replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_m, unix: string) => keep(timestamp(unix)));
  t = t.replace(/<\/([\w -]+):\d+>/g, (_m, cmd: string) => keep(`/${cmd}`));
  // Links: masked, embed-suppressed, bare. URLs are kept whole (underscores are not italics).
  t = t.replace(/\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)/g, (_m, label: string, url: string) =>
    label === url ? keep(url) : `${label} (${keep(url)})`);
  t = t.replace(/<(https?:\/\/[^\s>]+)>/g, (_m, url: string) => keep(url));
  t = t.replace(/https?:\/\/[^\s<]+[^\s<.,:;"')\]!?]/g, (url) => keep(url));
  // Block marks at line start: headings, subtext, quotes.
  t = t.replace(/^(?:#{1,3}|-#)\s+/gm, '').replace(/^>>>\s?/gm, '').replace(/^>\s?/gm, '');
  // Inline marks, outermost first.
  t = t.replace(/\|\|([\s\S]+?)\|\|/g, '[spoiler: $1]');
  t = t.replace(/\*\*\*([\s\S]+?)\*\*\*/g, '$1').replace(/\*\*([\s\S]+?)\*\*/g, '$1').replace(/__([\s\S]+?)__/g, '$1');
  t = t.replace(/~~([\s\S]+?)~~/g, '$1');
  t = t.replace(/(^|[^\\*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2');
  t = t.replace(/(^|[^\\\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2');
  t = t.replace(MARKDOWN_CHARS, '$1');
  t = t.replace(/(\d+)/g, (_m, i: string) => kept[Number(i)] ?? '');
  // One line.
  t = t.replace(/\s*[\r\n]+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  t = Array.from(graphemes.segment(t), (s) => foldGrapheme(s.segment)).join('');

  const joined = [t, ...attachmentUrls].filter((p) => p.length > 0).join(' ');
  const safe = toLatin1Safe(joined);
  return safe.length > HUB_CONTENT_MAX ? `${safe.slice(0, HUB_CONTENT_MAX - 3)}...` : safe;
}
