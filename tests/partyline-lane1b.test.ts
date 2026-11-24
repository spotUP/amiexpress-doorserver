/**
 * LIVECHAT parity for the Partyline hub screen, lane 1b: live event rendering (reactions, typing, DMs,
 * BBS events, sounds), the presence dot, the channel menu leftovers (Block, Info, Expand/Collapse,
 * Pin Channel, Clear History, Delete Channel) and edit-from-history keeping the message id.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import * as store from '../src/chat/store';
import { createRoom, react } from '../src/chat/store';
import type { EventRec } from '../src/chat/events';
import { chatScreen } from '../src/partyline/ui/screen';
import { ACTIVITY_LINE, EVENT, NOTE, SIDE_ROOM, SIDE_USER } from '../src/partyline/ui/model';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('hub screen lane 1b: LIVECHAT live events, presence and channel menu', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  let cues: string[];
  beforeEach(() => {
    fx = makeAchievementsFixture();
    cues = [];
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined, sound: (c: string) => { cues.push(c); } }) as HubScreen;
    for (const name of ['lobby', 'games']) {
      const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name })) as unknown as { id?: string; room?: { id: string } };
      screen.joinRoom(r.id ?? r.room?.id ?? '');
    }
    screen.render(true);
  });
  afterEach(() => { jest.restoreAllMocks(); screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const fire = (e: Partial<EventRec>): void => {
    (screen as unknown as { event(e: EventRec): void }).event({ seq: 0, type: '', room_id: screen.roomId, label: '', user: 'alice', ref: '', at: 0, text: '', reply_to: null, ...e } as EventRec);
  };
  const lines = (): string[] => screen.model.lines.map((l) => l.head + l.text);
  const say = (text: string): void => { screen.model.input = text; screen.model.inputCur = text.length; screen.input(Buffer.from('\r', 'latin1')); screen.take(); };
  const popup = (items: string[], pick: string, ctx: object): void => {
    const s = screen as unknown as { popupOpen(i: string[], r: number, c: number, x: object): void; popupPick(i: number): void };
    s.popupOpen(items, 2, 2, ctx); s.popupPick(items.indexOf(pick));
  };

  it('a reaction adds the note and activity lines and reloads the counts from the store', () => {
    say('hello');
    const l = screen.model.lines.find((x) => x.text === 'hello')!;
    screen.tryRun(true, (db, ctx) => react(db, ctx, l.id, { emoji: ':)' }));
    screen.take();
    expect(lines()).toEqual(expect.arrayContaining(['[bob reacted :)]', 'bob: :)']));
    expect(l.react).toEqual([{ emoji: ':)', count: 1 }]);
  });

  it('typing from another user shows a row, an empty buffer or their message removes it, own typing is skipped', () => {
    fire({ type: 'typing', text: 'hel' });
    fire({ type: 'typing', user: 'bob@UPROUGH', text: 'x' }); // events carry the full handle
    expect(screen.model.typing).toEqual([{ nick: 'alice', text: 'hel' }]);
    fire({ type: 'typing', text: '' });
    expect(screen.model.typing).toEqual([]);
    fire({ type: 'typing', text: 'hi' });
    fire({ type: 'message', ref: 'm1', text: 'hi' });
    expect(screen.model.typing).toEqual([]);
  });

  it('a DM prints the LIVECHAT note and activity lines and plays the dm cue; a mention plays the mention cue', () => {
    fire({ type: 'dm', label: 'dmx', room_id: '', text: 'psst' });
    fire({ type: 'dm', label: 'dgx', room_id: '', text: 'all' });
    fire({ type: 'dm', label: 'dmx', room_id: '', user: 'bob@UPROUGH', text: 'own' });
    const ls = screen.model.lines;
    expect(ls.some((l) => l.kind === NOTE && l.text === '[DM from alice]: psst')).toBe(true);
    expect(ls.some((l) => l.kind === ACTIVITY_LINE && l.text === 'Group DM from alice')).toBe(true);
    fire({ type: 'message', ref: 'm2', text: 'hey @bob' });
    expect(cues).toEqual(['dm', 'dm', 'mention']);
    screen.prefs.sounds = false;
    fire({ type: 'dm', label: 'dmx', room_id: '', text: 'quiet' });
    expect(cues).toHaveLength(3);
  });

  it('BBS events render as livechat.c take_bbs_event, gated by /events, Guest skipped', () => {
    fire({ type: 'bbs', ref: 'user_login', label: '2', text: 'location=Oslo' });
    expect(lines()).toEqual(expect.arrayContaining(['[EVENT] alice has logged in (Node 2)', '* alice logged in from Oslo (Node 2)']));
    fire({ type: 'bbs', ref: 'upload', text: 'fileName=a.lha&fileSize=2048&conferenceName=Main' });
    expect(lines()).toContain('* alice uploaded a.lha (2.0KB) to Main');
    fire({ type: 'bbs', ref: 'custom_door_event', text: 'doorName=Tetris&eventType=score&message=900&isPersonalBest=true' });
    const last = screen.model.lines[screen.model.lines.length - 1];
    expect([last.kind, last.head, last.text, last.pb]).toEqual([EVENT, '[Tetris]', ' alice: 900', true]);
    const n = screen.model.lines.length;
    fire({ type: 'bbs', ref: 'user_login', user: 'Guest' });
    screen.prefs.events.files = false;
    fire({ type: 'bbs', ref: 'download', text: 'fileName=b' });
    expect(screen.model.lines.length).toBe(n);
  });

  it('the user dot is green only for an online, active member (LIVECHAT red O)', () => {
    const row = { sysop: false, op: false, statusText: '', lastActive: 0 };
    jest.spyOn(store, 'roomMembers').mockReturnValue([
      { ...row, user: 'ann', status: 'online', active: true },
      { ...row, user: 'cid', status: 'online', active: false },
      { ...row, user: 'dee', status: 'away', active: true },
    ]);
    (screen as unknown as { fillSidebar(): void }).fillSidebar();
    const dot = (n: string): number | undefined => screen.model.side.find((s) => s.kind === SIDE_USER && s.label.startsWith(n))?.status;
    expect([dot('ann'), dot('cid'), dot('dee')]).toEqual([0, 1, 1]);
  });

  it('Block ignores the user, Info names the channel, Expand/Collapse and Pin Channel change the sidebar', () => {
    popup(['Block'], 'Block', { user: 'alice' });
    expect(screen.model.lines.some((l) => l.text.includes('alice'))).toBe(true);
    const first = screen.model.side.find((s) => s.kind === SIDE_ROOM)!, other = screen.model.side.filter((s) => s.kind === SIDE_ROOM)[1];
    popup(['Info'], 'Info', { roomId: first.id, user: first.label });
    expect(screen.model.lines[screen.model.lines.length - 1].text).toBe(`Channel: ${first.label}`);
    const open = first.open;
    popup(['Expand/Collapse'], 'Expand/Collapse', { roomId: first.id, user: first.label });
    expect(screen.model.side.find((s) => s.id === first.id)!.open).toBe(!open);
    popup(['Pin Channel'], 'Pin Channel', { roomId: other.id, user: other.label });
    expect(screen.model.side.find((s) => s.kind === SIDE_ROOM)!.id).toBe(other.id);
    expect(screen.model.lines[screen.model.lines.length - 1].text).toBe(`Pinned ${other.label}`);
  });

  it('Clear History and Delete Channel run the sysop commands instead of "not on Partyline yet"', () => {
    const other = screen.model.side.filter((s) => s.kind === SIDE_ROOM).find((s) => s.id !== screen.roomId)!;
    popup(['Clear History'], 'Clear History', { roomId: other.id, user: other.label });
    expect(lines().join('\n')).not.toContain('not on Partyline yet');
    popup(['Delete Channel'], 'Delete Channel', { roomId: other.id, user: other.label });
    expect(lines().join('\n')).not.toContain('not on Partyline yet');
  });

  it('a line recalled from history and sent again edits the original message, keeping its id', () => {
    say('frist');
    const before = screen.model.lines.filter((l) => l.id !== '').length;
    screen.input(Buffer.from('\x1b[A', 'latin1')); // empty input + Up starts the message pick; Esc leaves it
    screen.input(Buffer.from('\x1b', 'latin1'));
    screen.model.input = 'x';
    screen.input(Buffer.from('\x1b[A', 'latin1'));
    expect(screen.model.input).toBe('frist');
    screen.model.input = 'first'; screen.model.inputCur = 5;
    screen.input(Buffer.from('\r', 'latin1'));
    screen.take();
    const msgs = screen.model.lines.filter((l) => l.id !== '');
    expect(msgs.length).toBe(before);
    expect(msgs.find((l) => l.text === 'first')?.edited).toBe(true);
  });
});
