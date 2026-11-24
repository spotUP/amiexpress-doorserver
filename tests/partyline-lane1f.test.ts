/**
 * Partyline hub lane 1f: the LIVECHAT Create Channel form (create-channel-dialog.ts), the typed pick lists
 * (server.ts typedPickListCommand) and the theme kept in the prefs store across sessions.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, getPrefs } from '../src/chat/store';
import { chatScreen } from '../src/partyline/ui/screen';
import { CF_CANCEL, CF_PRIVATE, CF_TOPIC, HIT_CREATE_F, HIT_CREATE_KIND } from '../src/partyline/ui/overlays';
import { slashPickKind } from '../src/partyline/ui/slash';
import { THEMES } from '../src/partyline/ui/model';
import type { HubScreen } from '../src/partyline/ui/screen';
import type { ScreenInfo } from '../src/partyline/session';

describe('hub screen lane 1f: Create Channel form, pick lists, stored theme', () => {
  let fx: AchievementsFixture;
  let screen: HubScreen;
  let open: () => HubScreen;
  beforeEach(() => {
    fx = makeAchievementsFixture();
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: true, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25, mouse: true } as ScreenInfo['hello'];
    open = () => chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined, sound: () => undefined }) as HubScreen;
    screen = open();
    const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name: 'lobby' })) as unknown as { id?: string; room?: { id: string } };
    screen.joinRoom(r.id ?? r.room?.id ?? '');
    screen.render(true);
  });
  afterEach(() => { screen.close(); _stopChatSweepersForTests(); fx.cleanup(); });

  const key = (s: string): void => screen.input(Buffer.from(s, 'latin1'));
  const esc = (): void => key('\x1b\x1b');
  const click = (id: number): void => {
    screen.render(true);
    for (let r = 0; r < 25; r++) for (let c = 0; c < 80; c++) {
      if (screen.drawState.hits.at(r, c).id === id) { key(`\x1b[<0;${c + 1};${r + 1}M`); key(`\x1b[<0;${c + 1};${r + 1}m`); return; }
    }
    throw new Error(`no hit ${id} on screen`);
  };

  it('bare /create opens the form; an empty name is refused; keys fill it and Create runs the /create line', () => {
    key('/create\r');
    expect(screen.over.create).toBe(true);
    key('\r'); key('\r'); // Name -> Topic; Enter in Topic presses Create with no name
    expect(screen.over.createNote).toBe('The channel needs a name.');
    expect(screen.over.createField).toBe(0);
    key('my lab'); key('\r');
    expect(screen.over.createField).toBe(CF_TOPIC);
    key('fun times'); key('\t'); key('\x1b[C'); // Type: Text -> Voice
    expect(screen.over.createKind).toBe(1);
    key('\t'); key(' '); // Private on
    expect(screen.over.createPriv).toBe(true);
    key('\t'); key('\t'); key('\r'); // Invite Only -> Create
    expect(screen.over.create).toBe(false);
    expect(screen.model.room).toBe('my-lab');
    expect(screen.model.paneLabel).toBe('my-lab - fun times');
  });

  it('/np ticks Private; Esc and Cancel close; a click picks a Type and toggles a box', () => {
    key('/np\r');
    expect(screen.over.create && screen.over.createPriv).toBe(true);
    esc();
    expect(screen.over.create).toBe(false);
    key('/n\r');
    expect(screen.over.createPriv).toBe(false);
    click(HIT_CREATE_KIND + 2);
    expect(screen.over.createKind).toBe(2);
    click(HIT_CREATE_F + CF_PRIVATE);
    expect(screen.over.createPriv).toBe(true);
    click(HIT_CREATE_F + CF_CANCEL);
    expect(screen.over.create).toBe(false);
    expect(screen.model.room).toBe('lobby');
  });

  it('pick-list kinds follow the usage line', () => {
    expect(slashPickKind('join')).toEqual({ kind: 'channel', run: true });
    expect(slashPickKind('msg')).toEqual({ kind: 'user', run: false });
    expect(slashPickKind('dm')).toEqual({ kind: 'user', run: false });
    expect(slashPickKind('invite')).toEqual({ kind: 'user', run: true });
    expect(slashPickKind('help')).toBeNull();
    expect(slashPickKind('nope')).toBeNull();
  });

  it('bare /join lists the other channels; Enter runs /join on the pick', () => {
    const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name: 'other' })) as unknown as { id?: string; room?: { id: string } };
    screen.joinRoom(r.id ?? r.room?.id ?? '');
    key('/join #lobby\r');
    expect(screen.model.room).toBe('lobby');
    key('/join\r');
    expect(screen.model.popup?.items).toEqual(['other']);
    key('\r');
    expect(screen.model.popup).toBeNull();
    expect(screen.model.room).toBe('other');
  });

  it('Enter in the theme panel stores the theme; the next PL start loads it', () => {
    key('/theme\r'); key('\x1b[B'); key('\r');
    expect(screen.tryRun(false, (db, ctx) => getPrefs(db, ctx))?.theme).toBe(THEMES[1].id);
    const next = open();
    next.input(Buffer.from('/theme\r', 'latin1'));
    expect(next.over.themeSel).toBe(1);
    next.close();
  });
});
