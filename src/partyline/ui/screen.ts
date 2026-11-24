/**
 * Partyline hub engine: one caller's screen. The model, the draw and the cell
 * diff are the C livechat ports (model.ts, draw.ts, cells.ts); this file feeds
 * them from the chat store the /chat/v1 router uses, so a Partyline caller and
 * a /chat/v1 client read and write the same rooms.
 *
 * Events arrive through events.ts onEvents (told after each commit, like a held
 * poll); the screen then fetches what this session may see since its cursor,
 * the way livechat.c take_events reads a poll reply.
 */
import type Database from 'better-sqlite3';
import { StringDecoder } from 'string_decoder';
import { withAchievementsDb } from '../../achievements/db';
import type { AchievementsConfig } from '../../achievements/config';
import { SurfaceError } from '../../achievements/errors';
import type { ChatConfig } from '../../chat/config';
import { fetchVisibleEvents, headSeq, onEvents } from '../../chat/events';
import type { EventRec } from '../../chat/events';
import { displayLabels } from '../../chat/render';
import { newId, resolveSession } from '../../chat/sessions';
import type { ChatCtx } from '../../chat/sessions';
import { dmThreads, editMessage, getPrefs, joinRoom, listMemberships, listPins, listRooms, memberUsers, postMessage, profileOf, reactionRows, roomHistory, roomMembers, search, setPrefs, setPresence, setTyping, threadHistory } from '../../chat/store';
import type { PartylineScreen, ScreenFactory, ScreenInfo } from '../session';
import { Cells } from './cells';
import { draw, DrawState, HIT_CHAT, HIT_DROPDOWN, HIT_POPUP, HIT_MENU, HIT_SCROLLBAR, HIT_SIDEBAR, HIT_STATUS, HIT_INPUT, MENU_COL, MENU_ITEMS, MENU_LABELS } from './draw';
import { ACTIVITY_LINE, EV_GREEN, EV_RED, EV_YELLOW, EVENT, FOCUS_INPUT, FOCUS_MENU, FOCUS_SIDEBAR, HISTORY, LIVE, mentionsSelf, Model, newLine, newSide, NOTE, SIDE_BLANK, SIDE_DM, SIDE_HEAD, SIDE_ROOM, SIDE_USER, SYSTEM, TEXT_MAX, THEMES, TK_ACCENT_ALT, TK_BAR, TK_DIM, TK_OK } from './model';
import { HIT_FMT, HIT_FMT_CAT, HIT_FMT_CLOSE, HIT_FMT_ITEM, HIT_MODAL, HIT_OK, HIT_SEARCH_Q, HIT_SEARCH_ROW, HIT_SEARCH_USER, HIT_SETTINGS_ROW,
  HIT_THEME_ROW, MODAL_MESSAGE, MODAL_NONE, MODAL_QUIT, formatItems, OverlayState, pickCats, pickList, pickMove,
  SEARCH_MAX, SET_ANNOUNCE, SET_DND, SET_DOORS, SET_FILES, SET_ITEMS, SET_LOGINS, SET_MESSAGES, SET_MUTE, SET_ONLINE, SET_STAMPS, SET_TYPING } from './overlays';
import { CMD_HELP, slashComplete, slashGhost, slashMatch, slashScroll } from './slash';
import { allEmoji, loadCustomEmoji, runCommand } from '../commands';
import { completeAtMention } from './at-complete';
import type { Line } from './model';
import type { AtCycle } from './at-complete';
import { HubMedia } from '../media';

/** ui_key.h codes. */
export const K_UP = 1000, K_DOWN = 1001, K_PGUP = 1002, K_PGDN = 1003, K_HOME = 1004, K_END = 1005, K_ENTER = 1006, K_ESC = 1007,
  K_LEFT = 1008, K_RIGHT = 1009, K_BACKTAB = 1010, K_F1 = 1011, K_F2 = 1012, K_F3 = 1013, K_F4 = 1014, K_F5 = 1015, K_F6 = 1016, K_F7 = 1017, K_DEL = 1020,
  K_SLEFT = 1021, K_SRIGHT = 1022, K_SHOME = 1023, K_SEND = 1024, K_SUP = 1025, K_SDOWN = 1026;
/** livechat.c typing clock (50 ticks/s there): idle tick, TS 400 ms throttle, TYPING_STALE_MS, cursor blink. */
const TICK_MS = 50, TYPING_THROTTLE_MS = 400, TYPING_STALE_MS = 5000, TYPING_BLINK_MS = 530;

const KEY_SEQ: Record<string, number> = {
  '\x1b[A': K_UP, '\x1b[B': K_DOWN, '\x1b[C': K_RIGHT, '\x1b[D': K_LEFT, '\x1b[H': K_HOME, '\x1b[F': K_END,
  '\x1b[5~': K_PGUP, '\x1b[6~': K_PGDN, '\x1bOP': K_F1, '\x1bOS': K_F4, '\x1b[14~': K_F4, '\x1b[Z': K_BACKTAB, '\x1b[1~': K_HOME, '\x1b[4~': K_END,
  '\x1b[3~': K_DEL, '\x1b[15~': K_F5,
  '\x1bOQ': K_F2, '\x1b[12~': K_F2, '\x1bOR': K_F3, '\x1b[13~': K_F3, '\x1b[17~': K_F6, '\x1b[18~': K_F7,
  // xterm shift forms (CSI 1;2X, the board's composed-key.ts) and rxvt's lower-case ones: the input selection (textbox.ts).
  '\x1b[1;2D': K_SLEFT, '\x1b[d': K_SLEFT, '\x1b[1;2C': K_SRIGHT, '\x1b[c': K_SRIGHT, '\x1b[1;2H': K_SHOME, '\x1b[1;2F': K_SEND,
  '\x1b[1;2A': K_SUP, '\x1b[a': K_SUP, '\x1b[1;2B': K_SDOWN, '\x1b[b': K_SDOWN,
};

export type ChatRun = <T>(write: boolean, fn: (db: Database.Database, ctx: ChatCtx) => T) => T;

/** "HH:MM" of a unix second, the C line stamp. */
/** datetime_of: the full local date and time of a unix-seconds stamp. */
function datetime(at: number): string { return new Date(at * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }

export function stamp(at: number): string {
  const d = new Date(at * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class HubScreen implements PartylineScreen {
  readonly model: Model;
  cells: Cells;
  readonly drawState = new DrawState();
  readonly over = new OverlayState();
  /** The room the caller is in (livechat.c room_id); '' before the first join. */
  roomId = '';
  /** Custom emoji with a picture and no ascii face: the picker lists them by :name:, a message cannot expand them. */
  imageEmoji: string[] = [];
  private cursor = 0;
  private readonly off: () => void;

  /** Pictures and files the hub announced this session (livechat.c shared_files[], 1-based /view N). */
  readonly shared: { id: string; name: string; kind: string }[] = [];
  /** /files, /upload and voice (../media.ts). */
  readonly av: HubMedia = new HubMedia(this);
  /** The caller's bytes are UTF-8 (hello charset); latin1 callers keep the byte path. */
  private readonly utf8: boolean;
  /** A UTF-8 glyph can straddle two K frames; the decoder holds the half glyph. */
  private readonly decoder = new StringDecoder('utf8');

  constructor(private readonly ach: AchievementsConfig, private readonly chat: ChatConfig, readonly info: ScreenInfo, readonly filesDir: string | null = null) {
    this.model = new Model(info.hello.cols, info.hello.rows);
    this.cells = new Cells(info.hello.cols, info.hello.rows);
    this.model.handle = info.user;
    this.model.setSelf(info.user);
    this.utf8 = info.hello.charset === 'utf8';
    this.cursor = withAchievementsDb(ach, (db) => headSeq(db));
    this.firstRoom();
    this.prefsLoad();
    this.fillSidebar();
    this.off = onEvents(() => this.take());
    this.tick = setInterval(() => { if (this.typingTick()) this.info.markDirty(); }, TICK_MS);
    this.tick.unref?.();
  }

  /** livechat.c main loop idle clock (typing_tick). */
  private readonly tick: ReturnType<typeof setInterval>;

  /** One store call as this session, in a transaction when it writes (router.ts run). */
  run: ChatRun = (write, fn) => withAchievementsDb(this.ach, (db) => {
    const ctx = resolveSession(db, this.chat, this.info.sid, this.info.boardId);
    return write ? db.transaction(() => fn(db, ctx))() : fn(db, ctx);
  });

  /** A store refusal is a system line (livechat.c show_error), never a dropped caller. */
  tryRun<T>(write: boolean, fn: (db: Database.Database, ctx: ChatCtx) => T): T | undefined {
    try {
      return this.run(write, fn);
    } catch (err) {
      if (!(err instanceof SurfaceError)) throw err;
      this.systemLine(err.message);
      return undefined;
    }
  }

  /** The last message number handed to a pane line (C msg_number); line_by_number looks it up. */
  msgNumber = 0;
  /** /events and /sounds, kept for the session (livechat.c ev_* and snd_on; the hub stores no prefs). */
  readonly prefs = { sounds: true, events: { logins: true, files: true, doors: true, messages: true, announcements: true } as Record<string, boolean> };
  /** livechat.c show_typing (TS showTypingIndicators): never stored, as in the TS door. */
  showTyping = true;

  /** livechat.c prefs_save + pins_save: the TS door's stored keys, merged so other keys (web) survive. */
  prefsSave(): void {
    const ev = this.prefs.events, names = new Map((this.tryRun(false, (db, ctx) => listMemberships(db, ctx)) ?? []).map((r) => [r.roomId, r.name]));
    this.tryRun(true, (db, ctx) => setPrefs(db, ctx, {
      ...getPrefs(db, ctx),
      showLogins: ev.logins, showFileActivity: ev.files, showDoorActivity: ev.doors, showMessages: ev.messages,
      showSystemAnnouncements: ev.announcements, notificationSound: this.prefs.sounds, mentionSound: this.prefs.sounds,
      showTimestamps: this.model.timestamps, compactMode: this.model.compact,
      muteAllEvents: !(ev.logins || ev.files || ev.doors || ev.messages || ev.announcements),
      pinnedChannels: [...this.pinned].map((id) => names.get(id)).filter((n): n is string => n !== undefined),
    }));
  }

  /** livechat.c prefs_load: the stored booleans, then the pinned names mapped to room ids. */
  private prefsLoad(): void {
    const p = this.tryRun(false, (db, ctx) => getPrefs(db, ctx));
    if (!p) return;
    const flag = (k: string, d: boolean): boolean => (typeof p[k] === 'boolean' ? p[k] as boolean : p[k] === '1' ? true : p[k] === '0' ? false : d);
    const ev = this.prefs.events;
    ev.logins = flag('showLogins', ev.logins); ev.files = flag('showFileActivity', ev.files); ev.doors = flag('showDoorActivity', ev.doors);
    ev.messages = flag('showMessages', ev.messages); ev.announcements = flag('showSystemAnnouncements', ev.announcements);
    this.prefs.sounds = flag('notificationSound', this.prefs.sounds);
    this.model.timestamps = flag('showTimestamps', this.model.timestamps);
    this.model.compact = flag('compactMode', this.model.compact);
    const pins = Array.isArray(p.pinnedChannels) ? p.pinnedChannels : typeof p.pinnedChannels === 'string' ? p.pinnedChannels.split(',') : [];
    for (const r of this.tryRun(false, (db, ctx) => listMemberships(db, ctx)) ?? []) if (pins.includes(r.name)) this.pinned.add(r.roomId);
  }

  // ---- livechat.c settings overlay (TS overlays/settings.ts) ----
  settingsOpen(): void {
    const o = this.over, ev = this.prefs.events;
    o.settings = true; o.settingsSel = 0;
    o.settingsVal[SET_LOGINS] = ev.logins; o.settingsVal[SET_FILES] = ev.files; o.settingsVal[SET_DOORS] = ev.doors;
    o.settingsVal[SET_MESSAGES] = ev.messages; o.settingsVal[SET_ANNOUNCE] = ev.announcements;
    o.settingsVal[SET_MUTE] = !this.prefs.sounds; o.settingsVal[SET_TYPING] = this.showTyping; o.settingsVal[SET_STAMPS] = this.model.timestamps;
    const room = this.roomId, self = room !== '' ? this.tryRun(false, (db, ctx) => roomMembers(db, ctx, room).find((u) => this.model.isSelf(u.user))) : undefined;
    o.settingsStatus = Math.max(0, ['online', 'away', 'busy', 'dnd'].indexOf(self?.status ?? 'online'));
  }

  /** settings_close: the boxes become the prefs, then prefs_save. */
  private settingsClose(): void {
    const o = this.over, ev = this.prefs.events, v = o.settingsVal;
    o.settings = false;
    ev.logins = v[SET_LOGINS]; ev.files = v[SET_FILES]; ev.doors = v[SET_DOORS]; ev.messages = v[SET_MESSAGES]; ev.announcements = v[SET_ANNOUNCE];
    this.prefs.sounds = !v[SET_MUTE];
    this.showTyping = v[SET_TYPING];
    if (!this.showTyping) { this.model.typing = []; this.typingAge.clear(); }
    if (this.model.timestamps !== v[SET_STAMPS]) { this.model.timestamps = v[SET_STAMPS]; this.model.linesChanged(); }
    this.prefsSave();
  }

  /** settings_pick: a box toggles, a status applies at once, Close saves and closes. */
  settingsPick(item: number): void {
    const o = this.over;
    if (item < 0 || item >= SET_ITEMS) return;
    o.settingsSel = item;
    if (item <= SET_STAMPS) o.settingsVal[item] = !o.settingsVal[item];
    else if (item <= SET_DND) {
      const status = ['online', 'away', 'busy', 'dnd'][item - SET_ONLINE];
      if (this.tryRun(true, (db, ctx) => setPresence(db, ctx, { status, text: '' })) === undefined) return;
      o.settingsStatus = item - SET_ONLINE;
      this.fillSidebar();
    } else this.settingsClose();
  }

  private settingsKey(k: number): void {
    const o = this.over;
    if (k === K_ESC) this.settingsClose();
    else if (k === K_UP || k === K_BACKTAB) o.settingsSel = (o.settingsSel + SET_ITEMS - 1) % SET_ITEMS;
    else if (k === K_DOWN || k === 9) o.settingsSel = (o.settingsSel + 1) % SET_ITEMS;
    else if (k === 0x20 || k === K_ENTER) this.settingsPick(o.settingsSel);
  }

  // ---- livechat.c search overlay (TS overlays/search.ts) ----
  searchOpen(): void {
    const o = this.over;
    o.search = true; o.searchField = 0; o.searchQ = ''; o.searchUser = ''; o.searchRows = []; o.searchSel = 0; o.searchTop = 0; o.searchIds = []; o.searchRan = '';
  }

  /** search_run: under 2 characters is a system line, else the Results list and "Found N results for ...". */
  private searchRun(): void {
    const o = this.over, room = this.roomId;
    if (o.searchQ.length < 2) { this.systemLine('Search query must be at least 2 characters'); return; }
    const rows = this.tryRun(false, (db, ctx) => search(db, ctx, { q: o.searchQ, room, user: o.searchUser !== '' ? o.searchUser : undefined, limit: SEARCH_MAX }));
    if (!rows) return;
    o.searchRows = rows.slice(0, SEARCH_MAX).map((r, i) => `${i + 1}. ${r.user.slice(0, 20)} @ ${stamp(r.at).slice(0, 24)}: ${r.content.slice(0, 60)}`);
    o.searchIds = rows.slice(0, SEARCH_MAX).map((r) => r.id); o.searchRan = `${o.searchQ}\n${o.searchUser}`;
    o.searchSel = 0; o.searchTop = 0;
    this.systemLine(`Found ${o.searchRows.length} results for "${o.searchQ.slice(0, 100)}"`);
  }

  /** search_key: Esc closes, Tab switches field, Enter in Query searches, arrows move the Results, text edits the field. */
  private searchKey(k: number, ch = String.fromCharCode(k)): void {
    const o = this.over, n = o.searchRows.length, field = o.searchField === 0 ? o.searchQ : o.searchUser;
    const put = (t: string): void => { if (o.searchField === 0) o.searchQ = t; else o.searchUser = t; };
    if (k === K_ESC) o.search = false;
    else if (k === 9 || k === K_BACKTAB) o.searchField = o.searchField === 0 ? 1 : 0;
    else if (k === K_ENTER) { if (n > 0 && o.searchRan === `${o.searchQ}\n${o.searchUser}`) this.searchJump(); else if (o.searchField === 0) this.searchRun(); }
    else if (k === K_DOWN && o.searchSel < n - 1) o.searchSel++;
    else if (k === K_UP && o.searchSel > 0) o.searchSel--;
    else if (k === K_PGDN) o.searchSel = Math.max(0, Math.min(o.searchSel + 10, n - 1));
    else if (k === K_PGUP) o.searchSel = Math.max(0, o.searchSel - 10);
    else if ((k === 8 || k === 127) && field.length > 0) put(field.slice(0, -1));
    else if (k >= 0x20 && k < K_UP && k !== 127 && field.length + 1 < (o.searchField === 0 ? TEXT_MAX : 40)) put(field + ch);
    if (o.searchSel < o.searchTop) o.searchTop = o.searchSel;
  }

  /** Enter on a result of the query on screen (or a second click on it) closes the panel and picks that message. */
  private searchJump(): void {
    const o = this.over, m = this.model, id = o.searchIds[o.searchSel] ?? '';
    if (id === '' || !m.lines.some((l) => l.id === id && l.number !== 0)) { this.systemLine('That message is not in the loaded history.'); return; }
    o.search = false; m.pick = id; m.focus = FOCUS_INPUT;
  }

  // ---- livechat.c theme panel (theme_open/theme_show/theme_close/theme_key; TS overlays/theme-menu.ts) ----
  // shortcut: the pick lives for this session only (the hub has no ae_set_user_theme store yet); add it to the prefs once the store carries a theme.
  private themeId = THEMES[0].id;
  themeOpen(): void {
    const o = this.over, at = Math.max(0, THEMES.findIndex((t) => t.id === this.themeId));
    o.theme = true; o.themeOpened = at; o.themeSel = at;
  }
  /** theme_show: the highlight is the preview, every move re-themes the screen. */
  private themeShow(i: number): void { this.over.themeSel = i; this.model.pal.set(THEMES[i].rgb); this.themeId = THEMES[i].id; }
  private themeClose(keep: boolean): void { if (!keep) this.themeShow(this.over.themeOpened); this.over.theme = false; }
  private themeKey(k: number): void {
    const o = this.over, n = THEMES.length;
    if (k === K_ESC || k === 0x71) this.themeClose(false);
    else if (k === K_ENTER) this.themeClose(true);
    else if (k === K_UP) { if (o.themeSel > 0) this.themeShow(o.themeSel - 1); }
    else if (k === K_DOWN) { if (o.themeSel < n - 1) this.themeShow(o.themeSel + 1); }
    else if (k === K_PGUP) this.themeShow(Math.max(0, o.themeSel - 10));
    else if (k === K_PGDN) this.themeShow(Math.min(n - 1, o.themeSel + 10));
  }

  // ---- livechat.c view window (view_open/view_add): pinned_typed, thread_view; profile_overlay is a message modal ----
  viewOpen(title: string, lines: string[]): void { const o = this.over; o.view = true; o.viewTop = 0; o.viewTitle = title; o.viewText = lines.slice(0, 40); }

  /** pinned_typed: up to 8 pins in the view window. */
  private pinnedView(): void {
    if (!this.roomId) { this.systemLine('Join a room first.'); return; }
    const room = this.roomId, rows = this.tryRun(false, (db, ctx) => listPins(db, ctx, room));
    if (!rows) return;
    if (rows.length === 0) { this.viewOpen('Pinned Messages', ['No pinned messages in this room.', '', '', 'Press ESC to close']); return; }
    const pins = rows.slice(0, 8), t = [`=Pinned Messages (${pins.length}):`, ''];
    pins.forEach((r, i) => t.push(`${i + 1}. ${r.user.slice(0, 24)}: ${r.content.slice(0, 60)}`, `   Sent: ${datetime(r.messageAt)}`,
      `   Pinned by ${r.pinnedBy.slice(0, 20)} on ${datetime(r.at)}`, ''));
    this.viewOpen('Pinned Messages', [...t, '', 'Press ESC to close']);
  }

  /** thread_view: the original message, its time, then the replies. */
  private threadView(id: string): void {
    const rows = this.tryRun(false, (db, ctx) => threadHistory(db, ctx, id));
    if (!rows) return;
    if (rows.length === 0) { this.systemLine('Not found.'); return; }
    const [first, ...replies] = rows, row = (r: typeof first): string => `${r.user.slice(0, 24)}: ${r.text.slice(0, 60)}`;
    const t = ['=Original Message:', row(first), stamp(first.at), ''];
    if (replies.length === 0) t.push('No replies yet. Be the first to reply!');
    else { t.push(`=Replies (${replies.length}):`); replies.slice(0, 20).forEach((r, i) => t.push(`${i + 1}. ${row(r)}`)); }
    this.viewOpen('Thread', [...t, '', 'Press ESC to close']);
  }

  /** profile_overlay: "status: text, online|offline, idle Ns" in a message modal titled with the nick. */
  private profileOverlay(user: string): void {
    const o = this.over, p = this.tryRun(false, (db, ctx) => { try { return profileOf(db, ctx, user); } catch { return null; } });
    if (p === undefined) return;
    o.modal = MODAL_MESSAGE;
    if (p === null) { o.modalTitle = 'Profile'; o.modalText = `User ${user.split('@')[0].slice(0, 40)} not found.`; return; }
    o.modalTitle = p.nick;
    o.modalText = `${p.status.slice(0, 16)}${p.statusText !== '' ? ': ' : ''}${p.statusText.slice(0, 30)}, ${p.online ? 'online' : 'offline'}, idle ${p.idle === '' ? 0 : p.idle}s`;
  }

  /** The slash lines whose LIVECHAT answer is a panel, not chat lines: /theme, /pinned, /thread <id> with no text. */
  private overlayCommand(line: string): boolean {
    const [word, ...rest] = line.trim().split(/\s+/), cmd = word.toLowerCase();
    if (cmd === '/theme' && rest.length === 0) { this.themeOpen(); return true; }
    if (cmd === '/pinned' && rest.length === 0) { this.pinnedView(); return true; }
    if ((cmd === '/thread' || cmd === '/t') && rest.length === 1 && /^\d+$/.test(rest[0])) {
      const l = this.model.lines.find((x) => x.number === Number(rest[0]) && x.id !== '');
      if (l) { this.threadView(l.id); return true; }
    }
    return false;
  }

  // ---- livechat.c D3 typing: the input buffer goes to the hub (leading + trailing edge, 400 ms); others' rows go stale after 5 s ----
  private typingSent = ''; private typingRoom = ''; private typingSeen = '';
  private typingWait = 0; private typingPending = false; private typingBlinkT = 0;
  private readonly typingAge = new Map<string, number>();

  /** livechat.c typing_set: '' removes the row, else the row is set (or added) and its age restarts. */
  typingSet(nick: string, text: string): void {
    const m = this.model;
    nick = nick.slice(0, 24);
    m.typing = m.typing.filter((t) => t.nick !== nick);
    this.typingAge.delete(nick);
    if (text === '') return;
    m.typing.push({ nick, text: text.slice(0, TEXT_MAX) });
    this.typingAge.set(nick, 0);
  }

  private typingSend(text: string): void {
    const room = this.roomId;
    this.tryRun(true, (db, ctx) => setTyping(db, ctx, room, { text }));
    this.typingSent = text; this.typingRoom = room;
    this.typingWait = TYPING_THROTTLE_MS; this.typingPending = false;
  }

  /** livechat.c typing_sync: after each key, the own echo row, then send now (leading edge) or hold (trailing). */
  private typingSync(): void {
    const input = this.model.input;
    if (input === this.typingSeen) return;
    this.typingSeen = input;
    if (this.showTyping) this.typingSet(this.model.handle, input);
    if (this.roomId === '') return;
    if (input === this.typingSent) { this.typingPending = false; return; }
    if (input === '' || this.typingWait <= 0) this.typingSend(input); else this.typingPending = true;
  }

  /** livechat.c typing_tick: trailing edge, stale rows, the cursor blink. True when the frame changed. */
  private typingTick(): boolean {
    let changed = false;
    if (this.typingWait > 0) this.typingWait -= TICK_MS;
    if (this.typingPending && this.typingWait <= 0 && this.roomId !== '') this.typingSend(this.model.input);
    for (const t of [...this.model.typing]) {
      if (this.model.isSelf(t.nick)) continue;
      const age = (this.typingAge.get(t.nick) ?? 0) + TICK_MS;
      this.typingAge.set(t.nick, age);
      if (age >= TYPING_STALE_MS) { this.typingSet(t.nick, ''); changed = true; }
    }
    if (this.model.typing.length > 0 && (this.typingBlinkT += TICK_MS) >= TYPING_BLINK_MS) {
      this.typingBlinkT = 0;
      this.model.typingBlink = !this.model.typingBlink;
      changed = true;
    }
    return changed;
  }

  /** livechat.c typing_stop: the hub hears "stopped" if it still holds a buffer. */
  private typingStop(): void {
    const room = this.typingRoom;
    if (this.typingSent !== '' && room !== '') this.tryRun(true, (db, ctx) => setTyping(db, ctx, room, { text: '' }));
  }

  /** livechat.c typing_reset: room switch. */
  private typingReset(): void {
    this.typingStop();
    this.typingSent = ''; this.typingSeen = ''; this.typingPending = false;
    this.model.typing = []; this.typingAge.clear();
  }

  systemLine(text: string): void { this.note(SYSTEM, text); }
  note(kind: number, text: string): void {
    this.model.addLine(newLine(kind, '', '', text));
    this.info.markDirty();
  }

  /** livechat.c start: the first room the caller is a member of, else the first listed room. */
  private firstRoom(): void {
    const id = this.tryRun(false, (db, ctx) => listMemberships(db, ctx)[0]?.roomId ?? listRooms(db, ctx)[0]?.id ?? '');
    if (id) this.joinRoom(id);
    loadCustomEmoji(this);
  }

  /** livechat.c join_room: switch rooms, clear the lines, say so. */
  joinRoom(id: string): boolean {
    const r = this.tryRun(true, (db, ctx) => joinRoom(db, ctx, id));
    if (!r) return false;
    this.roomId = r.id;
    this.model.room = r.name;
    this.model.paneLabel = r.topic ? `${r.name.slice(0, 40)} - ${r.topic.slice(0, 50)}` : r.name;
    this.model.lines = [];
    this.typingReset();
    this.model.linesChanged();
    this.msgNumber = 0;
    this.cursor = Math.max(this.cursor, r.since);
    this.systemLine(`Joined #${r.name.slice(0, 40)} (${r.members} users)`);
    this.note(ACTIVITY_LINE, `Joined #${r.name.slice(0, 40)}`);
    this.takeHistory(r.id);
    this.fillSidebar();
    return true;
  }

  /**
   * The sidebar the livechat engine used to fill: joined rooms with unreads,
   * then the users in this room. Only marks dirty when something changed,
   * so an unrelated event does not repaint anyone.
   */
  private fillSidebar(): void {
    const m = this.model;
    const data = this.tryRun(false, (db, ctx) => ({
      rooms: listMemberships(db, ctx),
      users: this.roomId !== '' ? roomMembers(db, ctx, this.roomId) : [],
      dms: dmThreads(db, ctx),
    }));
    if (!data) return;
    const sel = m.side[m.sideSel];
    const selKey = sel !== undefined ? `${sel.kind}:${sel.label}` : '';
    const side = [newSide(SIDE_HEAD, false, 'TEXT CHANNELS')];
    // LIVECHAT Pin Channel: pinned channels list first, in their joined order.
    const rooms = [...data.rooms.filter((r) => this.pinned.has(r.roomId)), ...data.rooms.filter((r) => !this.pinned.has(r.roomId))];
    for (const r of rooms) {
      const it = newSide(SIDE_ROOM, r.roomId === this.roomId, r.name.slice(0, 36));
      it.id = r.roomId;
      it.unread = r.unread;
      it.open = this.expanded.get(r.roomId) ?? it.open;
      side.push(it);
    }
    if (data.dms.length > 0) {
      side.push(newSide(SIDE_HEAD, false, 'DIRECT MESSAGES'));
      for (const d of data.dms) {
        const it = newSide(SIDE_DM, false, d.peer.slice(0, 38));
        it.id = d.threadId;
        it.unread = d.unread;
        side.push(it);
      }
    }
    if (data.users.length > 0) {
      side.push(newSide(SIDE_HEAD, false, 'USERS'));
      for (const u of data.users) {
        const it = newSide(SIDE_USER, false, u.user.split('@')[0].slice(0, 38));
        it.note = (u.statusText ?? '').slice(0, 14);
        it.status = u.status === 'online' && u.active ? 0 : 1; // LIVECHAT: a green O only when online and active, else red
        side.push(it);
      }
    }
    const same = (a: typeof side, b: typeof m.side): boolean =>
      a.length === b.length && a.every((s, i) => s.kind === b[i].kind && s.label === b[i].label && s.unread === b[i].unread && s.joined === b[i].joined && s.note === b[i].note && s.status === b[i].status && s.open === b[i].open);
    if (same(side, m.side)) return;
    m.side = side;
    m.sideSel = Math.max(0, side.findIndex((s) => `${s.kind}:${s.label}` === selKey));
    this.info.markDirty();
  }

  /** Session-only channel pins and expand/collapse state (LIVECHAT keeps them in client prefs; the hub stores none). */
  readonly pinned = new Set<string>();
  readonly expanded = new Map<string, boolean>();

  /** livechat.c take_history: the newest HISTORY_LIMIT (30) messages, numbered like live lines so /reply, /edit and /react reach them. */
  private takeHistory(id: string): void {
    const rows = this.tryRun(false, (db, ctx) => roomHistory(db, ctx, id, { limit: 30 })) ?? [];
    if (rows.length === 0) return;
    this.systemLine(`--- ${rows.length} earlier message${rows.length === 1 ? '' : 's'} ---`);
    for (const h of rows) {
      const l = newLine(HISTORY, stamp(h.at), h.user, h.text);
      l.id = h.id;
      l.number = ++this.msgNumber;
      this.model.addLine(l);
    }
    this.info.markDirty();
  }

  /** livechat.c send_room_line: the line goes to the store; the event brings it back on screen. */
  sendRoomLine(text: string, replyTo?: string): string | undefined {
    if (!this.roomId) { this.systemLine('Join a channel first: /join room'); return undefined; }
    return this.tryRun(true, (db, ctx) => postMessage(db, ctx, this.roomId, { content: text, clientId: newId('pl'), ...(replyTo ? { replyTo } : {}) }))?.id;
  }

  /** take_events: the events this session may see since the cursor. */
  take(): void {
    let rows: EventRec[];
    try {
      rows = withAchievementsDb(this.ach, (db) => fetchVisibleEvents(db, this.info.sid, this.info.user, this.cursor, this.info.boardId));
    } catch {
      return; // the database is closing (shutdown): the next commit retries
    }
    if (rows.length === 0) return;
    let side = false;
    for (const e of rows) {
      this.cursor = e.seq;
      this.event(e);
      if (e.type === 'message' || e.type === 'joined' || e.type === 'left' || e.type === 'presence' ||
        e.type === 'room_created' || e.type === 'room_deleted' || e.type === 'dm') side = true;
    }
    if (side) this.fillSidebar();
    this.info.markDirty();
    if (rows.length > 0) this.take();
  }

  private event(e: EventRec): void {
    if (this.av.event(e)) return;
    const inRoom = this.roomId !== '' && e.room_id === this.roomId;
    const m = this.model;
    if (e.type === 'message' && inRoom) {
      const l = newLine(LIVE, stamp(e.at), e.user, e.text);
      l.id = e.ref;
      l.number = ++this.msgNumber; // livechat.c msg_number: the number a user types in /reply, /react ...
      m.addLine(l);
      m.typing = m.typing.filter((t) => t.nick !== e.user);
      if (!m.isSelf(e.user) && mentionsSelf(m, l)) this.sound('mention');
    } else if ((e.type === 'react' || e.type === 'unreact') && inRoom) {
      // livechat.c take_events: a note line, an activity line, then the counts reloaded from the store.
      const who = this.shown(e).slice(0, 24), emoji = e.text.slice(0, 16);
      m.addLine(newLine(NOTE, '', '', e.type === 'react' ? `[${who} reacted ${emoji}]` : `[${who} removed ${emoji}]`));
      m.addLine(newLine(ACTIVITY_LINE, '', '', `${who}: ${emoji}`));
      const l = m.lines.find((x) => x.id === e.ref);
      const rows = l ? this.tryRun(false, (db, ctx) => reactionRows(db, ctx, e.ref)) : undefined;
      if (l && rows) { l.react = rows.filter((r) => r.count > 0).map((r) => ({ emoji: r.emoji, count: r.count })); m.linesChanged(); }
    } else if (e.type === 'typing' && inRoom && !m.isSelf(e.user)) {
      // livechat.c typing_set: the buffer replaces the row, an empty buffer removes it.
      if (this.showTyping) this.typingSet(e.user, e.text);
    } else if (e.type === 'dm' && !m.isSelf(e.user)) {
      const group = e.label.startsWith('dg'), who = this.shown(e).slice(0, 24);
      m.addLine(newLine(NOTE, '', '', `[${group ? 'Group DM' : 'DM'} from ${who}]: ${e.text.slice(0, 200)}`));
      m.addLine(newLine(ACTIVITY_LINE, '', '', `${group ? 'Group DM' : 'DM'} from ${who}`));
      this.sound('dm');
    } else if (e.type === 'bbs') {
      this.takeBbsEvent(e);
    } else if ((e.type === 'joined' || e.type === 'left') && inRoom) {
      const joined = e.type === 'joined', who = this.shown(e).slice(0, 24);
      m.addLine(newLine(SYSTEM, '', '', `${who} ${joined ? 'joined' : 'left'} the room`));
      m.addLine(newLine(ACTIVITY_LINE, '', '', `${who} ${joined ? 'joined' : 'left'}`));
    } else if (e.type === 'edit') {
      const l = m.lines.find((x) => x.id === e.ref);
      if (l) { l.text = e.text; l.edited = true; m.linesChanged(); }
    } else if (e.type === 'delete') {
      const i = m.lines.findIndex((x) => x.id === e.ref);
      if (i >= 0) { m.lines.splice(i, 1); m.linesChanged(); }
    } else if (e.type === 'file_shared') {
      // livechat.c shared_add: text is "name|size|kind", the ref is the file id; only a picture says anything.
      const [name = '', , kind = ''] = e.text.split('|');
      if (e.ref && this.shared.length < 64) {
        this.shared.push({ id: e.ref, name: name.slice(0, 63), kind: kind.slice(0, 11) });
        if (kind === 'image') m.addLine(newLine(SYSTEM, '', '', `${e.user.slice(0, 30)} shared a picture: ${name.slice(0, 60)} (/view)  #${this.shared.length} [PICTURE] ${name.slice(0, 60)}`));
      }
    } else if (e.type === 'topic' && inRoom) {
      m.paneLabel = `${m.room.slice(0, 40)} - ${e.text.slice(0, 50)}`;
      m.addLine(newLine(SYSTEM, '', '', `${(e.user || 'Someone').slice(0, 24)} set the topic: ${e.text.slice(0, 200)}`));
    }
  }

  /** livechat.c `shown` (EVENTS index 9): the D7 display label, the bare handle unless two users in the room share it. */
  private shown(e: EventRec): string {
    const users = this.tryRun(false, (db) => memberUsers(db, [e.room_id ?? ''])) ?? [];
    return displayLabels([e.user, ...users]).get(e.user) ?? e.user;
  }

  /** LIVECHAT sounds.ts: a cue when /sounds is on. */
  private sound(cue: string): void { if (this.prefs.sounds) this.info.sound?.(cue); }

  /** livechat.c take_bbs_event: the board's login, file, door and notice events, gated by /events. */
  private takeBbsEvent(e: EventRec): void {
    const type = e.ref, user = e.user, node = e.label.slice(0, 6), q = new URLSearchParams(e.text), m = this.model;
    if (user === 'Guest') return;
    const pref = type === 'user_login' || type === 'user_logout' ? 'logins' : type === 'upload' || type === 'download' ? 'files'
      : type === 'door_activity' || type === 'custom_door_event' ? 'doors' : type === 'system_notice' ? 'announcements' : '';
    if (pref !== '' && !this.prefs.events[pref]) return;
    const add = (time: string, tone: number, head: string, bodyTone: number, body: string, pb = false): void => {
      const l = newLine(EVENT, time, '', body);
      l.head = head; l.tone = tone; l.bodyTone = bodyTone; l.pb = pb;
      m.addLine(l);
    };
    const login = type === 'user_login', at = stamp(e.at), head = `* ${user.slice(0, 40)}`;
    if (login || type === 'user_logout') {
      const body = login ? `${user.slice(0, 30)} has logged in (Node ${node})` : `${user.slice(0, 30)} has logged off`;
      add('', TK_DIM, '[EVENT] ', login ? EV_GREEN : EV_RED, body);
      m.addLine(newLine(SYSTEM, '', '', body));
    }
    if (login) add(at, TK_OK, head, 0, ` logged in from ${(q.get('location') || 'Unknown').slice(0, 120)} (Node ${node})`);
    else if (type === 'user_logout') {
      const d = parseInt(q.get('duration') ?? '0', 10) || 0;
      add(at, TK_ACCENT_ALT, head, 0, ` logged out${d !== 0 ? ` after ${Math.trunc(d / 60)}m ${d % 60}s` : ''} (Node ${node})`);
    } else if (type === 'upload' || type === 'download') {
      const up = type === 'upload', n = parseInt(q.get('fileSize') ?? '0', 10) || 0, c = (q.get('conferenceName') ?? '').slice(0, 80);
      const t = Math.trunc((n * 10 + 512) / 1024), kb = n > 0 ? ` (${Math.trunc(t / 10)}.${t % 10}KB)` : '';
      add(at, up ? TK_BAR : TK_ACCENT_ALT, head, 0, ` ${up ? 'uploaded' : 'downloaded'} ${(q.get('fileName') ?? '').slice(0, 100)}${kb}${c === '' ? '' : up ? ' to ' : ' from '}${c}`);
    } else if (type === 'system_notice') {
      const msg = q.get('message') ?? '';
      if (msg !== '') { m.addLine(newLine(SYSTEM, '', '', `*** ${msg.slice(0, 180)} ***`)); this.sound('notification'); }
    } else if (type === 'door_activity') {
      const entered = q.get('action') === 'entered';
      add(at, entered ? EV_GREEN : EV_YELLOW, head, 0, ` ${entered ? 'entered' : 'exited'} door ${(q.get('doorName') ?? '').slice(0, 120)}`);
    } else if (type === 'custom_door_event') {
      const door = q.get('doorName') ?? '', ev = q.get('eventType') || 'event', msg = q.get('message') ?? '';
      const score = ev === 'score' || ev === 'score_submitted', has = (...w: string[]): boolean => w.some((x) => ev.includes(x));
      // livechat_ui.h LC_EV_BLUE 4, LC_EV_CYAN 6, LC_EV_WHITE 7: raw colour numbers the palette passes through.
      let tone = score ? EV_YELLOW : has('create', 'add', 'new') ? EV_GREEN : has('delete', 'remove') ? EV_RED : has('complete', 'done', 'finish') ? 4
        : has('achievement', 'unlock') ? EV_YELLOW : has('update', 'edit', 'move') ? 6 : 7;
      if (ev === 'match_result') tone = TK_ACCENT_ALT;
      add(at, tone, `[${(door || 'Unknown').slice(0, 40)}]`, 0, ` ${user.slice(0, 30)}${ev === 'match_result' ? ' ' : ': '}${(msg || 'No message').slice(0, 150)}`,
        score && q.get('isPersonalBest') === 'true');
    } else add(at, TK_DIM, `* Unknown event: ${type.slice(0, 20)}`, 0, '');
  }

  resize(cols: number, rows: number): void {
    this.model.resize(cols, rows);
    this.cells = new Cells(cols, rows);
  }

  private esc = '';

  /** Bytes to keys (ui_key.h codes): ESC [ A..D, ESC [5~ / [6~, H / F, CR, BS/DEL, Tab, printable latin1. */
  input(bytes: Buffer): void {
    if (this.utf8) {
      // Text goes through the UTF-8 decoder; ESC and any bytes while an ESC
      // sequence is open stay raw so legacy X10 mouse coordinates (which can
      // carry high bytes) still reach the byte-level mouse parser.
      let at = 0;
      while (at < bytes.length && !this.quitting) {
        if (this.esc !== '' || bytes[at] === 0x1b) {
          this.inputByte(bytes[at++]);
          continue;
        }
        let end = at;
        while (end < bytes.length && bytes[end] !== 0x1b) end++;
        for (const ch of this.decoder.write(bytes.subarray(at, end))) {
          const cp = ch.codePointAt(0) as number;
          if (cp < 0x80) this.inputByte(cp);
          else this.insertChar(ch);
          if (this.quitting) break;
        }
        at = end;
      }
    } else this.inputBytes(bytes);
    if (!this.quitting) this.typingSync();
    this.info.markDirty();
  }

  /** One non-ASCII glyph straight into the input line (no ESC decoding up here). */
  private insertChar(ch: string): void {
    const m = this.model, o = this.over;
    if (o.search) { this.searchKey(ch.codePointAt(0) as number, ch); return; }
    if (o.modal !== MODAL_NONE || o.fmt || o.help || o.settings || o.theme || o.view) return;
    if (m.focus === FOCUS_INPUT) this.slashKey(ch.codePointAt(0) as number);
    this.cutSelection();
    if (m.input.length + ch.length < TEXT_MAX) {
      m.input = m.input.slice(0, m.inputCur) + ch + m.input.slice(m.inputCur);
      m.inputCur += ch.length;
      o.slashOff = false;
    }
  }

  private inputBytes(bytes: Buffer): void {
    for (const b of bytes) {
      this.inputByte(b);
      if (this.quitting) return;
    }
    this.info.markDirty();
  }

  /** One byte through the ESC machine and into key(). */
  private inputByte(b: number): void {
    if (this.esc !== '') {
      // X10 mouse (\x1b[M Cb Cx Cy): old terminals answer without SGR even
      // after ?1006h; swallow the report as a click instead of typing it.
      if (this.esc[1] === '[' && this.esc[2] === 'M') {
        if (b === 0x1b) { this.esc = '\x1b'; return; }
        this.esc += String.fromCharCode(b);
        if (this.esc.length < 6) return;
        const [cb, cx, cy] = [...this.esc].map((c) => c.charCodeAt(0)).slice(-3);
        this.esc = '';
        this.legacyMouse(cb, cx - 32, cy - 32, false);
        return;
      }
      // urxvt mouse (\x1b[Cb;Cx;Cy M|m): same treatment on the M terminator.
      if (b === 0x4d || b === 0x6d) {
        const m = /^\x1b\[(\d+);(\d+);(\d+)$/.exec(this.esc);
        if (m) {
          this.esc = '';
          this.legacyMouse(Number(m[1]), Number(m[2]), Number(m[3]), b === 0x6d);
          return;
        }
      }
      this.esc += String.fromCharCode(b);
      if (this.esc.startsWith('\x1b[<')) { // SGR mouse report ESC [ < button ; col ; row M|m
        if (b === 0x4d || b === 0x6d) { const e = this.esc; this.esc = ''; this.mouse(e, b === 0x4d); } else if (this.esc.length > 24) this.esc = '';
        return;
      }
      const k = KEY_SEQ[this.esc];
      // A urxvt mouse report (\x1b[Cb;Cx;Cy M) is longer than the key
      // sequences the drop below assumes; while it still parses as digits
      // and semicolons, wait for its M terminator instead of dropping it.
      if (k === undefined && /^\x1b\[\d+(;\d*){0,2}$/.test(this.esc) && this.esc.length <= 16) return;
      if (k !== undefined) { this.esc = ''; this.key(k); } else if (this.esc.length >= 4 || (this.esc.length >= 2 && this.esc[1] !== '[' && this.esc[1] !== 'O')) {
        // shortcut: an unknown sequence is dropped whole; a lone Esc is seen only when the next byte is not '['.
        const lone = this.esc.length === 2 && this.esc[1] !== '[' && this.esc[1] !== 'O';
        this.esc = '';
        if (lone) { this.key(K_ESC); this.input(Buffer.from([b])); }
      }
      return;
    }
    if (b === 0x1b) { this.esc = '\x1b'; return; }
    this.key(b === 0x0d ? K_ENTER : b === 0x7f ? 8 : b);
  }

  /**
   * X10 and urxvt both carry Cb = 32 + button (+ modifier/motion bits); low bits 3 without
   * the motion bit is a release. Re-spelled as the SGR report mouse() reads.
   */
  private legacyMouse(cb: number, col: number, row: number, release: boolean): void {
    const button = cb - 32;
    const up = release || (button & 0x63) === 3;
    this.mouse(`\x1b[<${button};${col};${row}${up ? 'm' : 'M'}`, !up);
  }

  private quitting = false;

  /** handle_key: modal quit, help, the "/" menu, then the line editor. */
  key(k: number): void {
    const m = this.model, o = this.over;
    if (o.modal === MODAL_QUIT) {
      if (k === 0x79 || k === 0x59 || k === K_ENTER) { this.quit(); return; }
      if (k === 0x6e || k === 0x4e || k === K_ESC) o.modal = MODAL_NONE;
      return;
    }
    if (k === 17) { o.modal = MODAL_QUIT; o.modalTitle = 'Quit'; o.modalText = 'Leave the chat?'; return; }
    if (o.fmt) { this.pickKey(k); return; }
    if (o.modal === MODAL_MESSAGE) { if (k === K_ENTER || k === K_ESC || k === 0x20) o.modal = MODAL_NONE; return; }
    if (o.theme) { this.themeKey(k); return; }
    if (o.settings) { this.settingsKey(k); return; }
    if (o.search) { this.searchKey(k); return; }
    if (o.view) {
      if (k === K_ESC || k === 0x71) o.view = false;
      else if (k === K_DOWN && o.viewTop < o.viewText.length - 1) o.viewTop++;
      else if (k === K_UP && o.viewTop > 0) o.viewTop--;
      return;
    }
    if (o.help) {
      if (k === K_ESC || k === 0x71) o.help = false;
      else if (k === K_DOWN) o.helpTop++;
      else if (k === K_UP && o.helpTop > 0) o.helpTop--;
      return;
    }
    if (m.popup) { this.popupKey(k); return; }
    if (m.focus === FOCUS_MENU && this.menuKey(k)) return;
    if (m.focus === FOCUS_SIDEBAR && this.sideKey(k)) return;
    if (m.pick !== '' && this.pickLineKey(k)) return;
    if (m.focus === FOCUS_INPUT && this.slashKey(k)) return;
    if (k === 9 || k === K_BACKTAB) { this.tabKey(k === K_BACKTAB); return; }
    if (k === K_F2) { this.toggleSidebar(); return; }
    if (k === K_F3) { this.switchSideView(); return; }
    const fk = k === K_F6 ? 'Files' : k === K_F7 ? 'Pins' : k === 19 ? 'Settings' : k === 6 ? 'Search' : '';
    if (fk !== '') { this.menuAction(fk); return; } // LIVECHAT F6 / F7 / Ctrl+S / Ctrl+F
    if (k === 1) { // LIVECHAT Ctrl+A: select the whole input
      m.inputAnchor = 0; m.inputCur = m.input.length;
      this.keyboardSelecting = true; this.lastKeyTime = Date.now();
      this.selectSoon();
      return;
    }
    if (k === K_UP || k === K_DOWN) { this.historyKey(k === K_UP); return; }
    if (k === K_F4 || k === 5) { this.openPicker(); return; }
    if (k === K_F1) { o.help = true; o.helpTop = 0; return; }
    if (k === K_PGUP) { m.scroll += 10; return; }
    if (k === K_PGDN) { m.scroll = Math.max(0, m.scroll - 10); return; }
    if (k === K_ENTER) { this.submit(); return; }
    if (k >= K_SLEFT && k <= K_SDOWN) { // textbox.ts: shift extends the selection from where the cursor stood
      if (m.inputAnchor < 0) m.inputAnchor = m.inputCur;
      if (k === K_SLEFT) m.inputCur = Math.max(0, m.inputCur - 1);
      else if (k === K_SRIGHT) m.inputCur = Math.min(m.input.length, m.inputCur + 1);
      else m.inputCur = k === K_SHOME || k === K_SUP ? 0 : m.input.length; // one line: up/down reach its ends
      this.keyboardSelecting = true; this.lastKeyTime = Date.now();
      this.selectSoon();
      return;
    }
    if (k === K_F5) { this.openFormat(); return; }
    if ((k === K_LEFT || k === K_RIGHT) && this.keyboardSelecting && m.inputAnchor >= 0 && Date.now() - this.lastKeyTime < 150) {
      // textbox.ts _shouldClearSelection: a plain arrow inside 150ms of a shift arrow is a dropped shift, so it extends.
      m.inputCur = Math.max(0, Math.min(m.input.length, m.inputCur + (k === K_LEFT ? -1 : 1)));
      this.lastKeyTime = Date.now();
      this.selectSoon();
      return;
    }
    if (k === K_LEFT || k === K_RIGHT || k === K_HOME || k === K_END || k === K_ESC) this.clearSelection();
    if (k === K_LEFT) { if (m.inputCur > 0) m.inputCur--; return; }
    if (k === K_RIGHT) { if (m.inputCur < m.input.length) m.inputCur++; return; }
    if (k === K_HOME) { m.inputCur = 0; return; }
    if (k === K_END) { m.inputCur = m.input.length; return; }
    if (k === 8 || k === K_DEL) {
      if (this.cutSelection()) { o.slashOff = false; return; }
      if (k === K_DEL) { if (m.inputCur < m.input.length) m.input = m.input.slice(0, m.inputCur) + m.input.slice(m.inputCur + 1); }
      else if (m.inputCur > 0) { m.input = m.input.slice(0, m.inputCur - 1) + m.input.slice(m.inputCur); m.inputCur--; }
      o.slashOff = false;
      return;
    }
    if (k >= 0x20 && k < 0x100) this.cutSelection();
    if (k >= 0x20 && k < 0x100 && m.input.length < TEXT_MAX) {
      m.input = m.input.slice(0, m.inputCur) + String.fromCharCode(k) + m.input.slice(m.inputCur);
      m.inputCur++;
      o.slashOff = false;
    }
  }

  /** emoji_show: the picker over the chat, on the first category. */
  openPicker(): void {
    const o = this.over;
    o.fmt = true; o.pickFmt = false; o.pickItems = allEmoji(this); o.pickCat = o.pickItem = o.pickTop = o.pickPane = 0;
  }

  /** LIVECHAT openFormatPicker: with text selected, the format picker over the chat; the selection is kept to wrap on apply. */
  openFormat(): void {
    const m = this.model, o = this.over;
    this.selectTimer = clearTimeout(this.selectTimer) as undefined;
    if (m.inputAnchor < 0 || m.inputAnchor === m.inputCur || o.fmt) return;
    const start = Math.min(m.inputAnchor, m.inputCur), end = Math.max(m.inputAnchor, m.inputCur);
    o.pickSel = { start, end, text: m.input.slice(start, end) };
    o.fmt = true; o.pickFmt = true; o.pickItems = formatItems(); o.pickCat = o.pickItem = o.pickTop = o.pickPane = 0;
  }

  /** textbox.ts: a keyboard selection opens the format picker once the keys rest (LIVECHAT inputBox 'select'). */
  private selectSoon(): void {
    clearTimeout(this.selectTimer);
    this.selectTimer = setTimeout(() => { this.selectTimer = undefined; this.openFormat(); this.info.markDirty(); }, 500);
    this.selectTimer.unref?.();
  }

  private selectTimer: ReturnType<typeof setTimeout> | undefined;
  private inputDrag = false;

  private clearSelection(): void {
    this.model.inputAnchor = -1;
    this.keyboardSelecting = false;
    this.selectTimer = clearTimeout(this.selectTimer) as undefined;
  }

  /** Deletes the selected text, the cursor at its start; false with nothing selected. */
  private cutSelection(): boolean {
    const m = this.model, a = m.inputAnchor;
    if (a < 0 || a === m.inputCur) { this.clearSelection(); return false; }
    const start = Math.min(a, m.inputCur), end = Math.max(a, m.inputCur);
    m.input = m.input.slice(0, start) + m.input.slice(end);
    m.inputCur = start;
    this.clearSelection();
    return true;
  }

  /** fmt_key: the picker owns every key while it is shown; Enter on an item inserts its code and a space (emoji_apply). */
  private pickKey(k: number): void {
    const m = this.model, o = this.over;
    if (k === K_UP || k === 0x6b) pickMove(o, -1);
    else if (k === K_DOWN || k === 0x6a) pickMove(o, 1);
    else if (k === 9 || k === K_BACKTAB) o.pickPane ^= 1;
    else if (k === K_ESC) o.fmt = false;
    else if (k === K_ENTER) {
      if (o.pickPane === 0) { o.pickPane = 1; return; }
      this.pickApply();
    }
  }

  /** emoji_apply: close the picker and append the selected code and a space to the input. */
  private pickApply(): void {
    const m = this.model, o = this.over;
    o.fmt = false;
    const e = pickList(o)[o.pickItem];
    if (!e) return;
    if (o.pickFmt && e.wrap) { // LIVECHAT applyFormat: the snapshot if the input still holds it there, else the first match
      const { start: s0, end, text } = o.pickSel;
      const start = m.input.slice(s0, end) === text ? s0 : m.input.indexOf(text);
      if (start < 0) return;
      const wrapped = e.wrap(text);
      m.input = m.input.slice(0, start) + wrapped + m.input.slice(start + text.length);
      m.inputCur = start + wrapped.length;
      this.clearSelection();
      return;
    }
    if (m.input.length + e.code.length + 1 >= TEXT_MAX) { this.systemLine('The emoji does not fit the input'); return; }
    m.input = `${m.input}${e.code} `;
    m.inputCur = m.input.length;
  }

  /** The mouse (livechat.c): a wheel step moves the chat three lines; with the picker on top a left press selects, a press on the
   *  selected row or category enters it, [X] closes, and a left press outside closes. Releases and motion carry nothing. */
  private mouse(seq: string, press: boolean): void {
    const f = /^\x1b\[<(\d+);(\d+);(\d+)$/.exec(seq.slice(0, -1));
    if (!f) return;
    const b = Number(f[1]), m = this.model, o = this.over, d = this.drawState;
    const row = Number(f[3]) - 1, col = Number(f[2]) - 1;
    if (b >= 64) {
      if (b >= 66) return;
      const up = b === 64;
      if (d.hits.at(row, col).id === HIT_SIDEBAR) { this.sideMove(up ? -2 : 2); this.sideJoin(); }
      else m.scroll = Math.max(0, Math.min(d.barRows > 0 ? d.barSpan : 0, m.scroll + (up ? 3 : -3)));
      return;
    }
    if (this.barDrag) { // the thumb follows the pointer until the button comes up
      if (!press) this.barDrag = false;
      else if (b >= 32) { if ((b & 3) !== 3) { const sc = d.scrollAt(row); if (sc >= 0) m.scroll = sc; } else this.barDrag = false; }
      if (!(press && b < 32)) return;
      this.barDrag = false;
    }
    if (this.inputDrag) { // textbox.ts mousemove/mouseup: the drag extends the selection; a release with text selected opens the format picker
      if (b >= 32 && press) { m.inputCur = this.inputAt(col); return; }
      if (!press) {
        this.inputDrag = false;
        m.inputCur = this.inputAt(col);
        if (m.inputAnchor === m.inputCur) m.inputAnchor = -1; else this.openFormat();
        return;
      }
      this.inputDrag = false;
    }
    if (b >= 32 && (b & 3) === 3 && !o.fmt) { // ?1003 motion while a menu is open: LIVECHAT hover moves between menus and rows
      const h = d.hits.at(row, col);
      if (m.menu >= 0 && h.id === HIT_MENU) {
        const k = MENU_COL.findIndex((c, i) => col >= c && col < c + MENU_LABELS[i].length);
        if (k >= 0 && k !== m.menu) { m.menu = k; m.menuSel = 0; }
      } else if (m.menu >= 0 && h.id === HIT_DROPDOWN) m.menuSel = h.dr;
      else if (m.popup && h.id === HIT_POPUP && m.popup.items[h.dr] !== '---') m.popup.sel = h.dr;
      return;
    }
    if (!press || b >= 32) return;
    if (!o.fmt) { this.mousePress(row, col, b & 3); return; }
    const h = d.hits.at(row, col), button = b & 3;
    if (h.id === HIT_FMT_CLOSE) { o.fmt = false; return; }
    if (h.id === HIT_FMT_CAT && h.dr < pickCats(o).length) {
      if (h.dr === o.pickCat) { o.pickPane = 1; return; }
      o.pickPane = 0; pickMove(o, h.dr - o.pickCat);
    } else if (h.id === HIT_FMT_ITEM) {
      const item = h.dr + o.pickTop;
      if (item >= pickList(o).length) return;
      if (o.pickPane === 1 && item === o.pickItem) { this.pickApply(); return; }
      o.pickPane = 1; pickMove(o, item - o.pickItem);
    } else if (h.id !== HIT_FMT && button === 0) o.fmt = false;
  }

  private barDrag = false;

  /** side_move: step the sidebar selection over rows that are not headings or blanks. */
  private sideMove(step: number): void {
    const m = this.model, ok = (i: number): boolean => i >= 0 && i < m.side.length && m.side[i].kind !== SIDE_HEAD && m.side[i].kind !== SIDE_BLANK;
    let i = m.sideSel + step;
    while (i >= 0 && i < m.side.length && !ok(i)) i += step;
    if (ok(i)) m.sideSel = i;
  }

  /** handle_mouse for a press with no picker on top: context popup, menu bar, dropdown, status line, input, scrollbar,
   *  chat (right-click menu) and sidebar (rooms join, users open their menu, right-click opens either menu). */
  private mousePress(row: number, col: number, button: number): void {
    const m = this.model, o = this.over, h = this.drawState.hits.at(row, col);
    if (o.modal === MODAL_MESSAGE) { if (h.id === HIT_OK || h.id !== HIT_MODAL) o.modal = MODAL_NONE; return; }
    if (o.theme) { if (h.id === HIT_THEME_ROW && o.themeFirst + h.dr < THEMES.length) this.themeShow(o.themeFirst + h.dr); return; }
    if (o.settings) { if (h.id === HIT_SETTINGS_ROW && h.dr < 64 && o.setItemAt[h.dr] >= 0) this.settingsPick(o.setItemAt[h.dr]); return; }
    if (o.search) { // a click on a field focuses it; a click on a result selects it, a second click on the selected one jumps
      const k = o.searchTop + h.dr;
      if (h.id === HIT_SEARCH_Q) o.searchField = 0;
      else if (h.id === HIT_SEARCH_USER) o.searchField = 1;
      else if (h.id === HIT_SEARCH_ROW && k < o.searchRows.length) { if (k === o.searchSel) this.searchJump(); else o.searchSel = k; }
      return;
    }
    if (o.modal !== MODAL_NONE || o.help || o.view) return;
    if (m.popup) { // LIVECHAT context menu: a click on a row picks it, a click elsewhere closes it
      if (h.id === HIT_POPUP) this.popupPick(h.dr); else this.popupClose();
      return;
    }
    if (h.id === HIT_MENU) {
      const k = MENU_COL.findIndex((c, i) => col >= c && col < c + MENU_LABELS[i].length);
      if (k >= 0) { m.menu = k; m.menuSel = 0; m.focus = FOCUS_MENU; return; }
    }
    if (h.id === HIT_DROPDOWN && m.menu >= 0 && h.dr < MENU_ITEMS[m.menu].length) {
      const it = MENU_ITEMS[m.menu][h.dr];
      m.menu = -1; m.focus = FOCUS_INPUT;
      this.menuAction(it);
      return;
    }
    if (m.focus === FOCUS_MENU) { m.menu = -1; m.focus = FOCUS_INPUT; }
    if (h.id === HIT_STATUS) m.sidebarHidden = false;
    else if (h.id === HIT_INPUT) {
      m.focus = FOCUS_INPUT;
      const d = this.drawState;
      if (button === 2) { this.openFormat(); return; } // LIVECHAT: right-click with text selected
      if (button !== 0) return;
      if (d.inputW < this.cells.cols && col >= d.inputW) { this.openPicker(); return; } // the :D button
      this.clearSelection();
      m.inputCur = m.inputAnchor = this.inputAt(col); // textbox.ts mousedown: cursor and selection start at the click
      this.inputDrag = true;
    }
    else if (h.id === HIT_SCROLLBAR) {
      const sc = this.drawState.scrollAt(row);
      if (sc >= 0) m.scroll = sc;
      this.barDrag = button === 0;
    } else if (h.id === HIT_CHAT && button === 2) {
      const r = row - this.drawState.chatBody, li = r >= 0 && r < this.drawState.chatRowLine.length ? this.drawState.chatRowLine[r] : -1;
      const line = li >= 0 ? m.lines[li] : undefined;
      if (line && line.number > 0) this.popupOpen(['Reply', 'React', '---', 'Copy Text', 'Pin Message', '---', 'Mark Unread', 'Edit', 'Delete'], row, col, { line });
      else this.systemLine('Right-click on a message first.');
    } else if (h.id === HIT_SIDEBAR && h.dr < m.side.length && m.side[h.dr].kind !== SIDE_HEAD && m.side[h.dr].kind !== SIDE_BLANK) {
      m.sideSel = h.dr;
      const it = m.side[h.dr];
      if (it.kind === SIDE_USER || button === 2) this.sideMenu(row, col); // LIVECHAT: selecting a user opens the user menu
      else this.sideJoin();
    }
  }

  /** Sent lines; a room line keeps its message id so a recalled line edits that message (LIVECHAT Up-arrow edit). */
  private history: { text: string; id?: string }[] = [];
  private histPos = -1;
  private histSaved = '';
  private atCycle: AtCycle | null = null;
  private keyboardSelecting = false;
  private lastKeyTime = 0;
  private anyMotion = false;
  private osc = '';
  private popupCtx: { line?: Line; user?: string; roomId?: string } = {};

  /** LIVECHAT input history (100 lines): Up on an empty line picks a message, else Up/Down step through sent lines. */
  private historyKey(up: boolean): void {
    const m = this.model;
    if (up) {
      if (m.input === '' && this.histPos < 0) { m.pickStart(); return; }
      if (this.history.length === 0) return;
      if (this.histPos < 0) { this.histSaved = m.input; this.histPos = this.history.length; }
      if (this.histPos > 0) this.histPos--;
      m.input = this.history[this.histPos].text; m.editing = true;
    } else {
      if (this.histPos < 0) return;
      if (++this.histPos >= this.history.length) { this.histPos = -1; m.input = this.histSaved; m.editing = false; } else m.input = this.history[this.histPos].text;
    }
    m.inputCur = m.input.length;
    this.clearSelection();
  }

  /** LIVECHAT message pick: Up/Down step, Enter replies to the picked message, Esc leaves; other keys leave and type. */
  private pickLineKey(k: number): boolean {
    const m = this.model;
    if (k === K_UP || k === K_DOWN) { m.pickMove(k === K_UP ? -1 : 1); return true; }
    if (k === K_ENTER) { const l = m.lines[m.pickIndex()]; m.pickStop(); if (l) this.fillInput(`/reply ${l.number} `); return true; }
    m.pickStop();
    return k === K_ESC;
  }

  /** LIVECHAT Tab: complete @name first, else move focus input, sidebar, menu bar (Shift+Tab goes back). */
  private tabKey(back: boolean): void {
    const m = this.model;
    if (!back && m.focus === FOCUS_INPUT) {
      const r = completeAtMention(m.input, this.userNames(), this.atCycle);
      if (r) { m.input = r.value; m.inputCur = r.value.length; this.atCycle = r.cycle; this.clearSelection(); return; }
    }
    const order = m.sidebarWidth() > 0 ? [FOCUS_INPUT, FOCUS_SIDEBAR, FOCUS_MENU] : [FOCUS_INPUT, FOCUS_MENU];
    const next = order[(Math.max(0, order.indexOf(m.focus)) + (back ? order.length - 1 : 1)) % order.length];
    m.focus = next; m.menu = next === FOCUS_MENU ? 0 : -1; m.menuSel = 0;
    if (next === FOCUS_SIDEBAR && m.side[m.sideSel]?.kind !== SIDE_ROOM && m.side[m.sideSel]?.kind !== SIDE_USER) { m.sideSel = -1; this.sideMove(1); if (m.sideSel < 0) m.sideSel = 0; }
  }

  private userNames(): string[] { return this.model.side.filter((s) => s.kind === SIDE_USER).map((s) => s.label); }

  /** LIVECHAT menu bar keys: Left/Right change menu, Up/Down the row, Enter runs it, Esc closes. */
  private menuKey(k: number): boolean {
    const m = this.model, n = MENU_ITEMS.length;
    if (m.menu < 0) m.menu = 0;
    if (k === K_LEFT || k === K_RIGHT) { m.menu = (m.menu + (k === K_LEFT ? n - 1 : 1)) % n; m.menuSel = 0; return true; }
    if (k === K_UP || k === K_DOWN) { const c = MENU_ITEMS[m.menu].length; m.menuSel = (m.menuSel + (k === K_UP ? c - 1 : 1)) % c; return true; }
    if (k === K_ENTER) { const it = MENU_ITEMS[m.menu][m.menuSel]; m.menu = -1; m.focus = FOCUS_INPUT; this.menuAction(it); return true; }
    if (k === K_ESC) { m.menu = -1; m.focus = FOCUS_INPUT; return true; }
    return false;
  }

  /** LIVECHAT sidebar keys: Up/Down move, Enter joins a channel or opens a user's menu, Esc goes back to the input. */
  private sideKey(k: number): boolean {
    const m = this.model;
    if (k === K_UP || k === K_DOWN) { this.sideMove(k === K_UP ? -1 : 1); return true; }
    if (k === K_ENTER) {
      if (m.side[m.sideSel]?.kind === SIDE_USER) { const at = this.hitAt(HIT_SIDEBAR, m.sideSel); this.sideMenu(at.row, at.col); } else { this.sideJoin(); m.focus = FOCUS_INPUT; }
      return true;
    }
    if (k === K_ESC) { m.focus = FOCUS_INPUT; return true; }
    return false;
  }

  /** Where a hit region row was drawn, for menus opened from the keyboard. */
  private hitAt(id: number, dr: number): { row: number; col: number } {
    const d = this.drawState;
    for (let r = 0; r < this.cells.rows; r++) for (let c = 0; c < this.cells.cols; c++) { const h = d.hits.at(r, c); if (h.id === id && h.dr === dr) return { row: r, col: c }; }
    return { row: 2, col: 0 };
  }

  /** LIVECHAT channel and user context menus for the selected sidebar row. */
  private sideMenu(row: number, col: number): void {
    const it = this.model.side[this.model.sideSel];
    if (!it) return;
    const sysop = this.tryRun(false, (_db, ctx) => ctx.sysop) === true;
    if (it.kind === SIDE_USER) {
      const items = ['View Profile', 'Send Message', 'Whois', '---', 'Mention', 'Add Note', 'View History', '---', 'Mute User', 'Ignore', 'Block'];
      this.popupOpen(sysop ? [...items, '---', 'Kick User', 'Ban User'] : items, row, col, { user: it.label });
    } else if (it.kind === SIDE_ROOM) {
      const items = ['Join', 'Leave', 'Info', 'Expand/Collapse', '---', it.id !== undefined && this.pinned.has(it.id) ? 'Unpin Channel' : 'Pin Channel'];
      this.popupOpen(sysop ? [...items, 'Clear History', 'Archive', 'Delete Channel'] : items, row, col, { roomId: it.id, user: it.label });
    }
  }

  private popupOpen(items: string[], row: number, col: number, ctx: { line?: Line; user?: string; roomId?: string }): void {
    this.model.popup = { items, row, col, sel: 0 };
    this.popupCtx = ctx;
  }

  private popupClose(): void { this.model.popup = null; this.popupCtx = {}; }

  private popupKey(k: number): void {
    const pu = this.model.popup;
    if (!pu) return;
    if (k === K_UP || k === K_DOWN) {
      const n = pu.items.length;
      do pu.sel = (pu.sel + (k === K_UP ? n - 1 : 1)) % n; while (pu.items[pu.sel] === '---');
    } else if (k === K_ENTER) this.popupPick(pu.sel);
    else this.popupClose();
  }

  /** LIVECHAT context-menus.ts actions, routed through the Partyline commands. */
  private popupPick(i: number): void {
    const item = this.model.popup?.items[i];
    if (item === undefined || item === '---') return;
    const { line, user = '', roomId } = this.popupCtx, m = this.model;
    this.popupClose();
    m.focus = FOCUS_INPUT;
    const n = line?.number ?? 0;
    switch (item) {
      case 'Reply': this.fillInput(`/reply ${n} `); return;
      case 'React': this.fillInput(`/react ${n} `); return;
      case 'Copy Text': this.osc = `\x1b]52;c;${Buffer.from(line?.text ?? '', 'utf8').toString('base64')}\x07`; this.systemLine('Copied to clipboard.'); return;
      case 'Pin Message': this.runLine(`/pin ${n}`); return;
      case 'Edit': this.fillInput(`/edit ${n} ${line?.text ?? ''}`); return;
      case 'Delete': this.runLine(`/deletemsg ${n}`); return;
      case 'View Profile': this.profileOverlay(user); return;
      case 'Whois': this.runLine(`/whois ${user}`); return;
      case 'Send Message': this.fillInput(`/msg ${user} `); return;
      case 'Add Note': this.fillInput(`/note ${user} `); this.systemLine(`Note about ${user}: type it after /note ${user} and press Enter.`); return;
      case 'Mention': m.input = `@${user} ${m.input}`; m.inputCur = m.input.length; return;
      case 'View History': {
        const mine = m.lines.filter((l) => l.number > 0 && l.nick === user).slice(-15);
        this.systemLine(`--- recent messages from ${user} ---`);
        for (const l of mine) this.systemLine(`${l.nick}: ${l.text}`);
        return;
      }
      case 'Mute User': this.runLine(`/mute ${user}`); return;
      case 'Ignore': case 'Block': this.runLine(`/ignore ${user}`); return; // LIVECHAT Block is the server-side ignore
      case 'Info': this.systemLine(`Channel: ${user}`); return;
      case 'Expand/Collapse': {
        const it = m.side.find((s) => s.kind === SIDE_ROOM && s.id === roomId);
        if (it && roomId !== undefined) { it.open = !it.open; this.expanded.set(roomId, it.open); }
        return;
      }
      case 'Pin Channel': case 'Unpin Channel':
        if (roomId === undefined) return;
        if (this.pinned.delete(roomId)) this.systemLine(`Unpinned ${user}`); else { this.pinned.add(roomId); this.systemLine(`Pinned ${user}`); }
        this.prefsSave();
        this.fillSidebar();
        return;
      case 'Clear History': this.runLine(`/clear-room ${roomId ?? ''}`); return;
      case 'Delete Channel': this.runLine(`/delete ${roomId ?? ''}`); return;
      case 'Archive': this.runLine(`/archive-room ${roomId ?? ''}`); return;
      case 'Mark Unread': this.runLine('/mark-unread'); this.fillSidebar(); return;
      case 'Kick User': this.runLine(`/kick ${user}`); return;
      case 'Ban User': this.runLine(`/ban ${user}`); return;
      case 'Join': if (roomId !== undefined && roomId !== this.roomId) this.joinRoom(roomId); return;
      case 'Leave': if (roomId === this.roomId) this.runLine('/leave'); else this.systemLine(`You are not in #${user}.`); return;
      default: this.systemLine(`${item} is not on Partyline yet.`);
    }
  }

  /** The menu bar's items and their function keys (LIVECHAT menu-bar.ts handlers). */
  private menuAction(label: string): void {
    const o = this.over;
    switch (label.replace(/ \(.*\)$/, '')) {
      case 'Help': case 'Keyboard Shortcuts': o.help = true; o.helpTop = 0; return;
      case 'Channel List': case 'Toggle Sidebar': this.toggleSidebar(); return;
      case 'Next Channel': this.nextChannel(); return;
      case 'Join Channel...': this.fillInput('/join '); return;
      case 'Leave Channel': this.runLine('/leave'); return;
      case 'Emoji': this.openPicker(); return;
      case 'Files': this.runLine('/files'); return;
      case 'Pins': this.runLine('/pinned'); return;
      case 'Search': this.searchOpen(); return;
      case 'Threads': this.runLine('/threads'); return;
      case 'Settings': this.runLine('/settings'); return;
      case 'Theme': this.runLine('/theme'); return;
      case 'Clear Chat': this.runLine('/clear'); return;
      case 'About': this.runLine('/about'); return;
      case 'Quit': this.key(17); return;
    }
  }

  /** LIVECHAT F2: show or hide the sidebar. */
  private toggleSidebar(): void {
    const m = this.model;
    m.sidebarHidden = !m.sidebarHidden;
    if (m.sidebarHidden && m.focus === FOCUS_SIDEBAR) m.focus = FOCUS_INPUT;
    this.systemLine(m.sidebarHidden ? 'Sidebar hidden (F2 to show)' : 'Sidebar shown');
  }

  /** LIVECHAT F3: channels and users view. Partyline shows both, so the selection jumps to the other section. */
  private switchSideView(): void {
    const m = this.model, want = m.side[m.sideSel]?.kind === SIDE_USER ? SIDE_ROOM : SIDE_USER;
    const i = m.side.findIndex((s) => s.kind === want);
    if (i >= 0) m.sideSel = i;
    m.sidebarHidden = false;
    this.systemLine(`Switched to ${want === SIDE_USER ? 'users' : 'channels'} view`);
  }

  private nextChannel(): void {
    const rooms = this.model.side.filter((s) => s.kind === SIDE_ROOM && s.id !== undefined);
    if (rooms.length === 0) return;
    const next = rooms[(rooms.findIndex((s) => s.id === this.roomId) + 1) % rooms.length];
    if (next.id !== undefined && next.id !== this.roomId) this.joinRoom(next.id);
  }

  private fillInput(text: string): void {
    const m = this.model;
    m.input = text; m.inputCur = text.length; m.focus = FOCUS_INPUT;
    this.clearSelection();
    this.over.slashOff = true;
  }

  private runLine(cmd: string): void { if (!this.overlayCommand(cmd) && runCommand(this, cmd)) this.quit(); }

  /** LIVECHAT: a click (or a wheel step) on a channel row switches to that channel. */
  private sideJoin(): void {
    const it = this.model.side[this.model.sideSel];
    if (it?.kind === SIDE_ROOM && it.id !== undefined && it.id !== this.roomId) this.joinRoom(it.id);
  }

  /** The input character under a column, clamped to the text. */
  private inputAt(col: number): number {
    return Math.max(0, Math.min(this.model.input.length, this.drawState.inputFrom + col - 1));
  }

  /** slash_key: true when the "/" menu used the key. */
  private slashKey(k: number): boolean {
    const m = this.model, o = this.over;
    const idx = o.slashOff ? [] : slashMatch(m.input);
    if (idx.length === 0) return false;
    const ghost = slashGhost(m.input, idx);
    if (k === K_UP || k === K_DOWN) {
      o.slashSel = Math.max(0, Math.min(idx.length - 1, o.slashSel + (k === K_DOWN ? 1 : -1)));
      o.slashTop = slashScroll(o.slashSel, o.slashTop, idx.length);
      return true;
    }
    if (k === K_ESC) { o.slashOff = true; return true; }
    if (k === 9 || k === K_RIGHT) {
      if (ghost < 0) { if (k === 9) { o.slashOff = true; return true; } return false; }
      this.fillCommand(ghost);
      return true;
    }
    if (k === K_ENTER) {
      if (slashComplete(m.input)) return false;
      this.fillCommand(ghost >= 0 ? ghost : idx[Math.min(o.slashSel, idx.length - 1)]);
      return true;
    }
    o.slashSel = 0; o.slashTop = 0;
    return false;
  }

  private fillCommand(cmd: number): void {
    const m = this.model;
    m.input = `/${CMD_HELP[cmd][0]} `;
    m.inputCur = m.input.length;
    this.clearSelection();
    this.over.slashOff = true;
  }

  /** submit: a command, else a room line; the input clears either way. */
  submit(): void {
    const m = this.model;
    const line = m.input;
    m.input = ''; m.inputCur = 0;
    this.clearSelection();
    this.over.slashSel = 0; this.over.slashTop = 0; this.over.slashOff = false;
    const editId = m.editing && this.histPos >= 0 ? this.history[this.histPos]?.id : undefined;
    m.editing = false; this.histPos = -1;
    if (line === '') return;
    if (line[0] === '/') { this.remember(line); if (!this.overlayCommand(line) && runCommand(this, line)) this.quit(); return; }
    if (editId !== undefined) { // LIVECHAT: a recalled message sent again edits the original, it does not post a new one
      if (this.tryRun(true, (db, ctx) => editMessage(db, ctx, editId, { content: line })) !== undefined) {
        const h = this.history.find((x) => x.id === editId);
        if (h) h.text = line;
      }
      return;
    }
    const id = this.sendRoomLine(line);
    this.remember(line, id);
  }

  private remember(text: string, id?: string): void {
    if (this.history[this.history.length - 1]?.text === text) return;
    this.history.push({ text, id });
    if (this.history.length > 100) this.history.shift();
  }

  private quit(): void {
    this.quitting = true;
    // Dirty first: the session renders one last frame (the clear below) before it ends; without it PL's screen stayed on the board (sysop 2026-11-24).
    this.info.markDirty();
    this.info.quit?.();
  }

  render(full: boolean): Buffer {
    // Leaving: hand the board a clean screen, as LIVECHAT's cleanup and every door exit do.
    if (this.quitting) return Buffer.from((this.info.hello.mouse ? '\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l' : '') + '\x1b[0m\x1b[2J\x1b[H\x1b[?25h', 'latin1');
    if (full) this.cells.invalidate();
    const { cr, cc } = draw(this.cells, this.model, this.drawState, this.over);
    // A full frame (first paint, resize, redraw) re-arms SGR mouse reports; input() parses them. ?1002h adds drag motion (the input selection).
    // ?1003h (any motion) only while a menu is open, for LIVECHAT hover; off again re-arms ?1002h, the same mode slot.
    const motion = !!this.info.hello.mouse && (this.model.menu >= 0 || this.model.popup !== null);
    const mode = motion !== this.anyMotion || (full && motion) ? (motion ? '\x1b[?1003h' : '\x1b[?1003l\x1b[?1002h') : '';
    this.anyMotion = motion;
    const mouseOn = (full && this.info.hello.mouse ? '\x1b[?1000h\x1b[?1006h\x1b[?1002h' : '') + mode + this.osc;
    this.osc = '';
    // The terminal bytes are in the caller's own charset (hello charset=):
    // UTF-8 for the web and modern doors, latin1 for the Amiga and kin.
    return Buffer.from(mouseOn + this.cells.present(this.model.focus === FOCUS_INPUT && this.model.menu < 0, cr, cc), this.utf8 ? 'utf8' : 'latin1');
  }

  /** session.ts `U` and `M` frames: upload results, the board's Add Note answer, and voice media. */
  upload(payload: Buffer): void {
    const note = /^note (ok|fail) (.*)$/.exec(payload.toString('latin1').trim());
    if (!note) { this.av.uploadResult(payload); return; }
    this.systemLine(note[1] === 'ok' ? `Note saved for ${note[2]}.` : `Could not save note for ${note[2]}.`);
    this.info.markDirty();
  }
  media(payload: Buffer): void { this.av.media(payload); }

  close(): void { clearTimeout(this.selectTimer); clearInterval(this.tick); this.typingStop(); this.off(); this.av.close(); }
}

export const chatScreen = (ach: AchievementsConfig, chat: ChatConfig, filesDir: string | null = null): ScreenFactory => (info) => new HubScreen(ach, chat, info, filesDir);
