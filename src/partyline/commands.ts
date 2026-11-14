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
import { addIgnore, clearPresence, clearRoom, createRoom, deleteMessage, deleteRoom, editMessage, invite, listPins, pin, react, reactionRows, search, threadHistory, unreact, leaveRoom, listIgnores, listRooms, moderate, postDm, postDmGroup, profileOf, removeIgnore, setMode, setOp, setPresence, setRoomMotd, setTopic, whoRows } from '../chat/store';
import { newId } from '../chat/sessions';
import { CMD_HELP } from './ui/slash';
import { stamp } from './ui/screen';
import type { HubScreen } from './ui/screen';

const C_ALIAS: Record<string, string> = { l: 'rooms', list: 'rooms', w: 'who', j: 'join', n: 'create', np: 'create', h: 'help', d: 'msg', 'clear-room': 'clear-room', clearroom: 'clear-room' };
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
  s.systemLine(`Board ${p.board.slice(0, 20)}, ${p.online ? 'online' : 'offline'}, last seen ${stamp(p.lastSeen)}, idle ${p.idle === '' ? 0 : p.idle}s`);
  // room_names_of: the profile carries room ids; the name comes from the room row.
  const names = p.sharedRooms === '' ? [] : s.tryRun(false, (db) => p.sharedRooms.split(',').map((id) => (db.prepare('SELECT name FROM chat_rooms WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id)) ?? [];
  if (names.length > 0) s.systemLine(`Shared rooms: ${names.map((n) => `#${n}`).join(', ').slice(0, 100)}`);
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

/** search_run with the query typed after /search (no modal): room-scoped, 2 characters minimum. */
function searchTyped(s: HubScreen, rest: string): void {
  if (rest.length < 2) { s.systemLine('Search query must be at least 2 characters'); return; }
  const room = s.roomId;
  const rows = s.tryRun(false, (db, ctx) => search(db, ctx, { q: rest, room, limit: 20 }));
  if (!rows) return;
  rows.forEach((r, i) => s.systemLine(`${i + 1}. ${r.user.slice(0, 20)} @ ${stamp(r.at)}: ${r.content.slice(0, 60)}`));
  s.systemLine(`Found ${rows.length} results for "${rest.slice(0, 100)}"`);
}

const onOff = (v: boolean): string => (v ? 'ON' : 'OFF');
const EVENT_KEYS: [string, string[], string, string][] = [
  ['logins', ['login'], 'Login/logout events', 'User Logins/Logouts:    '],
  ['files', ['file'], 'File upload/download events', 'File Uploads/Downloads: '],
  ['doors', ['door'], 'Door activity events', 'Door Activity:          '],
  ['messages', ['message'], 'New message events', 'New Messages:           '],
  ['announcements', ['announcement', 'system'], 'System announcements', 'System Announcements:   '],
];

/** events_typed: the preferences live on the screen for the session (the hub stores no prefs). */
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
    s.systemLine(on ? 'All BBS events enabled' : 'All BBS events disabled');
    return;
  }
  const row = EVENT_KEYS.find(([k, alt]) => k === sub || alt.includes(sub));
  if (!row) { s.systemLine(`Unknown event type: ${sub.slice(0, 30)}`); s.systemLine('Valid types: logins, files, doors, messages, announcements, on, off'); return; }
  ev[row[0]] = !ev[row[0]];
  s.systemLine(`${row[2]}: ${onOff(ev[row[0]])}`);
}

/** sounds_typed: /sounds on|off. */
function soundsTyped(s: HubScreen, rest: string): void {
  const w = firstWord(rest).toLowerCase();
  if (w !== 'on' && w !== 'off') { s.systemLine('Error: Usage: /sounds on|off'); return; }
  s.prefs.sounds = w === 'on';
  s.systemLine(s.prefs.sounds ? 'Sounds enabled' : 'Sounds disabled');
}

/** settings_open without the overlay: the current values as system lines. */
function settingsTyped(s: HubScreen): void {
  s.systemLine('Settings:');
  s.systemLine(`  Timestamps: ${onOff(s.model.timestamps)}  (/timestamps)`);
  s.systemLine(`  Compact mode: ${onOff(s.model.compact)}  (/compact)`);
  s.systemLine(`  Sounds: ${onOff(s.prefs.sounds)}  (/sounds on|off)`);
  s.systemLine('  BBS events: see /events');
}

/** The sidebar "Clear History" action, sysop only; the store checks the owner level. */
function clearRoomTyped(s: HubScreen, rest: string): void {
  const a = firstWord(rest).replace(/^#/, '');
  const hit = a === '' ? undefined : (s.tryRun(false, (db, ctx) => listRooms(db, ctx)) ?? []).find((r) => r.name.toLowerCase() === a.toLowerCase() || r.id === a);
  const id = a === '' ? s.roomId : hit?.id;
  if (!id) { s.systemLine(a === '' ? 'Join a room first.' : `Channel ${a.slice(0, 40)} not found`); return; }
  if (s.tryRun(true, (db, ctx) => { clearRoom(db, ctx, id); return true; })) s.systemLine(`Clear history requested for ${(hit?.name ?? s.model.room).slice(0, 36)}`);
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
    case 'search': searchTyped(s, rest); return false;
    case 'events': eventsTyped(s, rest); return false;
    case 'sounds': soundsTyped(s, rest); return false;
    case 'settings': settingsTyped(s); return false;
    case 'clear-room': clearRoomTyped(s, rest); return false;
    case null:
      s.systemLine('Unknown command. Type /help for help.');
      return false;
    default:
      // shortcut: the remaining CMD_HELP commands (moderation, DMs, threads, pins, pickers) land with P3.
      s.systemLine(NOT_ON_AMIGA[cmd] ?? `/${cmd} is not on Partyline yet.`);
      return false;
  }
}
