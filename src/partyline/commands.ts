/**
 * Partyline hub engine: the "/" commands, ported from amiexpress-web
 * sdk/c/examples/livechat/livechat.c run_command and its *_typed helpers.
 *
 * The names and aliases come from CMD_HELP (ui/slash.ts, the C lc_cmd_help), so
 * the menu and the dispatch never disagree. C dispatches a few names the table
 * does not list (l, w, j, n, np, h, d, list) and does not dispatch a few the
 * table lists as aliases (users, channels, +1, -1, heart, fire): C_ALIAS and
 * C_DROP keep run_command's behaviour on both sides.
 */
import { addIgnore, archiveRoom, clearPresence, clearRoom, markUnread, createRoom, discordInvite, getDiscordMirror, listOwnDiscordJoins, requestDiscordJoin, setDiscordMirror, deleteEmoji, deleteMessage, deleteRoom, editMessage, invite, listPins, pin, react, reactionRows, threadHistory, unreact, leaveRoom, listEmoji, listIgnores, listRooms, moderate, postDm, postDmGroup, profileOf, putEmoji, removeIgnore, setMode, setOp, setPresence, setRoomMotd, setTopic, whoRows } from '../chat/store';
import { newId } from '../chat/sessions';
import { openPreview } from '../chat/files';
import fs from 'fs';
import { SurfaceError } from '../achievements/errors';
import { CMD_HELP } from './ui/slash';
import { EMOJI, emojiBuiltin, NOTE, SIDE_USER } from './ui/model';
import { stamp } from './ui/screen';
import type { HubScreen } from './ui/screen';

export const C_ALIAS: Record<string, string> = { l: 'rooms', list: 'rooms', w: 'who', j: 'join', n: 'create', np: 'create', h: 'help', d: 'msg', 'clear-room': 'clear-room', clearroom: 'clear-room', 'archive-room': 'archive-room', 'mark-unread': 'mark-unread' };
const C_DROP = new Set(['users', 'channels', '+1', '-1', 'heart', 'fire']);

const RAMP = ' .:-=+*#%@';

/** livechat.c draw_typed and view_typed. The canvas is ./ui/canvas.ts (joining an art room opens it); /upload lives in ../media.ts. */
function drawViewTyped(s: HubScreen, cmd: string, rest: string): void {
  if (cmd === 'draw') {
    const kindOf = (id: string): string => s.tryRun(false, (db, ctx) => listRooms(db, ctx).find((r) => r.id === id || r.name.toLowerCase() === id.replace(/^#/, '').toLowerCase())?.kind ?? '') ?? '';
    if (rest === '') { if (kindOf(s.roomId) === 'art') s.canvasOpen(); else s.systemLine('Usage: /draw <art channel>  (art channels are marked [A] in the sidebar)'); return; }
    if (kindOf(rest) !== 'art') { s.systemLine('That is not an Art channel.'); return; }
    joinTyped(s, rest);
    return;
  }
  const n = Number.parseInt(rest, 10) || 0, files = s.shared;
  if (n < 1 || n > files.length) { s.systemLine(files.length > 0 ? `No file ${n} (1-${files.length})` : 'No files shared yet this session'); return; }
  const f = files[n - 1];
  if (f.kind !== 'image') { s.systemLine('That file is not a picture'); return; }
  if (!s.filesDir) { s.systemLine('File sharing is off on this hub'); return; }
  {
    const pv = s.tryRun(false, (db, ctx) => openPreview(db, s.filesDir, ctx, f.id, 'rgb', 60, 20));
    if (!pv) return;
    const [oc, orows] = pv.cells.split('x').map(Number);
    const px = fs.readFileSync(pv.path);
    s.systemLine(`--- ${f.name} ---`);
    for (let r = 0; r < orows; r++) {
      let line = '';
      for (let c = 0; c < oc; c++) { const i = (r * oc + c) * 3; line += RAMP[Math.min(9, Math.floor((299 * px[i] + 587 * px[i + 1] + 114 * px[i + 2]) * 9 / 255000))]; }
      s.systemLine(line);
    }
  }
}

/** livechat.c discord_typed: show the board's Discord mirror, or (sysop only) switch it. */
function discordTyped(s: HubScreen, rest: string): void {
  const arg = firstWord(rest);
  if (arg === 'join' || arg === 'status') { discordJoinTyped(s, arg, afterWord(rest)); return; }
  if (arg !== '' && arg !== 'on' && arg !== 'off') { s.systemLine('Usage: /discord [on|off|join|status]'); return; }
  const sysop = s.tryRun(false, (_db, ctx) => ctx.sysop);
  if (sysop === undefined) return;
  if (arg !== '' && !sysop) { s.systemLine('Only the sysop can change the Discord mirror.'); return; }
  const on = s.tryRun(arg !== '', (db, ctx) => (arg === '' ? getDiscordMirror(db, ctx) : setDiscordMirror(db, ctx, { on: arg === 'on' })));
  if (on !== undefined) s.systemLine(on ? 'Discord mirror is ON for this board.' : 'Discord mirror is OFF for this board.');
}

/**
 * /discord join <channel id> (sysop): link a Discord channel to the shared
 * room at once; the bridge picks it up without a restart. /discord status
 * lists this board's links. With no (or a bad) channel id, show the bot
 * invite link so the sysop can add the bot first.
 */
function discordJoinTyped(s: HubScreen, cmd: string, rest: string): void {
  const sysop = s.tryRun(false, (_db, ctx) => ctx.sysop);
  if (sysop === undefined) return;
  if (!sysop) { s.systemLine('Only the sysop can link Discord channels.'); return; }
  if (cmd === 'status') {
    const rows = s.tryRun(false, (db, ctx) => listOwnDiscordJoins(db, ctx));
    if (rows === undefined) return;
    if (rows.length === 0) { s.systemLine('No Discord channel links from this board yet. Invite the bot with /discord join, then send the channel id.'); return; }
    for (const r of rows) s.systemLine(`Channel ${r.channelId}: ${r.status}${r.error !== '' ? ` - ${r.error}` : ''}`);
    return;
  }
  const channelId = firstWord(rest);
  if (!/^\d{15,22}$/.test(channelId)) {
    try {
      const invite = s.run(false, (db, ctx) => discordInvite(db, ctx));
      s.systemLine(`Invite the bridge bot first: ${invite.url}`);
    } catch (err) {
      if (!(err instanceof SurfaceError)) throw err;
      s.systemLine(err.status === 404 ? 'The Discord bridge is not online yet. Try /discord later.' : err.message);
      return;
    }
    s.systemLine('Usage: /discord join <channel id>  (15 to 22 digits)');
    return;
  }
  try {
    s.run(true, (db, ctx) => requestDiscordJoin(db, ctx, { channelId }));
    s.systemLine(`Channel ${channelId} linked to the shared room.`);
  } catch (err) {
    if (!(err instanceof SurfaceError)) throw err;
    s.systemLine(err.message);
  }
}

/** The CMD_HELP name a typed command word means, or null (C: "Unknown command"). */
export function canonical(word: string): string | null {
  const w = word.toLowerCase();
  if (C_DROP.has(w)) return null;
  if (C_ALIAS[w]) return C_ALIAS[w];
  for (const [name, aliases] of CMD_HELP) if (name === w || aliases.split(',').includes(w)) return name;
  return null;
}

const firstWord = (s: string): string => s.trim().split(/ +/)[0] ?? '';
const afterWord = (s: string): string => s.trim().replace(/^\S+ */, '');
const nickOf = (s: string): string => s.replace(/^@/, '');

/** help_for: one command's description and usage. The hub's /discord also
 * takes join|status (the doors only offer on|off), so say so here; the
 * CMD_HELP row itself stays byte-identical to the C door (grid test). */
function helpFor(s: HubScreen, want: string): void {
  const row = CMD_HELP.find(([name, aliases]) => name === want || aliases.split(',').includes(want));
  if (!row) { s.systemLine(`Unknown: ${want.slice(0, 60)}`); return; }
  s.systemLine(`/${row[0]} - ${row[2].slice(0, 100)}`);
  s.systemLine(row[3]);
  if (row[0] === 'discord') s.systemLine('/discord join <channel id> | /discord status  (sysop links a channel)');
}

const usage = (s: HubScreen, text: string): void => s.systemLine(`Error: Usage: ${text}`);

/** join_typed: a name (with or without #) or a room id. */
function joinTyped(s: HubScreen, rest: string): void {
  const a = firstWord(rest).replace(/^#/, '');
  if (a === '') { s.systemLine('Usage: /join room'); return; }
  const rooms = s.tryRun(false, (db, ctx) => listRooms(db, ctx)) ?? [];
  const hit = rooms.find((r) => r.name.toLowerCase() === a.toLowerCase() || r.id === a);
  s.joinRoom(hit ? hit.id : a);
}

/** leave_room. */
function leaveTyped(s: HubScreen): void {
  if (!s.roomId) { s.systemLine('You are not in a channel.'); return; }
  const id = s.roomId, name = s.model.room;
  if (s.tryRun(true, (db, ctx) => { leaveRoom(db, ctx, id); return true; }) === undefined) return;
  s.roomId = '';
  s.model.room = '';
  s.model.paneLabel = '';
  s.model.lines = [];
  s.model.linesChanged();
  s.systemLine(`Left #${name.slice(0, 40)}`);
}

function listRoomsTyped(s: HubScreen): void {
  const rooms = s.tryRun(false, (db, ctx) => listRooms(db, ctx));
  if (!rooms) return;
  s.systemLine(`Found ${rooms.length} room${rooms.length === 1 ? '' : 's'}`);
  for (const r of rooms) s.systemLine(`#${r.name.slice(0, 30)} (${r.id.slice(0, 40)})`);
}

function listWho(s: HubScreen): void {
  const rows = s.tryRun(false, (db, ctx) => whoRows(db, ctx));
  if (!rows) return;
  s.systemLine('Who is on');
  for (const r of rows) s.systemLine(`${r.user.slice(0, 24)} in #${r.room.slice(0, 24)}${r.sysop ? ' (sysop)' : ''}, idle ${r.idle}s`);
  if (rows.length === 0) s.systemLine('Nobody is on');
}

function statusTyped(s: HubScreen, rest: string): void {
  const word = firstWord(rest) || 'online';
  if (!['online', 'away', 'busy', 'dnd'].includes(word)) { usage(s, '/status [online|away|busy|dnd] [message]'); return; }
  const text = afterWord(rest);
  if (s.tryRun(true, (db, ctx) => setPresence(db, ctx, { status: word, text })) === undefined) return;
  s.systemLine(`Status set to ${word}${text !== '' ? ': ' : ''}${text.slice(0, 100)}`);
}

function ignoreSet(s: HubScreen, arg: string, on: boolean): void {
  const nick = nickOf(arg);
  // target_user: a bare handle means a user of this board.
  const full = (user: string): string => (nick.includes('@') ? nick : `${nick}${user.slice(user.indexOf('@'))}`);
  const have = (s.tryRun(false, (db, ctx) => listIgnores(db, ctx).some((r) => r.user.toLowerCase() === full(ctx.user).toLowerCase())) ?? false);
  if (on && have) { s.systemLine(`Already ignoring ${nick.slice(0, 30)}.`); return; }
  if (!on && !have) { s.systemLine(`You are not ignoring ${nick.slice(0, 30)}.`); return; }
  const done = s.tryRun(true, (db, ctx) => { if (on) addIgnore(db, ctx, { user: full(ctx.user) }); else removeIgnore(db, ctx, full(ctx.user)); return true; });
  if (!done) return;
  s.systemLine(on ? `Ignoring ${nick.slice(0, 30)} - their messages and DMs are hidden.` : `${nick.slice(0, 30)} is no longer hidden.`);
}

/** target_user: a bare handle means a user of this board (handle@BOARD). */
const targetOf = (s: HubScreen, arg: string): { user: string; shown: string } => {
  const shown = nickOf(arg);
  const suffix = s.info.user.includes('@') ? s.info.user.slice(s.info.user.indexOf('@')) : '';
  return { user: shown.includes('@') ? shown : `${shown}${suffix}`, shown };
};

const MOD_USAGE: Record<string, string> = {
  kick: '/kick @user [reason]', mute: '/mute @user [minutes]', unmute: '/unmute @user', ban: '/ban @user [reason]', unban: '/unban @user',
  op: '/op @user  |  /op -@user  |  /deop @user', deop: '/op @user  |  /op -@user  |  /deop @user',
};

/** moderate_typed: the hub store checks the level; its refusal prints as a system line. */
function moderateTyped(s: HubScreen, cmd: string, rest: string): void {
  let a = firstWord(rest), action = cmd;
  if ((cmd === 'op') && a.startsWith('-')) { action = 'deop'; a = a.slice(1); }
  if (a === '' || a === '@') { usage(s, MOD_USAGE[cmd]); return; }
  const { user } = targetOf(s, a);
  const more = afterWord(rest);
  const reason = more !== '' ? more : 'No reason given';
  const id = s.roomId;
  const done = s.tryRun(true, (db, ctx) => {
    if (action === 'op' || action === 'deop') setOp(db, ctx, id, { user }, action === 'op');
    else moderate(db, ctx, id, action as 'kick', { user, reason: cmd === 'kick' || cmd === 'ban' ? reason : '', ...(cmd === 'mute' ? { minutes: more !== '' ? parseInt(more, 10) || 0 : 5 } : {}) });
    return true;
  });
  void done;
}

/** invite_typed: /invite /uninvite @user [#room]. */
function inviteTyped(s: HubScreen, add: boolean, rest: string): void {
  const a = firstWord(rest);
  if (a === '') { usage(s, add ? '/invite @user [#room]' : '/uninvite @user [#room]'); return; }
  const r = firstWord(afterWord(rest)).replace(/^#/, '');
  const rooms = s.tryRun(false, (db, ctx) => listRooms(db, ctx)) ?? [];
  const room = r !== '' ? rooms.find((x) => x.name === r || x.id === r)?.id ?? s.roomId : s.roomId;
  const { user, shown } = targetOf(s, a);
  if (s.tryRun(true, (db, ctx) => { invite(db, ctx, room, { user }, add, user); return true; })) s.systemLine(add ? `Invited ${shown.slice(0, 40)} to the room` : `Revoked invite for ${shown.slice(0, 40)}`);
}

/** whois_typed. */
function whoisTyped(s: HubScreen, rest: string): void {
  const a = firstWord(rest);
  if (a === '') { usage(s, '/whois @user'); return; }
  const { user, shown } = targetOf(s, a);
  const p = s.tryRun(false, (db, ctx) => { try { return profileOf(db, ctx, user); } catch { return null; } });
  if (p === undefined) return;
  if (p === null) { s.systemLine(`User ${shown.slice(0, 30)} is not online.`); return; }
  s.systemLine(`${p.nick.slice(0, 30)} - ${p.status.slice(0, 20)}${p.statusText !== '' ? ': ' : ''}${p.statusText.slice(0, 60)}`);
  s.systemLine(`Board ${p.board.slice(0, 20)}, ${p.online ? 'online' : 'offline'}, last seen ${stamp(p.lastSeen)}, idle ${p.idle === '' ? 0 : p.idle}s`);
  // room_names_of: the profile carries room ids; the name comes from the room row.
  const names = p.sharedRooms === '' ? [] : s.tryRun(false, (db) => p.sharedRooms.split(',').map((id) => (db.prepare('SELECT name FROM chat_rooms WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id)) ?? [];
  if (names.length > 0) s.systemLine(`Shared rooms: ${names.map((n) => `#${n}`).join(', ').slice(0, 100)}`);
}

/**
 * LIVECHAT context-menus.ts Add Note: the note goes on the board's user record, so the hub only
 * asks the caller's board (PLP T `note <user>\t<text>`); the relay answers U `note ok|fail <user>`.
 * A handle with a space is taken whole when it is a listed user (longest match), else the name is the first word.
 */
function noteTyped(s: HubScreen, rest: string): void {
  const a = noteTarget(s, rest);
  const text = rest.slice(rest.indexOf(a) + a.length).replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (a === '' || text === '') { usage(s, '/note @user <text>'); return; }
  if (!s.info.ctrl) { s.systemLine('Notes are unavailable.'); return; }
  const { user, shown } = targetOf(s, a);
  const own = s.info.user.includes('@') ? s.info.user.slice(s.info.user.indexOf('@')) : '';
  // Only users of the caller's own board have a record there (web chat's /api/chat/notes rule).
  if (user.includes('@') && user.slice(user.indexOf('@')).toLowerCase() !== own.toLowerCase()) { s.systemLine(`${shown.slice(0, 30)} is not a user of this board.`); return; }
  s.info.ctrl(`note ${user.split('@')[0]}\t${text.slice(0, 1000)}`);
}

/** The leading handle of `/note` args: the longest sidebar user name followed by a space, else the first word. */
export function noteTarget(s: HubScreen, rest: string): string {
  const t = rest.trim(), bare = t.replace(/^@/, '').toLowerCase();
  const known = s.model.side.filter((x) => x.kind === SIDE_USER).flatMap((x) => [x.label, x.id ?? '']).filter((n) => n.includes(' ')).sort((x, y) => y.length - x.length)
    .find((n) => bare.startsWith(`${n.toLowerCase()} `));
  return known === undefined ? firstWord(t) : t.slice(0, known.length + (t.startsWith('@') ? 1 : 0));
}

/** msg_typed: every leading @word is a target; one is a DM, two or more a group DM. */
function msgTyped(s: HubScreen, rest: string): void {
  const targets: { user: string; shown: string }[] = [];
  let r = rest;
  while (r.startsWith('@') && targets.length < 10) { targets.push(targetOf(s, firstWord(r))); r = afterWord(r); }
  if (targets.length === 0 || r === '') { s.systemLine('Usage: /msg @user [@user2 ...] message'); return; }
  const body = { content: r, clientId: newId('pl') };
  const ok = s.tryRun(true, (db, ctx) => {
    if (targets.length === 1) postDm(db, ctx, targets[0].user, body); else postDmGroup(db, ctx, { ...body, participants: targets.map((t) => t.user) });
    return true;
  });
  // livechat.c msg_typed: to the peer of the open DM thread, the dm event paints the numbered line
  if (ok && targets.length === 1 && s.dmThread !== '' && targets[0].user.toLowerCase() === s.dmPeer.toLowerCase()) return;
  // livechat.c dm_line(1, ...): an unnumbered note, so /react n on it says "No such message number."
  if (ok) s.note(NOTE, `[${targets.length > 1 ? 'Group DM' : 'DM'} to ${targets.map((t) => t.shown).join(', ').slice(0, 120)}]: ${r.slice(0, 190)}`);
}

/** motd_typed: no text shows the room's, --clear clears it. */
function motdTyped(s: HubScreen, rest: string): void {
  if (rest === '') {
    const id = s.roomId;
    const motd = s.tryRun(false, (db) => (db.prepare('SELECT motd FROM chat_rooms WHERE id = ?').get(id) as { motd: string } | undefined)?.motd ?? '');
    if (motd === undefined) return;
    s.systemLine(motd === '' ? 'No MOTD set. Use /motd <text> to set, /motd --clear to clear.' : `[MOTD] ${motd.slice(0, 200)}`);
    return;
  }
  if (!s.roomId) { s.systemLine('Join a room first.'); return; }
  const id = s.roomId;
  s.tryRun(true, (db, ctx) => setRoomMotd(db, ctx, id, { motd: rest === '--clear' ? '' : rest }));
}

/** mode_typed: /mode <+modes> [@user ...]. */
function modeTyped(s: HubScreen, rest: string): void {
  const modes = firstWord(rest);
  if (modes === '') { usage(s, '/mode <+modes> [param]  e.g. /mode +i  or /mode +o alice'); return; }
  if (!/^[+-][a-zA-Z]/.test(modes)) { s.systemLine('Error: Mode string must start with + or -'); return; }
  if (!s.roomId) { s.systemLine('Error: Not in a room'); return; }
  const id = s.roomId;
  const params = afterWord(rest).split(/ +/).filter((w) => w !== '').map((w) => targetOf(s, w).user).join(' ');
  const r = s.tryRun(true, (db, ctx) => setMode(db, ctx, id, { modes, params }));
  if (r && r.errors !== '') for (const e of r.errors.split('\n')) s.systemLine(`Error: ${e.slice(0, 120)}`);
}

const CREATE_USAGE = '/create #name [topic] [--type text|voice|art] [--private] [--invite-only] [--motd "text"]';

/** create_flags: the first word is the name, other plain words the topic, --motd takes the words up to the next flag. */
function createTyped(s: HubScreen, rest: string, priv: boolean): void {
  const words = rest.split(/ +/).filter((w) => w !== '');
  const name = words[0].replace(/^#/, '');
  let kind = 'text', motd = '', isPriv = priv;
  const topic: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--private' || w === '--invite-only') isPriv = true;
    else if (w === '--type') {
      kind = (words[++i] ?? '').toLowerCase();
      if (!['text', 'voice', 'art'].includes(kind)) { s.systemLine('Error: Channel type must be text, voice or art.'); return; }
    } else if (w === '--motd') {
      const m: string[] = [];
      while (i + 1 < words.length && !words[i + 1].startsWith('--')) m.push(words[++i]);
      motd = m.join(' ').replace(/^["']|["']$/g, '');
    } else topic.push(w);
  }
  if (name === '') { usage(s, CREATE_USAGE); return; }
  const r = s.tryRun(true, (db, ctx) => createRoom(db, ctx, { name, kind, visibility: isPriv ? 'private' : 'public', ...(topic.length > 0 ? { topic: topic.join(' ').slice(0, 120) } : {}) }));
  if (!r) return;
  if (motd !== '') s.tryRun(true, (db, ctx) => setRoomMotd(db, ctx, r.id, { motd }));
  s.joinRoom(r.id);
}

/** delete_channel_typed. */
function deleteChannelTyped(s: HubScreen, rest: string): void {
  const a = firstWord(rest).replace(/^#/, '');
  if (a === '') { usage(s, '/delete #channel'); return; }
  const rooms = s.tryRun(false, (db, ctx) => listRooms(db, ctx)) ?? [];
  const hit = rooms.find((r) => r.name.toLowerCase() === a.toLowerCase() || r.id === a);
  if (!hit) { s.systemLine(`Channel ${a.slice(0, 40)} not found`); return; }
  if (s.tryRun(true, (db, ctx) => { deleteRoom(db, ctx, hit.id); return true; })) {
    if (hit.id === s.roomId) { s.roomId = ''; s.model.room = ''; s.model.paneLabel = ''; s.model.lines = []; s.model.linesChanged(); }
    s.systemLine(`Deleted #${hit.name.slice(0, 40)}`);
  }
}

// ---- message commands: the number on a pane line maps to the stored message id (C line_by_number) ----
const digits = (a: string): boolean => /^\d+$/.test(a);
const lineByNumber = (s: HubScreen, n: number) => (n > 0 ? s.model.lines.find((l) => l.number === n) : undefined);
/** Pane nicks are store users (handle@BOARD), which is ctx.user, not the screen's handle. */
const ownLast = (s: HubScreen) => {
  const me = s.tryRun(false, (_db, ctx) => ctx.user);
  return [...s.model.lines].reverse().find((l) => l.number > 0 && l.id !== '' && l.nick === me);
};
const roomLast = (s: HubScreen) => [...s.model.lines].reverse().find((l) => l.number > 0 && l.id !== '');

/** typed_message: a message number to its line, or the "No such message number." line. */
function typedMessage(s: HubScreen, a: string) {
  const l = lineByNumber(s, parseInt(a, 10));
  if (!l || l.id === '') s.systemLine('No such message number.');
  return l && l.id !== '' ? l : undefined;
}

/** edit_typed: /edit [msg-id] new text; an id counts only with two or more words. */
function editTyped(s: HubScreen, rest: string): void {
  if (rest === '') { usage(s, '/edit [msg-id] new text'); return; }
  const a = firstWord(rest);
  let text = rest, l;
  if (digits(a) && afterWord(rest) !== '') { l = typedMessage(s, a); if (!l) return; text = afterWord(rest); }
  else if (!(l = ownLast(s))) { s.systemLine('No message to edit: name one with its id, or send a line first.'); return; }
  const id = l.id;
  s.tryRun(true, (db, ctx) => editMessage(db, ctx, id, { content: text }));
}

/** reply_typed: /reply [msg-id] text (alias r), /thread msg-id text (alias t); both send a reply line. */
function replyTyped(s: HubScreen, rest: string, thread: boolean): void {
  const a = firstWord(rest), text0 = afterWord(rest);
  if (thread && digits(a) && text0 === '') { // an id alone opens the thread view
    const l = typedMessage(s, a);
    if (!l) return;
    const rows = s.tryRun(false, (db, ctx) => threadHistory(db, ctx, l.id));
    if (!rows) return;
    s.systemLine(rows.length === 0 ? 'No replies in this thread.' : `Thread (${rows.length}):`);
    for (const r of rows) s.systemLine(`${r.user.slice(0, 24)}: ${r.text.slice(0, 190)}`);
    return;
  }
  if (thread && (a === '' || text0 === '')) { usage(s, '/thread <msg-id> message'); return; }
  if (rest === '') { usage(s, '/reply [msg-id] message'); return; }
  let text = rest, l;
  if (digits(a) && text0 !== '') { l = typedMessage(s, a); if (!l) return; text = text0; }
  else if (thread) { usage(s, '/thread <msg-id> message'); return; }
  else if (!(l = roomLast(s))) { s.systemLine('No message to reply to: name one with its id.'); return; }
  if (!s.roomId) { s.systemLine('Join a room first.'); return; }
  s.sendRoomLine(text, l.id);
}

/** delete_typed: /deletemsg [msg-id]. */
function deleteMsgTyped(s: HubScreen, rest: string): void {
  const a = firstWord(rest);
  if (a !== '' && !digits(a)) { usage(s, '/deletemsg [msg-id]'); return; }
  const l = a !== '' ? typedMessage(s, a) : ownLast(s);
  if (!l) { if (a === '') s.systemLine('No message to delete: name one with its id, or send a line first.'); return; }
  const id = l.id;
  s.tryRun(true, (db, ctx) => { deleteMessage(db, ctx, id); return true; });
}

/** react (/react n emoji), love, thumbsup, unreact [emoji] n: react_typed and the run_command react branch. */
function reactTyped(s: HubScreen, cmd: string, rest: string): void {
  const a = firstWord(rest);
  if (cmd === 'react') {
    const l = typedMessage(s, a);
    if (!l) return;
    const emoji = afterWord(rest);
    if (emoji === '') { s.systemLine('Usage: /react n emoji'); return; }
    s.tryRun(true, (db, ctx) => react(db, ctx, l.id, { emoji }));
    return;
  }
  if (cmd === 'unreact') {
    const b = firstWord(afterWord(rest));
    if (b === '') { usage(s, '/unreact [emoji] <msg-id>'); return; }
    const l = typedMessage(s, b);
    if (l) s.tryRun(true, (db, ctx) => unreact(db, ctx, l.id, a !== '' ? a : '+1'));
    return;
  }
  if (a === '') { usage(s, cmd === 'love' ? '/love <msg-id>' : '/thumbsup <msg-id>'); return; }
  const l = typedMessage(s, a);
  if (l) s.tryRun(true, (db, ctx) => react(db, ctx, l.id, { emoji: cmd === 'love' ? 'heart' : '+1' }));
}

/** reactions_typed: `Reactions on N: [emoji n] ...` or `No reactions on N`. */
function reactionsTyped(s: HubScreen, rest: string): void {
  const a = firstWord(rest);
  if (a === '') { usage(s, '/reactions <msg-id>'); return; }
  const l = typedMessage(s, a);
  if (!l) return;
  const rows = s.tryRun(false, (db, ctx) => reactionRows(db, ctx, l.id));
  if (!rows) return;
  const shown = rows.filter((r) => r.count > 0).map((r) => ` [${r.emoji.slice(0, 12)} ${r.count}]`).join('');
  s.systemLine(shown === '' ? `No reactions on ${a.slice(0, 12)}` : `Reactions on ${a.slice(0, 12)}:${shown}`);
}

/** pin_typed: a message number, else the raw id. The store checks the level. */
function pinTyped(s: HubScreen, on: boolean, rest: string): void {
  const a = firstWord(rest);
  if (a === '' || afterWord(rest) !== '') { usage(s, on ? '/pin <msg-id>' : '/unpin <msg-id>'); return; }
  if (!s.roomId) { s.systemLine('Join a room first.'); return; }
  const id = (digits(a) ? lineByNumber(s, parseInt(a, 10))?.id : '') || a, room = s.roomId;
  if (s.tryRun(true, (db, ctx) => { pin(db, ctx, room, { messageId: id }, on, id); return true; })) s.systemLine(on ? 'Pin requested.' : 'Unpin requested.');
}

/** pinned_typed: up to 8 pins, as lines instead of C's view window. */
function pinnedTyped(s: HubScreen): void {
  if (!s.roomId) { s.systemLine('Join a room first.'); return; }
  const room = s.roomId;
  const rows = s.tryRun(false, (db, ctx) => listPins(db, ctx, room));
  if (!rows) return;
  if (rows.length === 0) { s.systemLine('No pinned messages in this room.'); return; }
  s.systemLine(`Pinned Messages (${rows.length}):`);
  rows.slice(0, 8).forEach((r, i) => s.systemLine(`${i + 1}. ${r.user.slice(0, 24)}: ${r.content.slice(0, 60)} (pinned by ${r.pinnedBy.slice(0, 20)})`));
}

/** livechat.c /search, /find: search_open (the query is typed in the overlay). */
function searchTyped(s: HubScreen): void { s.searchOpen(); }

const onOff = (v: boolean): string => (v ? 'ON' : 'OFF');
const EVENT_KEYS: [string, string[], string, string][] = [
  ['logins', ['login'], 'Login/logout events', 'User Logins/Logouts:    '],
  ['files', ['file'], 'File upload/download events', 'File Uploads/Downloads: '],
  ['doors', ['door'], 'Door activity events', 'Door Activity:          '],
  ['messages', ['message'], 'New message events', 'New Messages:           '],
  ['announcements', ['announcement', 'system'], 'System announcements', 'System Announcements:   '],
];

/** events_typed: the event toggles; prefs_save keeps them across visits. */
function eventsTyped(s: HubScreen, rest: string): void {
  const sub = firstWord(rest).toLowerCase(), ev = s.prefs.events;
  if (sub === '') {
    s.systemLine('BBS Event Display Settings:');
    for (const [k, , , label] of EVENT_KEYS) s.systemLine(`  ${label} ${onOff(ev[k])}`);
    s.systemLine('Use /events <type> to toggle: logins, files, doors, messages, announcements; /events on|off sets all.');
    return;
  }
  if (['on', 'enable', 'off', 'disable'].includes(sub)) {
    const on = sub[1] === 'n';
    for (const [k] of EVENT_KEYS) ev[k] = on;
    s.prefsSave();
    s.systemLine(on ? 'All BBS events enabled' : 'All BBS events disabled');
    return;
  }
  const row = EVENT_KEYS.find(([k, alt]) => k === sub || alt.includes(sub));
  if (!row) { s.systemLine(`Unknown event type: ${sub.slice(0, 30)}`); s.systemLine('Valid types: logins, files, doors, messages, announcements, on, off'); return; }
  ev[row[0]] = !ev[row[0]];
  s.prefsSave();
  s.systemLine(`${row[2]}: ${onOff(ev[row[0]])}`);
}

/** sounds_typed: /sounds on|off. */
function soundsTyped(s: HubScreen, rest: string): void {
  const w = firstWord(rest).toLowerCase();
  if (w !== 'on' && w !== 'off') { s.systemLine('Error: Usage: /sounds on|off'); return; }
  s.prefs.sounds = w === 'on';
  s.prefsSave();
  s.systemLine(s.prefs.sounds ? 'Sounds enabled' : 'Sounds disabled');
}

/** livechat.c /settings: settings_open. */
function settingsTyped(s: HubScreen): void { s.settingsOpen(); }

/** The sidebar "Clear History" action, sysop only; the store checks the owner level. */
function clearRoomTyped(s: HubScreen, rest: string): void {
  const a = firstWord(rest).replace(/^#/, '');
  const hit = a === '' ? undefined : (s.tryRun(false, (db, ctx) => listRooms(db, ctx)) ?? []).find((r) => r.name.toLowerCase() === a.toLowerCase() || r.id === a);
  const id = a === '' ? s.roomId : hit?.id;
  if (!id) { s.systemLine(a === '' ? 'Join a room first.' : `Channel ${a.slice(0, 40)} not found`); return; }
  if (s.tryRun(true, (db, ctx) => { clearRoom(db, ctx, id); return true; })) s.systemLine(`Clear history requested for ${(hit?.name ?? s.model.room).slice(0, 36)}`);
}

/** The sidebar "Archive" action (LIVECHAT admin:archive-channel), sysop only; the store checks the owner level. */
function archiveRoomTyped(s: HubScreen, rest: string): void {
  const a = firstWord(rest).replace(/^#/, '');
  const hit = (s.tryRun(false, (db, ctx) => listRooms(db, ctx)) ?? []).find((r) => r.name.toLowerCase() === a.toLowerCase() || r.id === a);
  if (!hit) { s.systemLine(a === '' ? 'Usage: /archive-room #channel' : `Channel ${a.slice(0, 40)} not found`); return; }
  if (s.tryRun(true, (db, ctx) => { archiveRoom(db, ctx, hit.id); return true; })) {
    if (hit.id === s.roomId) { s.roomId = ''; s.model.room = ''; s.model.paneLabel = ''; s.model.lines = []; s.model.linesChanged(); }
    s.systemLine(`Archive requested for ${hit.name.slice(0, 40)}`);
  }
}

/** The message menu's Mark Unread (LIVECHAT context-menus.ts): the current room shows at least one unread. */
function markUnreadTyped(s: HubScreen): void {
  const ok = s.roomId !== '' && s.tryRun(true, (db, ctx) => markUnread(db, ctx, s.roomId));
  s.systemLine(ok ? `Marked ${s.model.room.slice(0, 36)} as unread` : 'No channel to mark unread.');
}

// ---- emoji, emojis, customemoji (livechat.c emoji_search_typed, emojis_typed, customemoji_typed) ----
/** livechat_ui.c emoji_table: category (0 Emotions, 1 Actions, 2 Symbols, 3 Special) and keywords per ui/model EMOJI code. */
const EMOJI_META: Record<string, [number, string]> = {
  ':smile:': [0, 'happy, grin'], ':grin:': [0, 'big, smile, laugh'], ':joy:': [0, 'laugh, lol'], ':wink:': [0, 'flirt'], ':heart:': [0, 'love'],
  ':sad:': [0, 'unhappy, frown'], ':cry:': [0, 'tears, sob'], ':shock:': [0, 'surprised, wow'], ':angry:': [0, 'mad, furious'],
  ':cool:': [0, 'sunglasses, awesome'], ':tongue:': [0, 'playful, silly'], ':kiss:': [0, 'love, romance'], ':blush:': [0, 'shy, embarrassed'],
  ':confused:': [0, 'unsure, puzzled'], ':neutral:': [0, 'meh, okay'], ':surprised:': [0, 'wow, shocked'], ':evil:': [0, 'devil, mischief'],
  ':angel:': [0, 'innocent, halo'], ':tableflip:': [1, 'rage, flip, angry'], ':unflip:': [1, 'calm, fix'], ':shrug:': [1, 'dunno, whatever'],
  ':fight:': [1, 'battle, fite'], ':dance:': [1, 'party'], ':hug:': [1, 'cuddle, embrace'], ':run:': [1, 'flee, escape'], ':wave:': [1, 'hello, bye'],
  ':facepalm:': [1, 'disappointed, sigh'], ':thumbsup:': [2, 'yes, ok, good'], ':thumbsdown:': [2, 'no, bad'], ':fire:': [2, 'hot, lit'],
  ':star:': [2, 'favorite'], ':check:': [2, 'yes, done'], ':x:': [2, 'no, fail'], ':skull:': [2, 'death, pirate'], ':music:': [2, 'song, note'],
  ':heart2:': [2, 'love, like'], ':diamond:': [2, 'gem, shine'], ':arrow:': [2, 'next, go'], ':warning:': [2, 'caution, alert'],
  ':lightning:': [2, 'power, fast'], ':amiga:': [3, 'boing, retro, computer'], ':bbs:': [3, 'board, system'], ':door:': [3, 'game, app'],
};
const EMOJI_CATS: [string, number][] = [['emotions', 0], ['emotion', 0], ['actions', 1], ['action', 1], ['symbols', 2], ['symbol', 2], ['special', 3]];
const CAT_NAMES = ['Emotions', 'Actions', 'Symbols', 'Special'];
interface EmojiEntry { code: string; face: string; cat: number; keywords: string }
export const allEmoji = (s: HubScreen): EmojiEntry[] => [
  ...EMOJI.map(([code, face]) => ({ code, face, cat: EMOJI_META[code]?.[0] ?? 3, keywords: EMOJI_META[code]?.[1] ?? '' })),
  ...s.model.customEmoji.map((e) => ({ code: `:${e.name}:`, face: e.ascii, cat: 3, keywords: 'custom' })),
  ...s.imageEmoji.map((n) => ({ code: `:${n}:`, face: `:${n}:`, cat: 3, keywords: 'custom' })),
];
const emojiLine = (e: EmojiEntry): string => `  ${e.face}  ${e.code} (${e.keywords})`;

/** load_custom_emoji: the hub's custom emoji, so ":name:" in a message shows its ascii face. Best effort. */
export function loadCustomEmoji(s: HubScreen): void {
  const rows = s.tryRun(false, (db) => listEmoji(db));
  s.imageEmoji = (rows ?? []).filter((r) => r.ascii === '' && r.display !== '').map((r) => r.name);
  s.model.customEmoji = (rows ?? []).filter((r) => r.ascii !== '').map((r) => ({ name: r.name, ascii: r.ascii }));
}

/** emoji_search_typed: code or any keyword contains the query; first 10. No query opens the picker. */
function emojiTyped(s: HubScreen, rest: string): void {
  const q = rest.trim().toLowerCase();
  if (q === '') { s.openPicker(); return; }
  const hits = allEmoji(s).filter((e) => e.code.includes(q) || e.keywords.split(', ').some((k) => k.includes(q)));
  if (hits.length === 0) { s.systemLine(`No emojis found for "${q.slice(0, 100)}"`); return; }
  s.systemLine(`Emojis matching "${q.slice(0, 100)}":`);
  for (const e of hits.slice(0, 10)) s.systemLine(emojiLine(e));
  if (hits.length > 10) s.systemLine(`  ... and ${hits.length - 10} more`);
}

/** emojis_typed: the category list, or one category's emojis. */
function emojisTyped(s: HubScreen, rest: string): void {
  const w = firstWord(rest).toLowerCase();
  if (w === '') {
    for (const l of ['Emoji Categories:', '  emotions - Smileys and emotions', '  actions - Kaomoji actions', '  symbols - Common symbols', '  special - BBS-themed emojis', '',
      'Use /emojis <category> to list emojis in a category', 'Use /emoji <search> to search emojis']) s.systemLine(l);
    return;
  }
  const cat = EMOJI_CATS.find(([n]) => n === w)?.[1];
  if (cat === undefined) { s.systemLine(`Unknown category "${w.slice(0, 30)}". Use /emojis to see all categories.`); return; }
  s.systemLine(`${CAT_NAMES[cat]} Emojis:`);
  for (const e of allEmoji(s).filter((x) => x.cat === cat)) s.systemLine(emojiLine(e));
}

/** customemoji_typed: list | add <name> <display> <ascii> | remove <name>. The store refuses a non-sysop add or remove. */
function customEmojiTyped(s: HubScreen, rest: string): void {
  const sub = firstWord(rest).toLowerCase();
  const args = afterWord(rest).split(/ +/).filter((x) => x !== '');
  if (sub === '' || sub === 'list') {
    const rows = (s.tryRun(false, (db) => listEmoji(db)) ?? []).filter((r) => r.display !== '' && r.ascii !== '');
    for (const r of rows) s.systemLine(`  ${r.name.slice(0, 32)}  web ${r.display.slice(0, 32)}  telnet ${r.ascii.slice(0, 32)}`);
    if (rows.length === 0) s.systemLine('No custom emoji yet.');
    return;
  }
  if (sub !== 'add' && sub !== 'remove') { s.systemLine('Usage: /customemoji add <name> <display> <ascii> | remove <name> | list'); return; }
  const sysop = s.tryRun(false, (_db, ctx) => ctx.sysop);
  if (sysop === undefined) return;
  if (!sysop) { s.systemLine('Only the sysop can add or remove custom emoji.'); return; } // livechat.c :3511
  const name = (args[0] ?? '').replace(/^:/, '').replace(/:$/, '').toLowerCase();
  if (sub === 'remove') {
    if (name === '') { s.systemLine('Usage: /customemoji remove <name>'); return; }
    s.tryRun(true, (db, ctx) => { deleteEmoji(db, ctx, name, s.info.boardId); return true; });
  } else if (name === '' || !args[1] || !args[2]) s.systemLine('Usage: /customemoji add <name> <display> <ascii>');
  else if (emojiBuiltin(`:${name}:`)) s.systemLine(`:${name}: is a built-in emoji.`);
  else { const [, display, ascii] = args; s.tryRun(true, (db, ctx) => { putEmoji(db, ctx, name, { display, ascii }, s.info.boardId); return true; }); }
  loadCustomEmoji(s);
}

/** run_command: true means quit. */
export function runCommand(s: HubScreen, line: string): boolean {
  const word = firstWord(line.slice(1)).toLowerCase();
  const rest = afterWord(line.slice(1));
  const cmd = canonical(word);
  const m = s.model;
  switch (cmd) {
    case 'quit': return true;
    case 'help': {
      const a = firstWord(rest);
      if (a !== '') helpFor(s, a.replace(/^\//, '').toLowerCase());
      else { s.over.help = true; s.over.helpTop = 0; s.info.markDirty(); }
      return false;
    }
    case 'compact': m.compact = !m.compact; m.linesChanged(); s.prefsSave(); s.systemLine(m.compact ? 'Compact mode on' : 'Compact mode off'); return false;
    case 'timestamps': m.timestamps = !m.timestamps; m.linesChanged(); s.prefsSave(); s.systemLine(m.timestamps ? 'Timestamps on' : 'Timestamps off'); return false;
    case 'rooms': listRoomsTyped(s); return false;
    case 'who': listWho(s); return false;
    case 'join': joinTyped(s, rest); return false;
    case 'leave': leaveTyped(s); return false;
    case 'clear': m.lines = []; m.linesChanged(); s.info.markDirty(); return false;
    case 'away': {
      const msg = rest !== '' ? rest : 'Away';
      if (s.tryRun(true, (db, ctx) => setPresence(db, ctx, { status: 'away', text: msg })) !== undefined) s.systemLine(`You are now away: ${msg.slice(0, 100)}`);
      return false;
    }
    case 'back':
      if (s.tryRun(true, (db, ctx) => clearPresence(db, ctx)) !== undefined) s.systemLine('You are now online');
      return false;
    case 'status': statusTyped(s, rest); return false;
    case 'nick': s.systemLine(`Your username: ${m.handle.slice(0, 40)}`); return false;
    case 'ignore': {
      const a = firstWord(rest);
      if (a !== '') { ignoreSet(s, a, true); return false; }
      const list = s.tryRun(false, (db, ctx) => listIgnores(db, ctx));
      if (!list) return false;
      s.systemLine(list.length === 0 ? 'You are not ignoring anyone.' : `Ignoring: ${list.map((r) => r.user).join(', ')}`.slice(0, 400));
      return false;
    }
    case 'unignore': {
      const a = firstWord(rest);
      if (a === '') usage(s, '/unignore <user>'); else ignoreSet(s, a, false);
      return false;
    }
    case 'topic': {
      if (rest === '') { usage(s, '/topic <new topic>'); return false; }
      const id = s.roomId;
      s.tryRun(true, (db, ctx) => setTopic(db, ctx, id, { topic: rest }));
      return false;
    }
    case 'me':
      if (rest === '') { usage(s, '/me does something'); return false; }
      if (!s.roomId) { s.systemLine('Join a room first.'); return false; }
      s.sendRoomLine(`ACTION: * ${m.handle.slice(0, 30)} ${rest.slice(0, 190)}`);
      return false;
    case 'kick': case 'ban': case 'unban': case 'mute': case 'unmute': case 'op': case 'deop': moderateTyped(s, cmd, rest); return false;
    case 'invite': inviteTyped(s, true, rest); return false;
    case 'uninvite': inviteTyped(s, false, rest); return false;
    case 'whois': whoisTyped(s, rest); return false;
    case 'note': noteTyped(s, rest); return false;
    case 'msg': msgTyped(s, rest); return false;
    case 'motd': motdTyped(s, rest); return false;
    case 'mode': modeTyped(s, rest); return false;
    case 'create': if (rest === '') usage(s, CREATE_USAGE); else createTyped(s, rest, word === 'np'); return false;
    case 'delete': deleteChannelTyped(s, rest); return false;
    case 'edit': editTyped(s, rest); return false;
    case 'reply': replyTyped(s, rest, false); return false;
    case 'thread': replyTyped(s, rest, true); return false;
    case 'deletemsg': deleteMsgTyped(s, rest); return false;
    case 'react': case 'unreact': case 'love': case 'thumbsup': reactTyped(s, cmd, rest); return false;
    case 'reactions': reactionsTyped(s, rest); return false;
    case 'pin': pinTyped(s, true, rest); return false;
    case 'unpin': pinTyped(s, false, rest); return false;
    case 'pinned': pinnedTyped(s); return false;
    case 'search': searchTyped(s); return false;
    case 'events': eventsTyped(s, rest); return false;
    case 'sounds': soundsTyped(s, rest); return false;
    case 'settings': settingsTyped(s); return false;
    case 'emoji': emojiTyped(s, rest); return false;
    case 'emojis': emojisTyped(s, rest); return false;
    case 'customemoji': customEmojiTyped(s, rest); return false;
    case 'draw': case 'view': drawViewTyped(s, cmd, rest); return false;
    // livechat.c upload_typed (:2900): a DM thread view has no room; no room at all keeps the TS LIVECHAT line (media.ts).
    case 'upload': if (s.dmThread !== '') s.systemLine('Join a room first.'); else s.av.command(cmd, rest); return false;
    case 'files': case 'voice': case 'mic': case 'deafen': case 'undeafen': s.av.command(cmd, rest); return false;
    case 'discord': discordTyped(s, rest); return false;
    case 'clear-room': clearRoomTyped(s, rest); return false;
    case 'archive-room': archiveRoomTyped(s, rest); return false;
    case 'mark-unread': markUnreadTyped(s); return false;
    case null:
      s.systemLine('Unknown command. Type /help for help.');
      return false;
    default:
      // shortcut: the remaining CMD_HELP commands (moderation, DMs, threads, pins, pickers) land with P3.
      s.systemLine(`/${cmd} is not on Partyline yet.`);
      return false;
  }
}
