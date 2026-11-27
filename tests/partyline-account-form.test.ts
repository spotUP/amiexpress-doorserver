/**
 * H2: a board caller with no Partyline account link (POST /sessions -> NeedsAccountReply) gets the
 * register-or-link form on the hub-rendered screen; on success the same connection goes into Partyline.
 * The account endpoints are mocked (contract types only): H1 owns them.
 */
import * as net from 'net';
import type { BoardAccountReply, NeedsAccountReply, RegisterViaBoardRequest } from '../contract/chat-types';
import type { PlpFrame } from '../contract/partyline-types';
import { _clearBoardKeyCacheForTests } from '../src/achievements/boards';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { AccountForm, FORM_TEXT } from '../src/partyline/account-form';
import type { AccountFormInfo, AccountGateway } from '../src/partyline/account-form';
import { authMac, plpKeyOf } from '../src/partyline/auth';
import { encodeFrame, FrameDecoder, kvPayload, parseKv, seqPayload } from '../src/partyline/frames';
import { createPartylineServer } from '../src/partyline/server';
import type { ScreenFactory, ScreenInfo } from '../src/partyline/session';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';

jest.setTimeout(30_000);

const needs: NeedsAccountReply = { needs_account: true, prefill: { handle: 'spot', realname: 'Johan', location: 'Sweden' }, handle_free: true };
const accountReply = (user: string): BoardAccountReply => ({
  sid: 'a'.repeat(32), user, expiresIn: 90, activeWindow: 30,
  account: { id: 1, handle: user, realname: '', location: '', hasEmail: false, bot: false, globalAdmin: false, createdAt: 0 },
});
const refusal = (status: number, code: string): Error => Object.assign(new Error(code), { status, code });

function form(over: Partial<AccountFormInfo> = {}) {
  const done = jest.fn();
  const quit = jest.fn();
  const f = new AccountForm({
    bbsUser: 'spot', reply: needs, hello: { sysop: false, client: 'test/1' } as ScreenInfo['hello'],
    register: jest.fn(() => accountReply('spot')), link: jest.fn(() => accountReply('spot')),
    markDirty: () => undefined, quit, done, ...over,
  });
  const type = (s: string): void => f.input(Buffer.from(s, 'latin1'));
  const screen = (): string => f.render().toString('latin1');
  return { f, done, quit, type, screen };
}

describe('account form', () => {
  it('registers with the prefill and the password typed twice', () => {
    const register = jest.fn((_r: RegisterViaBoardRequest) => accountReply('spot'));
    const { type, done, screen } = form({ register });
    expect(screen()).toContain(FORM_TEXT.choose);
    type('r');
    expect(screen()).toContain('Handle: spot');
    type('\r\r\r\r'); // handle, real name, location from the prefill; email left empty
    type('hunter22\r');
    type('hunter22\r');
    expect(register).toHaveBeenCalledWith({ bbs_user: 'spot', handle: 'spot', password: 'hunter22', sysop: false, client: 'test/1', realname: 'Johan', location: 'Sweden', email: undefined });
    expect(done).toHaveBeenCalledWith(accountReply('spot'));
  });

  it('asks a new handle when the first is taken (409) and registers with it', () => {
    const register = jest.fn()
      .mockImplementationOnce(() => { throw refusal(409, 'handle_taken'); })
      .mockImplementation((r: RegisterViaBoardRequest) => accountReply(r.handle));
    const { type, done, screen } = form({ register });
    type('r\r\r\r\rhunter22\rhunter22\r');
    expect(done).not.toHaveBeenCalled();
    expect(screen()).toContain(FORM_TEXT.handleTaken);
    expect(screen()).toMatch(/Handle: $/m); // cleared for the new one
    type('spot2\r\r\r\rhunter22\rhunter22\r');
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[1][0]).toMatchObject({ bbs_user: 'spot', handle: 'spot2', password: 'hunter22' });
    expect(done).toHaveBeenCalledWith(accountReply('spot2'));
  });

  it('links with a wrong then the right password, entered once each, never auto-linking', () => {
    const link = jest.fn()
      .mockImplementationOnce(() => { throw refusal(401, 'unauthorized'); })
      .mockImplementation(() => accountReply('Spot'));
    const { type, done, screen } = form({ link });
    expect(link).not.toHaveBeenCalled(); // the prefill alone links nothing
    type('l');
    type('\rwrongpw\r');
    expect(link).toHaveBeenLastCalledWith({ bbs_user: 'spot', handle: 'spot', password: 'wrongpw', sysop: false, client: 'test/1' });
    expect(screen()).toContain(FORM_TEXT.wrongPassword);
    expect(done).not.toHaveBeenCalled();
    type('rightpw\r');
    expect(link).toHaveBeenLastCalledWith(expect.objectContaining({ handle: 'spot', password: 'rightpw' }));
    expect(done).toHaveBeenCalledWith(accountReply('Spot'));
  });

  it('echoes passwords as stars, never the text', () => {
    const { type, screen } = form();
    type('r\r\r\r\rsecret99');
    expect(screen()).toContain('Password: ********');
    type('\rsecret9');
    expect(screen()).toContain('Password again: *******');
    expect(screen()).not.toContain('secret9');
    type('\b\b\b');
    expect(screen()).toMatch(/Password again: \*{4}$/m);
  });

  it('refuses mismatched passwords without calling register', () => {
    const register = jest.fn(() => accountReply('spot'));
    const { type, screen } = form({ register });
    type('r\r\r\r\rhunter22\rhunter23\r');
    expect(register).not.toHaveBeenCalled();
    expect(screen()).toContain(FORM_TEXT.mismatch);
  });
});

describe('PLP login without an account link', () => {
  let fx: AchievementsFixture;
  beforeEach(() => { fx = makeAchievementsFixture(); });
  afterEach(() => { _stopChatSweepersForTests(); _clearBoardKeyCacheForTests(); fx.cleanup(); });

  it('shows the form, then enters Partyline on the linked account session', async () => {
    const screens: ScreenInfo[] = [];
    const chatScreen: ScreenFactory = (info) => { screens.push(info); return { resize() {}, input() {}, render: () => Buffer.from(`chat ${info.user}`) }; };
    const accounts: AccountGateway = {
      open: jest.fn(() => needs),
      register: jest.fn(),
      link: jest.fn(() => accountReply('Spot')),
    };
    const hub = createPartylineServer({ enabled: true, port: 0, host: '127.0.0.1', tlsCert: null, tlsKey: null }, fx.ach, { screen: chatScreen, log: () => undefined, accounts });
    const port = await hub.listen();
    const frames: PlpFrame[] = [];
    const dec = new FrameDecoder();
    const sock = await new Promise<net.Socket>((resolve) => { const s = net.connect(port, '127.0.0.1', () => resolve(s)); });
    sock.on('data', (c: Buffer) => frames.push(...dec.push(c)));
    sock.on('error', () => undefined);
    const next = async (type: string): Promise<PlpFrame> => {
      for (let i = 0; i < 100; i++) {
        const at = frames.findIndex((f) => f.type === type);
        if (at >= 0) return frames.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`no ${type} (got ${frames.map((f) => f.type).join('')})`);
    };
    /** The next D frame's text, acked so the one after can come. */
    const screenText = async (): Promise<string> => {
      const d = await next('D');
      sock.write(encodeFrame('C', seqPayload(d.payload.readUInt32BE(0), Buffer.alloc(0))));
      return d.payload.subarray(4).toString('latin1');
    };
    try {
      sock.write(encodeFrame('H', kvPayload({ proto: '1.0', client: 'test/1', board: fx.boardId, handle: 'spot', cols: 80, rows: 25, realname: 'Johan', location: 'Sweden' })));
      const nonce = (await next('N')).payload.toString('latin1');
      sock.write(encodeFrame('A', authMac(plpKeyOf(fx.boardKey.split('.').slice(1).join('.')), nonce, fx.boardId, 'spot')));
      expect(parseKv((await next('W')).payload).get('resume')).toBe('');
      expect(accounts.open).toHaveBeenCalledWith(expect.anything(), fx.boardId, { bbs_user: 'spot', prefill: { handle: 'spot', realname: 'Johan', location: 'Sweden', email: undefined }, sysop: false, client: 'test/1' });
      expect(await screenText()).toContain(FORM_TEXT.title);
      expect(screens).toHaveLength(0);
      sock.write(encodeFrame('K', 'l\rpartyon\r'));
      let shown = '';
      while (!shown.startsWith('chat ')) shown = await screenText();
      expect(shown).toBe('chat Spot');
      expect(screens[0]).toMatchObject({ sid: 'a'.repeat(32), user: 'Spot', boardId: fx.boardId });
      expect(accounts.link).toHaveBeenCalledWith(expect.anything(), fx.boardId, expect.objectContaining({ bbs_user: 'spot', handle: 'spot', password: 'partyon' }));
    } finally {
      sock.destroy();
      await hub.drain();
    }
  });
});
