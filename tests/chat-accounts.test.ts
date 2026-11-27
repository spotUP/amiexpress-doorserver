/**
 * Partyline global accounts (plan 2026-11-27): one test per security invariant.
 * A board key alone never reaches an existing account; a link needs the account's
 * password; handles are global; a claim rekeys the old handle@BOARD rows; a board's
 * sysop moderates that board's channels only.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './achievements/helpers';
import type { AchievementsFixture } from './achievements/helpers';
import { createBoard } from '../src/achievements/boards';
import { _stopChatSweepersForTests } from '../src/chat/sessions';
import { TOKEN_TTL_SECONDS, USER_COLUMNS } from '../src/chat/accounts';
import { _setChatClockForTests } from '../src/chat/config';

// scrypt (~100 ms per hash) dominates; under machine load a test of several hashes passes 5 s.
jest.setTimeout(30_000);
let fx: AchievementsFixture;
beforeEach(() => {
  process.env.CHAT_GLOBAL_ADMINS = 'Root';
  fx = makeAchievementsFixture();
});
afterEach(() => {
  _stopChatSweepersForTests();
  fx.cleanup();
  delete process.env.CHAT_GLOBAL_ADMINS;
});

const PW = 'correct horse';
const post = (path: string, body: object, auth = fx.auth) => request(fx.app).post(`/chat/v1${path}`).set('Authorization', auth).send(body);
const anon = (path: string, body: object) => request(fx.app).post(`/chat/v1${path}`).send(body);
function api(method: 'get' | 'post' | 'put', path: string, sid: string, auth = fx.auth) {
  return request(fx.app)[method](`/chat/v1${path}`).set('Authorization', auth).set('X-Chat-Session', sid);
}
const rowsOf = (text: string): string[][] => text.split('\r\n').filter((l) => l !== '').slice(1).map((l) => l.split('|'));
function secondBoard(): string {
  const db = fx.openAchievements();
  try {
    return `Board ${createBoard(db, 'other', 'Other', null).key}`;
  } finally {
    db.close();
  }
}

describe('Partyline accounts', () => {
  it('a board key alone never opens a session as an existing account', async () => {
    expect((await anon('/accounts/register', { handle: 'Spot', password: PW })).status).toBe(201);
    const r = await post('/sessions', { bbs_user: 'Spot', prefill: { handle: 'Spot', location: 'Lund' } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ needs_account: true, prefill: { handle: 'Spot', location: 'Lund' }, handle_free: false });
    // The pre-account call still answers, but as the board's own Spot@UPROUGH, never the account.
    expect((await post('/sessions', { handle: 'Spot' })).body.user).toBe('Spot@UPROUGH');
    // And a bot session cannot take the account's handle either.
    expect((await post('/sessions', { handle: 'spot', bot: true })).status).toBe(409);
  });

  it('linking to an existing account needs its password, once', async () => {
    await anon('/accounts/register', { handle: 'Spot', password: PW });
    const bad = await post('/accounts/link-via-board', { bbs_user: 'johan', handle: 'Spot', password: 'not the password' });
    expect(bad.status).toBe(401);
    expect((await post('/sessions', { bbs_user: 'johan' })).body.needs_account).toBe(true);
    const ok = await post('/accounts/link-via-board', { bbs_user: 'johan', handle: 'Spot', password: PW });
    expect(ok.status).toBe(201);
    expect(ok.body.user).toBe('Spot');
    expect(ok.body.account.handle).toBe('Spot');
    // From now on the link alone opens the session; another board has no link.
    const again = await post('/sessions', { bbs_user: 'JOHAN' });
    expect(again.status).toBe(201);
    expect(again.body.user).toBe('Spot');
    expect((await post('/sessions', { bbs_user: 'johan' }, secondBoard())).body.needs_account).toBe(true);
  });

  it('a taken handle answers 409 handle_taken, in any case, and creates no link', async () => {
    await anon('/accounts/register', { handle: 'Spot', password: PW });
    for (const r of [
      await anon('/accounts/register', { handle: 'sPOT', password: PW }),
      await post('/accounts/register-via-board', { bbs_user: 'johan', handle: 'spot', password: PW }),
    ]) {
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('handle_taken');
    }
    expect((await post('/sessions', { bbs_user: 'johan' })).body.needs_account).toBe(true);
  });

  it('registering through the board rekeys the old handle@BOARD rows to the account handle', async () => {
    const old = (await post('/sessions', { handle: 'alice' })).body.sid as string;
    const id = (await api('post', '/rooms', old).send({ name: 'lobby' })).body.id as string;
    await api('post', `/rooms/${id}/join`, old);
    await api('post', `/rooms/${id}/messages`, old).send({ content: 'hello', clientId: 'c1' });

    const reg = await post('/accounts/register-via-board', { bbs_user: 'alice', handle: 'Alice', password: PW });
    expect(reg.status).toBe(201);
    expect(reg.body.user).toBe('Alice');
    const sid = reg.body.sid as string;
    const hist = rowsOf((await api('get', `/rooms/${id}/history.txt`, sid)).text);
    expect(hist.some((r) => r[2] === 'Alice')).toBe(true);
    expect(hist.some((r) => r.includes('alice@UPROUGH'))).toBe(false);
    const mem = rowsOf((await api('get', `/rooms/${id}/members.txt`, sid)).text).map((r) => r[0]);
    expect(mem).toEqual(['Alice']);
    // The room she made is still hers.
    expect((await api('put', `/rooms/${id}/topic`, sid).send({ topic: 'mine' })).status).toBe(200);
  });

  it('a board sysop cannot moderate another board\'s channel; a global admin can', async () => {
    const other = secondBoard();
    const owner = (await post('/sessions', { handle: 'alice' })).body.sid as string;
    const id = (await api('post', '/rooms', owner).send({ name: 'lobby' })).body.id as string;
    const sysop = (await post('/sessions', { handle: 'boss', sysop: true }, other)).body.sid as string;
    await api('post', `/rooms/${id}/join`, sysop, other);
    expect((await api('put', `/rooms/${id}/topic`, sysop, other).send({ topic: 'taken over' })).status).toBe(403);
    // The same flag on the channel's own board does moderate it.
    const home = (await post('/sessions', { handle: 'boss', sysop: true })).body.sid as string;
    expect((await api('put', `/rooms/${id}/topic`, home).send({ topic: 'house rules' })).status).toBe(200);

    const root = (await anon('/accounts/register', { handle: 'Root', password: PW })).body.token as string;
    const acct = `Account ${root}`;
    const rs = await post('/sessions', {}, acct);
    expect(rs.status).toBe(201);
    expect(rs.body.user).toBe('Root');
    expect((await api('put', `/rooms/${id}/topic`, rs.body.sid, acct).send({ topic: 'global' })).status).toBe(200);
  });

  it('a password reset by a global admin revokes the old token; nobody else may reset', async () => {
    const spot = (await anon('/accounts/register', { handle: 'Spot', password: PW })).body;
    const root = (await anon('/accounts/register', { handle: 'Root', password: PW })).body.token as string;
    const path = `/accounts/${spot.account.id}/password`;
    expect((await post(path, { password: 'another one' }, `Account ${spot.token}`)).status).toBe(403);
    expect((await post(path, { password: 'another one' })).status).toBe(403);
    expect((await post(path, { password: 'another one' }, `Account ${root}`)).status).toBe(204);
    expect((await post('/sessions', {}, `Account ${spot.token}`)).status).toBe(401);
    expect((await anon('/accounts/login', { handle: 'spot', password: PW })).status).toBe(401);
    expect((await anon('/accounts/login', { handle: 'spot', password: 'another one' })).status).toBe(200);
  });

  it('a wrong link password claims nothing; the right one rekeys u@BOARD and keeps the newest of a clash', async () => {
    const acct = `Account ${(await anon('/accounts/register', { handle: 'Spot', password: PW })).body.token as string}`;
    const mine = (await post('/sessions', {}, acct)).body.sid as string;
    const id = (await api('post', '/rooms', mine, acct).send({ name: 'lobby' })).body.id as string;
    await api('post', `/rooms/${id}/join`, mine, acct);
    const old = (await post('/sessions', { handle: 'johan' })).body.sid as string;
    await api('post', `/rooms/${id}/join`, old);
    await api('post', `/rooms/${id}/messages`, old).send({ content: 'from the board', clientId: 'j1' });
    const db = fx.openAchievements();
    const q = <T>(sql: string, ...a: unknown[]): T[] => db.prepare(sql).all(...a) as T[];
    try {
      // Memberships clash on (user, room): the old row is newer and wins. Prefs clash on user: the account's is newer and wins.
      db.prepare('UPDATE chat_memberships SET last_active = ? WHERE user = ?').run(100, 'Spot');
      db.prepare('UPDATE chat_memberships SET last_active = ? WHERE user = ?').run(200, 'johan@UPROUGH');
      db.prepare('INSERT INTO chat_prefs (user, json, updated_at) VALUES (?, ?, ?), (?, ?, ?)').run('Spot', '{"v":"account"}', 300, 'johan@UPROUGH', '{"v":"board"}', 50);

      expect((await post('/accounts/link-via-board', { bbs_user: 'johan', handle: 'Spot', password: 'not the password' })).status).toBe(401);
      expect(q('SELECT 1 FROM chat_messages WHERE user = ?', 'johan@UPROUGH')).toHaveLength(1);
      expect(q('SELECT 1 FROM chat_memberships WHERE user = ?', 'johan@UPROUGH')).toHaveLength(1);
      expect(q('SELECT 1 FROM chat_prefs WHERE user = ?', 'johan@UPROUGH')).toHaveLength(1);

      expect((await post('/accounts/link-via-board', { bbs_user: 'johan', handle: 'Spot', password: PW })).status).toBe(201);
      for (const t of ['chat_messages', 'chat_memberships', 'chat_prefs']) expect(q(`SELECT 1 FROM ${t} WHERE lower(user) = 'johan@uprough'`)).toEqual([]);
      expect(q<{ content: string }>('SELECT content FROM chat_messages WHERE user = ?', 'Spot').map((r) => r.content)).toContain('from the board');
      expect(q<{ last_active: number }>('SELECT last_active FROM chat_memberships WHERE user = ? AND room_id = ?', 'Spot', id)).toEqual([{ last_active: 200 }]);
      expect(q<{ json: string }>('SELECT json FROM chat_prefs WHERE user = ?', 'Spot')).toEqual([{ json: '{"v":"account"}' }]);
    } finally {
      db.close();
    }
  });

  it('the claim covers every column of the built schema that holds a user key', () => {
    const db = fx.openAchievements();
    try {
      const listed = new Set(USER_COLUMNS.map((c) => `${c.table}.${c.col}`));
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'chat_%'").all() as { name: string }[]).map((t) => t.name);
      const userish: string[] = [];
      for (const t of tables) {
        for (const c of db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]) {
          if (/user|author|uploader|owner|^dm_[ab]$|^actor$|^target$|^peer$|^by$/.test(c.name)) userish.push(`${t}.${c.name}`);
        }
      }
      // Rekeyed apart from the list (claimLegacyUser), or not a user key at all.
      const apart = ['chat_rooms.owner_board'];
      expect(userish.filter((c) => !listed.has(c) && !apart.includes(c))).toEqual([]);
      for (const c of USER_COLUMNS) expect(db.prepare(`SELECT 1 FROM pragma_table_info('${c.table}') WHERE name = ?`).get(c.col)).toBeTruthy();
    } finally {
      db.close();
    }
  });
});

describe('drop roles on clash (sysop 2026-11-27): a role stays with the BBS user it was given to', () => {
  async function setup(): Promise<{ room: string; mod: string }> {
    const sys = (await post('/sessions', { handle: 'sys', sysop: true })).body.sid as string;
    const mod = (await api('post', '/roles', sys).send({ name: 'Mod', colorHex: '#ff0000', colorAnsi: 9, perms: { kick: true } })).body.id as string;
    expect((await api('put', '/roles/assignments/bob', sys).send({ roleIds: [mod] })).status).toBe(200);
    const room = (await api('post', '/rooms', sys).send({ name: 'lobby' })).body.id as string;
    return { room, mod };
  }
  const kickCarol = async (room: string, sid: string): Promise<number> => {
    const carol = (await post('/sessions', { handle: 'carol' })).body.sid as string;
    expect((await api('post', `/rooms/${room}/join`, carol)).status).toBe(200);
    expect((await api('post', `/rooms/${room}/join`, sid)).status).toBe(200);
    return (await api('post', `/rooms/${room}/kick`, sid).send({ user: 'carol@UPROUGH' })).status;
  };

  it('account bob arriving as BBS user robert does not wear the role given to legacy bob', async () => {
    const { room } = await setup();
    expect((await post('/accounts/register-via-board', { bbs_user: 'bob', handle: 'bob', password: PW }, secondBoard())).status).toBe(201);
    const robert = await post('/accounts/link-via-board', { bbs_user: 'robert', handle: 'bob', password: PW });
    expect(robert.status).toBe(201);
    expect(await kickCarol(room, robert.body.sid as string)).toBe(403);
    // Legacy bob still has his role, and takes it with him when he links himself.
    const legacy = (await post('/sessions', { handle: 'bob' })).body.sid as string;
    expect(await kickCarol(room, legacy)).toBe(200);
    const own = await post('/accounts/register-via-board', { bbs_user: 'bob', handle: 'bobby', password: PW });
    expect(own.status).toBe(201);
    expect(await kickCarol(room, own.body.sid as string)).toBe(200);
  });

  it('legacy bob linking his own account bob keeps his role', async () => {
    const { room } = await setup();
    const own = await post('/accounts/register-via-board', { bbs_user: 'bob', handle: 'bob', password: PW });
    expect(own.status).toBe(201);
    expect(await kickCarol(room, own.body.sid as string)).toBe(200);
  });
});

describe('account tokens (D10: 30 days sliding, a password change revokes all)', () => {
  let now = 1_800_000_000;
  beforeEach(() => { now = 1_800_000_000; _setChatClockForTests(() => now); });
  afterEach(() => _setChatClockForTests(null));
  const useToken = (token: string) => post('/sessions', {}, `Account ${token}`);

  it('each use renews the expiry; an expired token answers like an unknown one', async () => {
    const token = (await anon('/accounts/register', { handle: 'Spot', password: PW })).body.token as string;
    now += TOKEN_TTL_SECONDS - 10;
    expect((await useToken(token)).status).toBe(201);
    // Past the first 30 days: alive only because the use above renewed it.
    now += TOKEN_TTL_SECONDS - 10;
    expect((await useToken(token)).status).toBe(201);
    now += TOKEN_TTL_SECONDS + 1;
    const expired = await useToken(token);
    const unknown = await useToken('0'.repeat(64));
    expect(expired.status).toBe(401);
    expect(expired.body).toEqual(unknown.body);
  });

  it('a self-service password reset revokes every token of the account', async () => {
    const t1 = (await anon('/accounts/register', { handle: 'Spot', password: PW, email: 'spot@example.com' })).body.token as string;
    const t2 = (await anon('/accounts/login', { handle: 'Spot', password: PW })).body.token as string;
    expect((await anon('/accounts/password-reset/request', { email: 'spot@example.com' })).status).toBe(204);
    const db = fx.openAchievements();
    let code: string;
    try {
      const mail = db.prepare('SELECT body FROM mail_queue ORDER BY id DESC LIMIT 1').get() as { body: string };
      code = (/The code is:\n\n(\S+)\n/.exec(mail.body) as RegExpExecArray)[1];
    } finally {
      db.close();
    }
    expect((await anon('/accounts/password-reset/confirm', { email: 'spot@example.com', code, password: 'another one' })).status).toBe(204);
    expect((await useToken(t1)).status).toBe(401);
    expect((await useToken(t2)).status).toBe(401);
  });

  it('a global admin password reset revokes every token of the account', async () => {
    const spot = (await anon('/accounts/register', { handle: 'Spot', password: PW })).body;
    const t2 = (await anon('/accounts/login', { handle: 'Spot', password: PW })).body.token as string;
    const root = (await anon('/accounts/register', { handle: 'Root', password: PW })).body.token as string;
    expect((await post(`/accounts/${spot.account.id}/password`, { password: 'another one' }, `Account ${root}`)).status).toBe(204);
    expect((await useToken(spot.token as string)).status).toBe(401);
    expect((await useToken(t2)).status).toBe(401);
  });
});
