/**
 * Partyline hub lane 1f: the LIVECHAT Create Channel form (create-channel-dialog.ts), the typed pick lists
 * (server.ts typedPickListCommand) and the theme kept in the prefs store across sessions.
 */
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { createRoom, getPrefs, leaveRoom, listRooms } from '../src/chat/store';
import { noteTarget } from '../src/partyline/commands';
import { chatScreen } from '../src/partyline/ui/screen';
import { CF_CANCEL, CF_CREATE, CF_PRIVATE, CF_TOPIC, HIT_CREATE_F, HIT_CREATE_KIND } from '../src/partyline/ui/overlays';
import { slashPickKind } from '../src/partyline/ui/slash';
import { newSide, SIDE_USER, THEMES } from '../src/partyline/ui/model';
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

  it('Create and Cancel show at rest in every theme (ground on ok), the focused one in the selection colours', () => {
    key('/create\r'); // focus on Name: neither button focused
    const c = screen.cells, p = screen.model.pal;
    const pens = (id: number): Array<[number, number]> => {
      const out: Array<[number, number]> = [];
      for (let r = 0; r < 25; r++) for (let k = 0; k < 80; k++) {
        if (screen.drawState.hits.at(r, k).id === id) { const v = c.back[r * 80 + k]; out.push([(v >>> 8) & 0xff, (v >>> 16) & 0xff]); }
      }
      return out;
    };
    for (const t of THEMES) {
      p.set(t.rgb); screen.render(true);
      for (const f of [CF_CREATE, CF_CANCEL]) {
        const at = pens(HIT_CREATE_F + f);
        expect(at.length).toBe(10);
        for (const [fg, bg] of at) { expect(`${t.id} ${fg}`).not.toBe(`${t.id} ${bg}`); expect(bg).toBe(p.ok); }
      }
    }
    for (let i = 0; i < 6; i++) key('\t'); // Name -> Cancel
    expect(screen.over.createField).toBe(CF_CANCEL);
    screen.render(true);
    for (const [fg, bg] of pens(HIT_CREATE_F + CF_CANCEL)) expect([fg, bg]).toEqual([p.col[9], p.col[8]]);
  });

  it('/join lists every joinable room, not only joined ones; titled Channel; /j and /d open their lists', () => {
    const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name: 'far' })) as unknown as { id?: string; room?: { id: string } };
    const id = r.id ?? r.room?.id ?? '';
    screen.tryRun(true, (db, ctx) => leaveRoom(db, ctx, id));
    key('/j'); esc(); key('\r'); // Esc closes the "/" menu, which would complete /j to /join
    expect(screen.model.popup?.items).toEqual(['far']);
    expect(screen.model.popup?.title).toBe(' Channel ');
    esc();
    screen.model.side.push(newSide(SIDE_USER, false, 'carol'));
    key('/d'); esc(); key('\r');
    expect(screen.model.popup?.items).toContain('carol');
    expect(screen.model.popup?.title).toBe(' User ');
  });

  it('Enter with the "/" menu open runs an alias or a line with arguments; only a partial word is filled', () => {
    const r = screen.tryRun(true, (db, ctx) => createRoom(db, ctx, { name: 'far' })) as unknown as { id?: string; room?: { id: string } };
    screen.tryRun(true, (db, ctx) => leaveRoom(db, ctx, r.id ?? r.room?.id ?? ''));
    key('/j\r'); // C_ALIAS j: LIVECHAT's registry lists it, so Enter runs /join (its pick list), no fill to "/join "
    expect(screen.model.popup?.items).toEqual(['far']);
    esc();
    expect(screen.model.input).toBe('');
    key('/j'); key('\x1b'); key('\r'); // a lone Esc chunk, then Enter: the typed alias still runs
    expect(screen.model.popup?.items).toEqual(['far']);
    esc();
    key('/j'); key('\x1b\r'); // Esc and Enter in one telnet chunk
    expect(screen.model.popup?.items).toEqual(['far']);
    esc();
    key('/away status\r'); // "away status" is in the /away description, so the menu is open: the typed line runs as typed
    expect(screen.model.lines.some((l) => l.text.includes('You are now away: status'))).toBe(true);
    expect(screen.model.lines.some((l) => /^\/(j|away)/.test(l.text))).toBe(false); // no slash line posted as chat
    key('/jo\r'); // a partial word is still filled, as LIVECHAT does
    expect(screen.model.input).toBe('/join ');
  });

  it('/note takes a listed handle with a space whole, else the first word', () => {
    screen.model.side.push(newSide(SIDE_USER, false, 'big bob'));
    expect(noteTarget(screen, '@big bob owes me')).toBe('@big bob');
    expect(noteTarget(screen, 'big bob owes me')).toBe('big bob');
    expect(noteTarget(screen, 'bigger x')).toBe('bigger');
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
