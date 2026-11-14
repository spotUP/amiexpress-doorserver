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
import { addIgnore, clearPresence, createRoom, deleteRoom, invite, leaveRoom, listIgnores, listRooms, moderate, postDm, postDmGroup, profileOf, removeIgnore, setMode, setOp, setPresence, setRoomMotd, setTopic, whoRows } from '../chat/store';
import { newId } from '../chat/sessions';
import { CMD_HELP } from './ui/slash';
import type { HubScreen } from './ui/screen';

const C_ALIAS: Record<string, string> = { l: 'rooms', list: 'rooms', w: 'who', j: 'join', n: 'create', np: 'create', h: 'help', d: 'msg' };
const C_DROP = new Set(['users', 'channels', '+1', '-1', 'heart', 'fire']);
/** run_command: these answer with a fixed line on Amiga, so they do on Partyline. */
const NOT_ON_AMIGA: Record<string, string> = {
  voice: 'Voice is not on Amiga yet.', deafen: 'Voice is not on Amiga yet.', undeafen: 'Voice is not on Amiga yet.', mic: 'Voice is not on Amiga yet.',
  files: 'File sharing is not on Amiga yet.',
};

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

/** help_for: one command's description and usage. */
function helpFor(s: HubScreen, want: string): void {
  const row = CMD_HELP.find(([name, aliases]) => name === want || aliases.split(',').includes(want));
  if (!row) { s.systemLine(`Unknown: ${want.slice(0, 60)}`); return; }
  s.systemLine(`/${row[0]} - ${row[2].slice(0, 100)}`);
  s.systemLine(row[3]);
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
  s.systemLine(`Board ${p.board.slice(0, 20)}, ${p.online ? 'online' : 'offline'}, idle ${p.idle}s`);
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
  if (ok) s.systemLine(`-> ${targets.map((t) => t.shown).join(', ').slice(0, 100)}: ${r.slice(0, 190)}`);
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

/** create_typed: /create #name [--type text|voice|art] [--private|--invite-only]. */
function createTyped(s: HubScreen, rest: string, priv: boolean): void {
  const m = /--type +(\S+)/.exec(rest);
  const kind = m ? m[1] : 'text';
  if (!['text', 'voice', 'art'].includes(kind)) { usage(s, '/create #name [--type text|voice|art]'); return; }
  const isPriv = priv || /--(private|invite-only)\b/.test(rest);
  const name = rest.replace(/--\S+( +(text|voice|art))?/g, '').trim().replace(/^#/, '');
  if (name === '') { usage(s, '/create #name [--type text|voice|art]'); return; }
  const r = s.tryRun(true, (db, ctx) => createRoom(db, ctx, { name, kind, visibility: isPriv ? 'private' : 'public' }));
  if (r) s.joinRoom(r.id);
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
    case 'compact': m.compact = !m.compact; m.linesChanged(); s.systemLine(m.compact ? 'Compact mode on' : 'Compact mode off'); return false;
    case 'timestamps': m.timestamps = !m.timestamps; m.linesChanged(); s.systemLine(m.timestamps ? 'Timestamps on' : 'Timestamps off'); return false;
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
    case 'msg': msgTyped(s, rest); return false;
    case 'motd': motdTyped(s, rest); return false;
    case 'mode': modeTyped(s, rest); return false;
    case 'create': if (rest === '') usage(s, '/create #name [--type text|voice|art]'); else createTyped(s, rest, word === 'np'); return false;
    case 'delete': deleteChannelTyped(s, rest); return false;
    case null:
      s.systemLine('Unknown command. Type /help for help.');
      return false;
    default:
      // shortcut: the remaining CMD_HELP commands (moderation, DMs, threads, pins, pickers) land with P3.
      s.systemLine(NOT_ON_AMIGA[cmd] ?? `/${cmd} is not on Partyline yet.`);
      return false;
  }
}
