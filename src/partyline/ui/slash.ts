/**
 * Partyline hub engine: the "/" command menu, ported 1:1 from amiexpress-web
 * sdk/c/examples/livechat/livechat_ui.c (lc_cmd_help, lc_slash_match/row/ghost/exact/complete/scroll, draw_slash).
 * CMD_HELP is also the command table commands.ts dispatches from.
 */
import { Cells, DEFAULT } from './cells';
import { Model, FOCUS_INPUT } from './model';
import type { DrawState } from './draw';
import { cover, MODAL_NONE, OverlayState } from './overlays';

/** name, aliases (comma-separated), description, usage: the C lc_cmd_help (the TS door's command registry). */
export const CMD_HELP: ReadonlyArray<readonly [string, string, string, string]> = [
  ['ban', '', 'Ban user from channel', '/ban @user [reason]'],
  ['clear', 'cls', 'Clear chat display', '/clear'],
  ['create', '', 'Create a new channel. --private and --invite-only make it members-only.', '/create #name [topic] [--private] [--invite-only] [--motd "text"]'],
  ['deletemsg', 'delmsg', 'Delete a message (your last by default)', '/deletemsg [msg-id]'],
  ['edit', '', 'Edit one of your messages (your last by default)', '/edit [msg-id] new text'],
  ['away', 'afk', 'Set away status', '/away [message]'],
  ['back', '', 'Return from away', '/back'],
  ['help', '?,commands', 'Show available commands', '/help [command]'],
  ['ignore', '', 'Ignore a user (no name: list who you ignore)', '/ignore [user]'],
  ['invite', '', 'Invite a user to this invite-only channel (moderator only)', '/invite @user [#room]'],
  ['join', '', 'Join a channel', '/join #channel'],
  ['kick', '', 'Kick user from channel', '/kick @user [reason]'],
  ['leave', 'part', 'Leave current channel', '/leave'],
  ['love', '', 'React with heart', '/love [msg-id]'],
  ['nick', '', 'Show your username', '/nick'],
  ['msg', 'dm,pm', 'Send a direct message (1:1 or group). /msg @a [@b ...] text', '/msg @user [@user2 ...] message'],
  ['mute', '', 'Mute user in channel', '/mute @user [minutes]'],
  ['op', '', 'Give or take room operator status (sysop)', '/op @user  |  /op -@user  |  /deop @user'],
  ['quit', 'exit,bye,q', 'Exit chat', '/quit'],
  ['react', '+1,-1,heart,fire', 'Add reaction to message', '/react [emoji] [msg-id]'],
  ['reactions', '', 'Show reactions', '/reactions [msg-id]'],
  ['reply', 'r', 'Reply to a message (the newest by default)', '/reply [msg-id] message'],
  ['rooms', 'channels', 'List all rooms', '/rooms'],
  ['status', '', 'Set custom status', '/status [online|away|busy|dnd] [message]'],
  ['thread', 't', 'Reply in thread', '/thread <msg-id> message'],
  ['thumbsup', 'like', 'React with thumbs up', '/thumbsup [msg-id]'],
  ['topic', '', 'Set channel topic', '/topic <new topic>'],
  ['unignore', '', 'Stop ignoring a user', '/unignore <user>'],
  ['unban', '', 'Unban user from channel', '/unban @user'],
  ['uninvite', '', 'Revoke a pending invite', '/uninvite @user [#room]'],
  ['unmute', '', 'Unmute user in channel', '/unmute @user'],
  ['unreact', '', 'Remove reaction', '/unreact [emoji] [msg-id]'],
  ['whois', 'info', 'Show user info', '/whois @user'],
  ['who', 'users,list', 'List users in channel', '/who'],
  ['compact', '', 'Toggle compact mode', '/compact'],
  ['timestamps', 'time', 'Toggle timestamps', '/timestamps'],
  ['delete', '', 'Delete a channel', '/delete #channel'],
  ['emoji', '', 'Open emoji picker or search emojis', '/emoji [search]'],
  ['emojis', '', 'List all emojis or emojis in a category', '/emojis [category]'],
  ['customemoji', '', "Add, remove or list the board's custom emoji (sysop adds)", '/customemoji add <name> <display> <ascii> | remove <name> | list'],
  ['events', '', 'Manage BBS event display preferences', '/events [on|off|logins|files|doors|messages|announcements]'],
  ['mic', '', 'List microphones, or switch to one', '/mic [number]'],
  ['discord', '', "Show or switch the Discord mirror of this board's chat (sysop switches)", '/discord [on|off]'],
  ['motd', '', 'Set channel MOTD (moderator only; --clear to clear; no args = show current)', '/motd [text]  (use /motd --clear to clear)'],
  ['mode', '', 'Set channel or user modes (+i/+m/+o/+v/-X). Moderator only.', '/mode <modes> [param]'],
  ['me', '', 'Send an action message', '/me does something'],
  ['pin', '', 'Pin a message', '/pin <msg-id>'],
  ['unpin', '', 'Unpin a message', '/unpin <msg-id>'],
  ['pinned', 'pins', 'Show pinned messages', '/pinned'],
  ['sounds', '', 'Toggle sound notifications', '/sounds [on|off]'],
  ['search', 'find', 'Search messages', '/search [query]'],
  ['draw', 'whiteboard,art', 'Open the drawing whiteboard (or join art:<name>)', '/draw [channel]'],
  ['files', 'file,share', 'Open the file sharing browser', '/files'],
  ['upload', '', 'Share a picture from your computer in this room', '/upload'],
  ['view', 'picture', 'Preview a shared picture', '/view <number>'],
  ['settings', '', 'Open the settings', '/settings'],
  ['voice', 'vc', 'Voice channel commands', '/voice [join <channel> | leave]'],
  ['deafen', 'deaf', 'Deafen (mute audio output)', '/deafen'],
  ['undeafen', 'undeaf', 'Undeafen (unmute audio output)', '/undeafen'],
];

export const SLASH_MAX = 64, SLASH_ROWS = 8;

/** The C lower(): ASCII only, so a latin1 byte compares as itself. */
const lower = (s: string): string => s.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));

/** lc_slash_match: the commands for "/term", prefix matches first then description matches, each by name. */
export function slashMatch(input: string): number[] {
  if (input[0] !== '/') return [];
  const term = lower(input.slice(1)), idx: number[] = [], pre: number[] = [];
  for (let i = 0; i < CMD_HELP.length && idx.length < SLASH_MAX; i++) {
    const name = CMD_HELP[i][0], key = lower(name).startsWith(term) ? 1 : 0;
    if (!key && !lower(CMD_HELP[i][2]).includes(term)) continue;
    let j = idx.length;
    for (; j > 0; j--) {
      const o = CMD_HELP[idx[j - 1]][0];
      if (pre[j - 1] > key || (pre[j - 1] === key && o < name)) break;
      idx[j] = idx[j - 1]; pre[j] = pre[j - 1];
    }
    idx[j] = i; pre[j] = key;
  }
  return idx;
}

/** lc_slash_row: one menu row; at 80+ cols name, usage (ucol/ulen, drawn dim) and description columns. */
export function slashRow(cmd: number, cols: number): { text: string; ucol: number; ulen: number } {
  const [name, , desc, usage] = CMD_HELP[cmd];
  if (cols < 80) {
    const room = Math.min(Math.max(8, cols - 4), 199);
    return { text: (desc !== '' ? `/${name} ${desc}` : `/${name}`).slice(0, room), ucol: 0, ulen: 0 };
  }
  const dw = Math.max(10, cols - 12 - 20 - 6), head = `/${name.slice(0, 12).padEnd(12)} `;
  const mid = `${usage.slice(0, 20).padEnd(20)} `;
  return { text: head + mid + desc.slice(0, Math.min(dw, 200 - head.length - mid.length - 1)), ucol: head.length, ulen: 20 };
}

/** lc_slash_ghost: the top match when its name starts with the whole typed term, else -1. */
export function slashGhost(input: string, idx: readonly number[]): number {
  const term = lower(input.slice(1));
  if (idx.length === 0 || input[0] !== '/' || term === '') return -1;
  return lower(CMD_HELP[idx[0]][0]).startsWith(term) ? idx[0] : -1;
}

/** slash_is: input, trimmed of spaces, is exactly "/" + word (case ignored). */
function slashIs(input: string, word: string): boolean {
  const s = input.replace(/^ +/, '').replace(/ +$/, '');
  return s[0] === '/' && lower(s.slice(1)) === lower(word);
}

export function slashExact(input: string, cmd: number): boolean { return slashIs(input, CMD_HELP[cmd][0]); }

/** lc_slash_complete: the input names a command or one of its aliases, with nothing after it. */
export function slashComplete(input: string): boolean {
  return CMD_HELP.some(([name, aliases]) => slashIs(input, name) || aliases.split(',').some((a) => a !== '' && slashIs(input, a)));
}

export function slashScroll(sel: number, top: number, n: number): number {
  if (sel < top) top = sel;
  if (sel >= top + SLASH_ROWS) top = sel - SLASH_ROWS + 1;
  if (top > n - SLASH_ROWS) top = n - SLASH_ROWS;
  return top < 0 ? 0 : top;
}

/** draw_slash: the matches above the input box while a "/" is typed. */
export function drawSlash(c: Cells, m: Model, d: DrawState, o: OverlayState): void {
  if (o.slashOff || o.fmt || m.focus !== FOCUS_INPUT || o.modal !== MODAL_NONE) return;
  const idx = slashMatch(m.input), n = idx.length, W = c.cols, brow = c.rows - 4, p = m.pal;
  if (n === 0) return;
  const rows = Math.min(n, SLASH_ROWS), top = slashScroll(o.slashSel < n ? o.slashSel : n - 1, o.slashTop, n);
  if (brow - rows - 2 < 1) return;
  c.pen(p.ink, DEFAULT, 0);
  c.fill(brow - rows - 1, 1, rows, W - 2, 0x20);
  c.box(brow - rows - 2, 0, rows + 2, W, p.accent, ' Commands ', p.ink);
  cover(d, brow - rows - 2, 0, rows + 2, W);
  for (let i = 0; i < rows; i++) {
    const r = brow - rows - 1 + i, sel = top + i === o.slashSel, { text, ucol, ulen } = slashRow(idx[top + i], W);
    c.pen(sel ? p.accent : p.ink, DEFAULT, 0);
    c.text(r, 1, sel ? '> ' : '  ', 2);
    c.text(r, 3, text, W - 4);
    if (ulen > 0) {
      c.pen(p.dim, DEFAULT, 0);
      if (ucol < W - 4) c.text(r, 3 + ucol, text.slice(ucol), Math.min(ulen, W - 4 - ucol));
    }
  }
  c.pen(p.ink, DEFAULT, 0);
}
