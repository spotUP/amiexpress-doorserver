/**
 * The Partyline "/" commands against livechat.c run_command: names and aliases, and the
 * line each command group prints. Each test types into a real hub screen on a real chat store.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom } from '../src/chat/store';
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

  it('slash menu Tab fills the command; /quit and Ctrl-Q quit', () => {
    screen.input(Buffer.from('/nic\t'));
    expect(screen.model.input).toBe('/nick ');
    screen.input(Buffer.from('\x08'.repeat(6)));
    type('/quit'); expect(quits).toBe(1);
    screen.input(Buffer.from([17])); screen.input(Buffer.from('y')); expect(quits).toBe(2);
  });
});
