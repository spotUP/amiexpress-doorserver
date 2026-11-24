/**
 * The Partyline "/" commands against livechat.c run_command: names and aliases, and the
 * line each command group prints. Each test types into a real hub screen on a real chat store.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { emitEvent } from '../src/chat/events';
import { createRoom, joinRoom, postMessage } from '../src/chat/store';
import { canonical } from '../src/partyline/commands';
import { cellFg, cellBg, cellFlags, BG_DEFAULT } from '../src/partyline/ui/cells';
import { chatScreen } from '../src/partyline/ui/screen';
import { MENU_COL } from '../src/partyline/ui/draw';
import { FOCUS_INPUT, FOCUS_MENU, LIVE, SIDE_HEAD, SIDE_ROOM, SIDE_USER, newLine, newSide } from '../src/partyline/ui/model';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('canonical (run_command names)', () => {
  it('maps C aliases and CMD_HELP aliases, and drops what C does not dispatch', () => {
    expect(canonical('l')).toBe('rooms');
    expect(canonical('LIST')).toBe('rooms');
    expect(canonical('w')).toBe('who');
    expect(canonical('j')).toBe('join');
    expect(canonical('h')).toBe('help');
    expect(canonical('quit')).toBe('quit');
    expect(canonical('users')).toBeNull();
    expect(canonical('+1')).toBeNull();
    expect(canonical('nosuch')).toBeNull();
  });
});

describe('hub screen commands', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  let quits = 0;
  let dirties = 0;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25 } as ScreenInfo['hello'];
    quits = 0; dirties = 0;
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => { dirties++; }, quit: () => { quits++; } }) as HubScreen;
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const type = (line: string): string[] => {
    const before = screen.model.lines.length;
    screen.input(Buffer.from(`${line}\r`, 'latin1'));
    screen.take(); // the store event reaches the pane through the emitter, which a test does not wait for
    return screen.model.lines.slice(Math.max(0, before - 1)).map((l) => l.text);
  };
  const last = (): string => screen.model.lines[screen.model.lines.length - 1]?.text ?? '';

  it('help, nick, unknown, not-on-Amiga', () => {
    type('/help nick');
    expect(screen.model.lines.some((l) => l.text.startsWith('/nick - '))).toBe(true);
    type('/help discord');
    const help = screen.model.lines.slice(-3).map((l) => l.text);
    expect(help[1]).toBe('/discord [on|off]');
    expect(help[2]).toBe('/discord join <channel id> | /discord status  (sysop links a channel)');
    type('/help zzz'); expect(last()).toBe('Unknown: zzz');
    type('/help'); expect(screen.over.help).toBe(true);
    screen.input(Buffer.from('q')); expect(screen.over.help).toBe(false);
    type('/nick'); expect(last()).toBe('Your username: bob');
    type('/users'); expect(last()).toBe('Unknown command. Type /help for help.');
    type('/voice'); expect(screen.model.lines.some((l) => l.text === 'Not in a voice call.')).toBe(true);
  });

  it('join, me, topic usage, leave', () => {
    type('/me waves'); expect(last()).toBe('Join a room first.');
    type('/join'); expect(last()).toBe('Usage: /join room');
    screen.run(true, (db, ctx) => createRoom(db, ctx, { name: 'general' }));
    type('/join #general');
    expect(screen.model.room).toBe('general');
    type('/topic'); expect(last()).toBe('Error: Usage: /topic <new topic>');
    type('/leave'); expect(last()).toBe('Left #general');
    type('/leave'); expect(last()).toBe('You are not in a channel.');
  });

  it('away, back, status', () => {
    type('/away lunch'); expect(last()).toBe('You are now away: lunch');
    type('/back'); expect(last()).toBe('You are now online');
    type('/status busy coding'); expect(last()).toBe('Status set to busy: coding');
    type('/status sleepy'); expect(last()).toBe('Error: Usage: /status [online|away|busy|dnd] [message]');
  });

  it('ignore and unignore', () => {
    type('/ignore'); expect(last()).toBe('You are not ignoring anyone.');
    type('/ignore carol'); expect(last()).toBe('Ignoring carol - their messages and DMs are hidden.');
    type('/ignore carol'); expect(last()).toBe('Already ignoring carol.');
    type('/unignore carol'); expect(last()).toBe('carol is no longer hidden.');
    type('/unignore carol'); expect(last()).toBe('You are not ignoring carol.');
  });

  it('moderation, invite, mode, motd, whois, msg, create, delete', () => {
    type('/kick'); expect(last()).toBe('Error: Usage: /kick @user [reason]');
    type('/create #lounge'); expect(screen.model.room).toBe('lounge');
    type('/motd'); expect(last()).toBe('No MOTD set. Use /motd <text> to set, /motd --clear to clear.');
    type('/motd hello all'); type('/motd'); expect(last()).toBe('[MOTD] hello all');
    type('/mode x'); expect(last()).toBe('Error: Mode string must start with + or -');
    const n = screen.model.lines.length; type('/mode +m'); expect(screen.model.lines.length).toBe(n);
    type('/invite'); expect(last()).toBe('Error: Usage: /invite @user [#room]');
    type('/whois'); expect(last()).toBe('Error: Usage: /whois @user');
    type('/whois @nobody'); expect(last()).toBe('User nobody is not online.');
    type('/msg hi'); expect(last()).toBe('Usage: /msg @user [@user2 ...] message');
    type('/delete #lounge'); expect(last()).toBe('Deleted #lounge');
    expect(screen.model.room).toBe('');
  });

  it('message commands map the line number to the stored message', () => {
    screen.run(true, (db, ctx) => createRoom(db, ctx, { name: 'general' }));
    type('/join #general');
    type('/reply hi'); expect(last()).toBe('No message to reply to: name one with its id.');
    type('/react 9 +1'); expect(last()).toBe('No such message number.');
    type('first line');
    const lines = (): string[] => screen.model.lines.filter((l) => l.number > 0).map((l) => `${l.number}:${l.text}`);
    expect(lines()).toEqual(['1:first line']);
    type('/edit 1 changed'); expect(lines()).toEqual(['1:changed']);
    type('/edit better'); expect(lines()).toEqual(['1:better']);
    type('/reply 1 answer'); expect(lines()).toEqual(['1:better', '2:answer']);
    type('/love 1'); type('/react 1 fire'); type('/reactions 1'); expect(last()).toMatch(/^Reactions on 1: (\[heart 1\] \[fire 1\]|\[fire 1\] \[heart 1\])$/);
    type('/unreact fire 1'); type('/reactions 1'); expect(last()).toBe('Reactions on 1: [heart 1]');
    type('/thread 1'); expect(last()).toMatch(/: better$/); // threadHistory leads with the parent message
    type('/pin 1'); expect(last()).toBe('Pin requested.');
    type('/pinned'); expect(last()).toMatch(/^1\. bob.*: better/);
    type('/search better'); expect(last()).toBe('Found 1 results for "better"');
    type('/unpin 1'); type('/pinned'); expect(last()).toBe('No pinned messages in this room.');
    type('/deletemsg 1'); expect(lines()).toEqual(['2:answer']);
    type('/deletemsg'); expect(lines()).toEqual([]);
  });

  it('join loads the backlog as numbered lines', () => {
    screen.run(true, (db, ctx) => { const r = createRoom(db, ctx, { name: 'old' }); joinRoom(db, ctx, r.id); postMessage(db, ctx, r.id, { content: 'older', clientId: 'a' }); postMessage(db, ctx, r.id, { content: 'newer', clientId: 'b' }); });
    type('/join #old');
    expect(screen.model.lines.filter((l) => l.number > 0).map((l) => `${l.number}:${l.text}`)).toEqual(['1:older', '2:newer']);
    expect(screen.model.lines.some((l) => l.text === '--- 2 earlier messages ---')).toBe(true);
    type('/edit 1 fixed'); expect(screen.model.lines.find((l) => l.number === 1)?.text).toBe('fixed');
  });

  it('create takes topic words and --motd; events, sounds, settings, clear-room, whois', () => {
    type('/create #lab fun times --motd "be kind" --private');
    expect(screen.model.room).toBe('lab');
    expect(screen.model.paneLabel).toBe('lab - fun times');
    type('/motd'); expect(last()).toBe('[MOTD] be kind');
    type('/create #x --type foo'); expect(last()).toBe('Error: Channel type must be text, voice or art.');
    type('/events'); expect(screen.model.lines.some((l) => l.text.includes('Door Activity:') && l.text.endsWith('ON'))).toBe(true);
    type('/events doors'); expect(last()).toBe('Door activity events: OFF');
    type('/events off'); expect(last()).toBe('All BBS events disabled');
    type('/events nope'); expect(last()).toBe('Valid types: logins, files, doors, messages, announcements, on, off');
    for (const w of ['files', 'file', 'share']) { type('/' + w); expect(last()).toBe('file sharing is not enabled on this hub'); }
    type('/sounds'); expect(last()).toBe('Error: Usage: /sounds on|off');
    type('/sounds off'); expect(last()).toBe('Sounds disabled');
    type('/settings'); expect(last()).toBe('  BBS events: see /events');
    type('first'); type('/clear-room'); expect(last()).toBe('Clear history requested for lab');
    type(`/whois @${screen.run(false, (_db, ctx) => ctx.user)}`); expect(screen.model.lines.some((l) => /^Board .*last seen \d\d:\d\d, idle \d+s$/.test(l.text))).toBe(true);
    expect(last()).toBe('Shared rooms: #lab');
  });

  it('emoji picker: F4 and Ctrl+E open it, keys move, Enter inserts the code, Escape closes', () => {
    const o = screen.over;
    screen.input(Buffer.from('hi ')); screen.input(Buffer.from('\x1bOS', 'latin1'));
    expect(o.fmt).toBe(true);
    screen.render(true); // draws without throwing
    screen.input(Buffer.from([0x0d])); // category pane Enter moves to the items
    screen.input(Buffer.from('\x1b[B', 'latin1')); screen.input(Buffer.from('j'));
    expect(o.pickItem).toBe(2);
    screen.input(Buffer.from([0x0d]));
    expect(o.fmt).toBe(false);
    expect(screen.model.input).toBe('hi :joy: ');
    expect(screen.model.inputCur).toBe(screen.model.input.length);
    screen.key(5); expect(o.fmt).toBe(true);
    screen.key(1001); expect(o.pickCat).toBe(1); // the picker opens on the categories
    screen.key(1007); expect(o.fmt).toBe(false);
    expect(screen.model.input).toBe('hi :joy: ');
    screen.model.input = ''; screen.model.inputCur = 0;
    type('/emoji '); expect(o.fmt).toBe(true);
  });

  it('a full frame turns on SGR mouse reports only when the board says the caller has a mouse', () => {
    expect(screen.render(true).toString('latin1')).not.toContain('\x1b[?1006h');
    (screen.info.hello as { mouse: boolean }).mouse = true;
    expect(screen.render(true).toString('latin1')).toContain('\x1b[?1000h\x1b[?1006h');
    expect(screen.render(false).toString('latin1')).not.toContain('\x1b[?1006h');
  });

  it('emoji picker colours follow draw_fmt: selected category ground on ok, selected item ground on accent, [X] red on black', () => {
    const pal = screen.model.pal;
    screen.model.input = ''; screen.model.inputCur = 0;
    screen.key(5); screen.render(true);
    const cell = (id: number): number => {
      const r = screen.drawState.hits.r.find((h) => h.id === id)!;
      return screen.cells.back[r.top * screen.cells.cols + r.left];
    };
    const cat = cell(14), item = cell(15), close = cell(16);
    expect([cellFg(cat), cellBg(cat)]).toEqual([pal.barInk, pal.ok]);
    expect([cellFg(item), cellBg(item)]).toEqual([pal.barInk, pal.accent]);
    expect(cellFg(close)).toBe(pal.alert);
    expect(cellBg(close)).toBe(0);
    expect(cellFlags(close) & BG_DEFAULT).toBe(0);
    screen.key(1007);
  });

  it('emoji picker mouse: category click, item click selects then inserts, [X] closes, wheel scrolls, outside click closes', () => {
    const o = screen.over;
    const click = (id: number, dr = 0, x = 0): void => {
      const r = screen.drawState.hits.r.find((h) => h.id === id)!;
      screen.input(Buffer.from(`\x1b[<${x};${r.left + 1};${r.top + dr + 1}M\x1b[<${x};${r.left + 1};${r.top + dr + 1}m`, 'latin1'));
      screen.render(true);
    };
    screen.model.input = ''; screen.model.inputCur = 0;
    screen.key(5); screen.render(true);
    click(14, 2); expect(o.pickCat).toBe(2); expect(o.pickPane).toBe(0);
    click(14, 2); expect(o.pickPane).toBe(1); // a second click on the category enters it
    click(14, 0); expect(o.pickCat).toBe(0);
    click(15, 1); expect(o.pickItem).toBe(1); expect(o.fmt).toBe(true); // first click selects
    click(15, 1); expect(o.fmt).toBe(false); // a click on the selected row inserts and closes
    expect(screen.model.input).toMatch(/^:\w+: $/);
    screen.key(5); screen.render(true); click(16); expect(o.fmt).toBe(false); expect(screen.model.input).toMatch(/^:\w+: $/);
    screen.key(5); screen.render(true);
    for (let i = 0; i < 80; i++) screen.model.addLine(newLine(LIVE, '', 'bob', `line ${i}`)); // the wheel clamps to the scrollbar span
    screen.render(true);
    const at = screen.model.scroll;
    screen.input(Buffer.from('\x1b[<64;40;5M', 'latin1')); expect(screen.model.scroll).toBe(at + 3);
    screen.input(Buffer.from('\x1b[<65;40;5M', 'latin1')); expect(screen.model.scroll).toBe(at);
    screen.input(Buffer.from('\x1b[<0;1;1M', 'latin1')); expect(o.fmt).toBe(false); // left press outside
  });

  describe('mouse (livechat.c handle_mouse)', () => {
    const sgr = (b: number, x: number, y: number, end = 'M'): void => { screen.input(Buffer.from(`\x1b[<${b};${x + 1};${y + 1}${end}`, 'latin1')); screen.render(true); };
    const press = (x: number, y: number): void => sgr(0, x, y);
    const fill = (): void => { for (let i = 0; i < 80; i++) screen.model.addLine(newLine(LIVE, '', 'bob', `line ${i}`)); screen.render(true); };
    const bar = (): { top: number; left: number; rows: number } => screen.drawState.hits.r.find((h) => h.id === 12)!;

    it('menu bar: a label press opens that menu on its first item; a press elsewhere closes it', () => {
      screen.render(true);
      press(MENU_COL[2], 0);
      expect(screen.model.menu).toBe(2); expect(screen.model.menuSel).toBe(0); expect(screen.model.focus).toBe(FOCUS_MENU);
      screen.render(true); press(MENU_COL[1], 0); expect(screen.model.menu).toBe(1);
      press(40, 10); expect(screen.model.menu).toBe(-1); expect(screen.model.focus).toBe(FOCUS_INPUT);
    });

    it('dropdown: an item press closes the menu and runs it (Toggle Sidebar, Keyboard Shortcuts)', () => {
      screen.render(true);
      press(MENU_COL[2], 0); screen.render(true);
      const dd = screen.drawState.hits.r.find((h) => h.id === 2)!;
      press(dd.left, dd.top + 2);
      expect(screen.model.menu).toBe(-1); expect(screen.model.sidebarHidden).toBe(true);
      press(0, 24); expect(screen.model.sidebarHidden).toBe(false); // the status line shows the sidebar again
      press(MENU_COL[3], 0); screen.render(true);
      const d2 = screen.drawState.hits.r.find((h) => h.id === 2)!;
      press(d2.left, d2.top + 1);
      expect(screen.over.help).toBe(true);
    });

    it('sidebar: a press selects an entry, a heading is ignored, the wheel steps the selection by two', () => {
      const m = screen.model;
      m.side = [newSide(SIDE_HEAD, false, 'CHANNELS'), newSide(SIDE_ROOM, true, 'a'), newSide(SIDE_ROOM, false, 'b'), newSide(SIDE_USER, false, 'c'), newSide(SIDE_ROOM, false, 'd')];
      m.sideSel = 1; screen.render(true);
      const sb = screen.drawState.hits.r.find((h) => h.id === 3)!;
      press(sb.left, sb.top + 2); expect(m.sideSel).toBe(2);
      press(sb.left, sb.top); expect(m.sideSel).toBe(2);
      sgr(65, sb.left, sb.top, 'M'); expect(m.sideSel).toBe(4);
      sgr(64, sb.left, sb.top, 'M'); expect(m.sideSel).toBe(2);
      const at = m.scroll; fill();
      sgr(64, sb.left, sb.top, 'M'); expect(m.scroll).toBe(at); // over the sidebar the wheel does not scroll the chat
    });

    it('scrollbar: a press jumps the thumb, a held drag follows the pointer, a release ends it, the wheel clamps', () => {
      fill();
      const b = bar(), d = screen.drawState, m = screen.model;
      press(b.left, b.top); expect(m.scroll).toBe(d.barSpan);
      press(b.left, b.top + b.rows - 1); expect(m.scroll).toBe(0);
      press(b.left, b.top); sgr(32, b.left, b.top + b.rows - 1); expect(m.scroll).toBe(0); // motion with the button held drags
      sgr(32, b.left, b.top); expect(m.scroll).toBe(d.barSpan);
      sgr(0, b.left, b.top + b.rows - 1, 'm'); sgr(32, b.left, b.top); expect(m.scroll).toBe(d.barSpan);
      sgr(35, b.left, b.top + b.rows - 1); expect(m.scroll).toBe(d.barSpan); // plain motion carries nothing
      sgr(64, 40, 5); expect(m.scroll).toBe(d.barSpan); // clamped at the top
      sgr(65, 40, 5); expect(m.scroll).toBe(d.barSpan - 3);
    });
  });

  it('emoji search, emojis categories, customemoji add list remove', () => {
    type('/emoji lol'); expect(screen.model.lines.some((l) => l.text === 'Emojis matching "lol":')).toBe(true);
    expect(last()).toBe('  XD  :joy: (laugh, lol)');
    type('/emoji zzzz'); expect(last()).toBe('No emojis found for "zzzz"');
    type('/emojis nope'); expect(last()).toBe('Unknown category "nope". Use /emojis to see all categories.');
    type('/emojis special'); expect(last()).toBe('  [=>]  :door: (game, app)');
    type('/customemoji'); expect(last()).toBe('No custom emoji yet.');
    type('/customemoji add :smile: a b'); expect(last()).toBe(':smile: is a built-in emoji.');
    type('/customemoji add Boing BOING (o)'); type('/customemoji list'); expect(last()).toBe('  boing  web BOING  telnet (o)');
    type('/emojis special'); expect(last()).toBe('  (o)  :boing: (custom)');
    type('/customemoji remove :boing:'); type('/customemoji list'); expect(last()).toBe('No custom emoji yet.');
    type('/customemoji add x'); expect(last()).toBe('Usage: /customemoji add <name> <display> <ascii>');
  });

  it('slash menu Tab fills the command; /quit and Ctrl-Q quit', () => {
    screen.input(Buffer.from('/nic\t'));
    expect(screen.model.input).toBe('/nick ');
    screen.input(Buffer.from('\x08'.repeat(6)));
    type('/quit'); expect(quits).toBe(1);
    screen.input(Buffer.from([17])); screen.input(Buffer.from('y')); expect(quits).toBe(2);
  });
  it('quitting renders a clear, so the board gets a clean screen back', () => {
    screen.render(true);
    type('/quit'); expect(quits).toBe(1);
    expect(dirties).toBeGreaterThan(0);
    const out = screen.render(false).toString('latin1');
    expect(out).toContain('\x1b[2J\x1b[H');
    expect(out).not.toMatch(/bob|Partyline/i);
  });
  it('draw and art: usage, not an art channel, joining an art channel', () => {
    screen.run(true, (db, ctx) => { createRoom(db, ctx, { name: 'general' }); createRoom(db, ctx, { name: 'paint', kind: 'art' }); });
    type('/join #general');
    type('/draw'); expect(last()).toBe('Usage: /draw <art channel>  (art channels are marked [A] in the sidebar)');
    type('/draw #general'); expect(last()).toBe('That is not an Art channel.');
    type('/art #paint'); expect(screen.model.room).toBe('paint');
    type('/draw'); expect(last()).toBe('The drawing canvas is not on Partyline yet.');
  });

  it('view and picture: numbers, the picture announcement, non-pictures, files off', () => {
    screen.run(true, (db, ctx) => createRoom(db, ctx, { name: 'general' }));
    type('/join #general');
    type('/view 1'); expect(last()).toBe('No files shared yet this session');
    const share = (ref: string, text: string): void => {
      screen.run(true, (db, ctx) => emitEvent(db, { type: 'file_shared', roomId: screen.roomId, user: 'amy', ref, text }));
      screen.take();
    };
    share('f1', 'pic.png|10|image');
    expect(last()).toBe('amy shared a picture: pic.png (/view)  #1 [PICTURE] pic.png');
    share('f2', 'notes.txt|5|text');
    type('/picture 3'); expect(last()).toBe('No file 3 (1-2)');
    type('/view 2'); expect(last()).toBe('That file is not a picture');
    type('/view 1'); expect(last()).toBe('File sharing is off on this hub');
  });

  it('upload needs a room first (tests/partyline-media.test.ts covers the transfer)', () => {
    type('/upload'); expect(last()).toBe('Join a chat room first.');
  });

  it('discord: show, usage, sysop switch on and off', () => {
    type('/discord'); expect(last()).toBe('Discord mirror is ON for this board.'); // the fixture board starts mirrored
    type('/discord off'); type('/discord'); expect(last()).toBe('Discord mirror is OFF for this board.');
    type('/discord maybe'); expect(last()).toBe('Usage: /discord [on|off|join|status]');
    type('/discord on'); expect(last()).toBe('Discord mirror is ON for this board.');
    type('/discord'); expect(last()).toBe('Discord mirror is ON for this board.');
    type('/discord off'); expect(last()).toBe('Discord mirror is OFF for this board.');
  });

  it('discord: a caller who is not the sysop may look but not switch', () => {
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'amy', sysop: false, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25 } as ScreenInfo['hello'];
    const amy = chatScreen(fx.ach, chat)({ sid, user: 'amy', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
    const say = (l: string): string => { amy.input(Buffer.from(`${l}\r`, 'latin1')); amy.take(); return amy.model.lines[amy.model.lines.length - 1].text; };
    try {
      expect(say('/discord')).toBe('Discord mirror is ON for this board.');
      expect(say('/discord off')).toBe('Only the sysop can change the Discord mirror.');
      expect(say('/discord')).toBe('Discord mirror is ON for this board.');
    } finally { amy.close(); }
  });

  it('discord join: invite link, bad id, link, duplicate, status with error', () => {
    screen.run(true, (db) => {
      db.prepare("INSERT INTO discord_app (id, application_id, at) VALUES (1, '987654321098765432', 1)").run();
    });
    screen.run(true, (db, ctx) => {
      createRoom(db, ctx, { name: 'Lobby' });
    });
    const inviteLines = type('/discord join');
    expect(inviteLines.some((l) => l.includes('client_id=987654321098765432'))).toBe(true);
    expect(last()).toBe('Usage: /discord join <channel id>  (15 to 22 digits)');
    type('/discord join abc');
    expect(last()).toBe('Usage: /discord join <channel id>  (15 to 22 digits)');
    type('/discord join 123456789012345678');
    expect(last()).toBe('Channel 123456789012345678 linked to the shared room.');
    type('/discord join 123456789012345678');
    expect(last()).toBe('channel already linked');
    type('/discord status');
    expect(last()).toBe('Channel 123456789012345678: linked');
    screen.run(true, (db) => {
      db.prepare("UPDATE discord_links SET status = 'failed', error = 'bot cannot see it' WHERE channel_id = '123456789012345678'").run();
    });
    type('/discord status');
    expect(last()).toBe('Channel 123456789012345678: failed - bot cannot see it');
  });

  it('discord join: bridge offline and non-sysop are refused', () => {
    type('/discord join');
    expect(last()).toBe('The Discord bridge is not online yet. Try /discord later.');
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'amy', sysop: false, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25 } as ScreenInfo['hello'];
    const amy = chatScreen(fx.ach, chat)({ sid, user: 'amy', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
    const say = (l: string): string => { amy.input(Buffer.from(`${l}\r`, 'latin1')); amy.take(); return amy.model.lines[amy.model.lines.length - 1].text; };
    try {
      expect(say('/discord join 123456789012345678')).toBe('Only the sysop can link Discord channels.');
      expect(say('/discord status')).toBe('Only the sysop can link Discord channels.');
    } finally { amy.close(); }
  });
});
