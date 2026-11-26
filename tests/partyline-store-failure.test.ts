/**
 * A store that cannot be opened (SQLITE_CANTOPEN, 2026-11-26 14:45) fails one caller's action,
 * never the hub: the screen shows a line, the session layer ends only the session that threw,
 * and the event fan-out keeps telling the other screens.
 */
import * as net from 'net';
import type { PlpFrame } from '../contract/partyline-types';
import { withAchievementsDb } from '../src/achievements/db';
import { loadChatConfig } from '../src/chat/config';
import { emitEvent, onEvents } from '../src/chat/events';
import * as sessions from '../src/chat/sessions';
import { createSession, _stopChatSweepersForTests } from '../src/chat/sessions';
import { _clearBoardKeyCacheForTests } from '../src/achievements/boards';
import { authMac, plpKeyOf } from '../src/partyline/auth';
import { encodeFrame, FrameDecoder, kvPayload, seqPayload } from '../src/partyline/frames';
import { createPartylineServer } from '../src/partyline/server';
import type { PartylineServer } from '../src/partyline/server';
import { SESSION_FAILED } from '../src/partyline/session';
import type { ScreenFactory, ScreenInfo } from '../src/partyline/session';
import { chatScreen, STORE_FAILED } from '../src/partyline/ui/screen';
import type { HubScreen } from '../src/partyline/ui/screen';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';

jest.setTimeout(30_000);

/** What better-sqlite3 throws when the file cannot be opened. */
const cantOpen = (): Error => Object.assign(new Error('unable to open database file'), { name: 'SqliteError', code: 'SQLITE_CANTOPEN' });

let fx: AchievementsFixture;
beforeEach(() => { fx = makeAchievementsFixture(); });
afterEach(() => { jest.restoreAllMocks(); _stopChatSweepersForTests(); _clearBoardKeyCacheForTests(); fx.cleanup(); });

describe('hub screen store failure', () => {
  it('tryRun shows a line instead of throwing when the session lookup cannot open the store', () => {
    const chat = loadChatConfig();
    const sid = withAchievementsDb(fx.ach, (db) => createSession(db, chat, fx.boardId, { handle: 'bob', sysop: false, client: 'test' }).sid);
    const hello = { cols: 80, rows: 25 } as ScreenInfo['hello'];
    const screen = chatScreen(fx.ach, chat)({ sid, user: 'bob', boardId: fx.boardId, hello, markDirty: () => undefined, quit: () => undefined }) as HubScreen;
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(sessions, 'resolveSession').mockImplementation(() => { throw cantOpen(); });
    try {
      expect(() => screen.tryRun(false, () => 1)).not.toThrow();
      expect(screen.model.lines[screen.model.lines.length - 1]?.text).toBe(STORE_FAILED);
      expect(() => screen.input(Buffer.from('/who\r', 'latin1'))).not.toThrow();
      expect(err.mock.calls.some((c) => String(c[0]).includes('unable to open database file'))).toBe(true);
    } finally {
      screen.close();
    }
  });
});

describe('event fan-out', () => {
  it('a listener that throws does not skip the next one', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let told = 0;
    const offA = onEvents(() => { throw cantOpen(); });
    const offB = onEvents(() => { told++; });
    try {
      withAchievementsDb(fx.ach, (db) => emitEvent(db, { type: 'board_joined', roomId: null, user: '', text: 'x' }));
      await new Promise<void>((r) => setImmediate(() => setImmediate(r)));
      expect(told).toBe(1);
    } finally { offA(); offB(); }
  });
});

describe('partyline session store failure', () => {
  class Client {
    frames: PlpFrame[] = [];
    closed = false;
    private dec = new FrameDecoder();
    constructor(readonly sock: net.Socket) {
      sock.on('data', (c: Buffer) => { this.frames.push(...this.dec.push(c)); });
      sock.on('close', () => { this.closed = true; });
      sock.on('end', () => sock.end());
      sock.on('error', () => undefined);
    }
    send(type: string, payload?: Buffer | string): void { this.sock.write(encodeFrame(type, payload)); }
    async next(type: string, ms = 3000): Promise<PlpFrame> {
      const deadline = Date.now() + ms;
      for (;;) {
        const i = this.frames.findIndex((f) => f.type === type);
        if (i >= 0) return this.frames.splice(i, 1)[0];
        if (this.closed || Date.now() > deadline) throw new Error(`no ${type} frame (got ${this.frames.map((f) => f.type).join('')})`);
        await new Promise<void>((r) => setTimeout(r, 20));
      }
    }
  }

  let hub: PartylineServer;
  afterEach(async () => { await hub.drain(); });

  it('ends only the session whose screen threw, and keeps serving the others', async () => {
    const logs: string[] = [];
    let renders = 0;
    const screen: ScreenFactory = () => ({
      resize() { /* none */ },
      input(bytes) { if (bytes.toString('latin1') === 'boom') throw cantOpen(); },
      render() { renders++; return Buffer.from(`r${renders}`); },
    });
    hub = createPartylineServer({ enabled: true, port: 0, host: '127.0.0.1', tlsCert: null, tlsKey: null }, fx.ach, { screen, log: (l) => logs.push(l) });
    const port = await hub.listen();
    const secret = fx.boardKey.split('.').slice(1).join('.');
    const dial = (): Promise<Client> => new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => resolve(new Client(s)));
      s.once('error', reject);
    });
    const login = async (c: Client, handle: string): Promise<void> => {
      c.send('H', kvPayload({ proto: '1.0', client: 'test/1', board: fx.boardId, handle, cols: 80, rows: 25 }));
      const nonce = (await c.next('N')).payload.toString('latin1');
      c.send('A', authMac(plpKeyOf(secret), nonce, fx.boardId, handle));
      await c.next('W');
      const d = await c.next('D');
      c.send('C', seqPayload(d.payload.readUInt32BE(0), Buffer.alloc(0))); // ack, else flow control holds the next D
    };

    const amy = await dial();
    await login(amy, 'amy');
    const bob = await dial();
    await login(bob, 'bob');

    bob.send('K', 'boom');
    const lines: string[] = [];
    for (;;) {
      const f = await bob.next('D').catch(() => null);
      if (!f) break;
      lines.push(f.payload.subarray(4).toString('latin1'));
      if (lines.join('').includes(SESSION_FAILED)) break;
    }
    expect(lines.join('')).toContain(SESSION_FAILED);
    expect((await bob.next('X')).payload.toString()).toBe('quit');
    expect(logs.some((l) => l.includes('[ERROR] partyline') && l.includes('unable to open database file'))).toBe(true);

    // amy's session and the listener both survive.
    amy.send('R', '100x30');
    expect((await amy.next('D')).payload.subarray(4).toString('latin1')).toMatch(/^r\d+$/);
    const carl = await dial();
    await login(carl, 'carl');
    amy.sock.destroy(); carl.sock.destroy();
  });
});
