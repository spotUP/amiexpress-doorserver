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
import { addIgnore, clearPresence, leaveRoom, listIgnores, listRooms, removeIgnore, setPresence, setTopic, whoRows } from '../chat/store';
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
    case null:
      s.systemLine('Unknown command. Type /help for help.');
      return false;
    default:
      // shortcut: the remaining CMD_HELP commands (moderation, DMs, threads, pins, pickers) land with P3.
      s.systemLine(NOT_ON_AMIGA[cmd] ?? `/${cmd} is not on Partyline yet.`);
      return false;
  }
}
