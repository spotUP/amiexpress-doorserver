/**
 * The Partyline "/" commands against livechat.c run_command: names and aliases, and the
 * line each command group prints. Each test types into a real hub screen on a real chat store.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, joinRoom, postMessage } from '../src/chat/store';
import { canonical } from '../src/partyline/commands';
import { chatScreen } from '../src/partyline/ui/screen';
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
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25 } as ScreenInfo['hello'];
    quits = 0;
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => { quits++; } }) as HubScreen;
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
    type('/help zzz'); expect(last()).toBe('Unknown: zzz');
    type('/help'); expect(screen.over.help).toBe(true);
    screen.input(Buffer.from('q')); expect(screen.over.help).toBe(false);
    type('/nick'); expect(last()).toBe('Your username: bob');
    type('/users'); expect(last()).toBe('Unknown command. Type /help for help.');
    type('/voice'); expect(last()).toBe('Voice is not on Amiga yet.');
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

  it('slash menu Tab fills the command; /quit and Ctrl-Q quit', () => {
    screen.input(Buffer.from('/nic\t'));
    expect(screen.model.input).toBe('/nick ');
    screen.input(Buffer.from('\x08'.repeat(6)));
    type('/quit'); expect(quits).toBe(1);
    screen.input(Buffer.from([17])); screen.input(Buffer.from('y')); expect(quits).toBe(2);
  });
});
