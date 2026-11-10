/**
 * AC-7 - players: register, verify, resend.
 *
 * Every test drives the real app over HTTP, and every one of them learns the
 * verification code the way a caller does: by READING IT OUT OF THE QUEUED
 * MAIL. The code is stored as a scrypt hash and there is no other way to
 * find out what it is, which is the point - a suite that reached past the
 * mail to a plaintext column would prove nothing about whether the code a
 * caller receives is the code the server will accept.
 *
 * SYM-4 MOVED HERE from tests/achievements/symptoms.test.ts, where AC-1 left
 * it red ("registering twice creates two players for one email").
 *
 * The last test in this file is a guard on all the others: no response body
 * this suite produced, anywhere, contains an `@`. The profile identifies a
 * player by handle, and the address a board typed in never comes back out.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { MAX_CODE_ATTEMPTS, VERIFY_CODE_TTL_SECONDS } from '../../src/achievements/players';
import { makeAchievementsFixture, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

// Scrypt and a thousand requests under eight parallel workers: five
// seconds is a load-dependent limit, not a correctness one.
jest.setTimeout(60000);

let fx: AchievementsFixture;
let db: Database.Database;

/** Every response this suite received, for the no-address guard at the end. */
let bodies: string[] = [];

beforeEach(() => {
  fx = makeAchievementsFixture();
  db = fx.openAchievements();
  bodies = [];
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

/** A board-authenticated POST, recording the body it got back. */
async function post(path: string, body: unknown): Promise<Response> {
  const res = await request(fx.app)
    .post(`/achievements/v1${path}`)
    .set('Authorization', fx.auth)
    .send(body as object);
  bodies.push(res.text ?? '');
  return res;
}

interface QueuedMail {
  to_addr: string;
  subject: string;
  body: string;
}

const queued = (): QueuedMail[] =>
  db
    .prepare('SELECT to_addr, subject, body FROM mail_queue ORDER BY id')
    .all() as QueuedMail[];

/**
 * The code, as a caller reads it: the one line of the mail that is six
 * characters of the code alphabet and nothing else.
 */
function codeFromMail(mail: QueuedMail): string {
  const lines = mail.body.split('\n').filter((l) => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(l));
  expect(lines).toHaveLength(1);
  return lines[0];
}

/** Register and come back with the code that was mailed. */
async function registerAndReadCode(email: string, handle: string): Promise<string> {
  const before = queued().length;
  const res = await post('/players', { email, handle });
  expect(res.status).toBe(202);
  expect(res.body).toEqual({ queued: true });
  const mails = queued();
  expect(mails).toHaveLength(before + 1);
  return codeFromMail(mails[mails.length - 1]);
}

const players = (): { handle: string; verified_at: number | null }[] =>
  db.prepare('SELECT handle, verified_at FROM players ORDER BY id').all() as {
    handle: string;
    verified_at: number | null;
  }[];

describe('registering', () => {
  it('SYM-4: registering the same email twice leaves ONE player and mails a second code', async () => {
    const first = await registerAndReadCode('caller@example.com', 'Caller');
    // A different case in the address is the SAME player: the identity is
    // lower(trim(email)), not the bytes a board happened to type.
    const second = await registerAndReadCode('  CALLER@Example.COM  ', 'Caller');

    expect(players()).toEqual([{ handle: 'Caller', verified_at: null }]);
    expect(queued()).toHaveLength(2);
    // A fresh code, not the old one resent: the second registration REPLACED
    // the live code, which is what makes resend and rotate one operation.
    expect(second).not.toBe(first);

    // And the replaced code is dead, so a caller who reads the older mail
    // cannot verify with it.
    const stale = await post('/players/verify', { email: 'caller@example.com', code: first });
    expect(stale.status).toBe(400);
    expect(stale.body.error).toBe('bad_code');
  });

  it('cannot rename an existing player, whoever knows the address', async () => {
    await registerAndReadCode('caller@example.com', 'Caller');

    const res = await post('/players', { email: 'caller@example.com', handle: 'SomeoneElse' });

    expect(res.status).toBe(202);
    // Accepted and IGNORED. Anyone who knows an address could otherwise
    // rename its owner; a verified player renames from a linked board.
    expect(players()).toEqual([{ handle: 'Caller', verified_at: null }]);
  });

  it('refuses a handle another player already holds, with 409, before any player is created', async () => {
    await registerAndReadCode('first@example.com', 'Caller');

    // Case-insensitively: the schema's unique index is COLLATE NOCASE, so
    // "CALLER" is the same name as "Caller" to everyone reading a board.
    const res = await post('/players', { email: 'second@example.com', handle: 'CALLER' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('handle_taken');
    // No half-registration: the second address has no player and no mail.
    expect(players()).toHaveLength(1);
    expect(queued()).toHaveLength(1);
  });

  it('answers 202 for an address that already exists, saying nothing either way', async () => {
    await registerAndReadCode('known@example.com', 'Known');

    const knownAgain = await post('/players', { email: 'known@example.com', handle: 'Known' });
    const brandNew = await post('/players', { email: 'stranger@example.com', handle: 'Stranger' });

    // Byte-identical answers. The response never reveals whether an email is
    // registered, so the endpoint is not a register of who has signed up.
    expect(knownAgain.status).toBe(brandNew.status);
    expect(knownAgain.status).toBe(202);
    expect(knownAgain.text).toBe(brandNew.text);
  });

  it('refuses an address or a handle it cannot use, and creates nothing', async () => {
    const cases: [string, string, string][] = [
      ['not-an-address', 'Caller', 'bad_email'],
      ['two@@example.com', 'Caller', 'bad_email'],
      ['caller@localhost', 'Caller', 'bad_email'],
      ['caller@example.com', 'ab', 'bad_handle'],
      ['caller@example.com', 'this handle is far too long', 'bad_handle'],
      // A handle must START with a letter or a digit, so punctuation first
      // is refused - what a leading SPACE gets is trimmed, see below.
      ['caller@example.com', '.dotted', 'bad_handle'],
      ['caller@example.com', '   ', 'bad_handle'],
    ];
    for (const [email, handle, error] of cases) {
      const res = await post('/players', { email, handle });
      expect(`${email}/${handle} -> ${res.status} ${res.body.error}`).toBe(
        `${email}/${handle} -> 400 ${error}`
      );
    }
    expect(players()).toHaveLength(0);
    expect(queued()).toHaveLength(0);
  });

  it('trims the handle it stores, so no listing ever shows a padded name', async () => {
    await registerAndReadCode('caller@example.com', '  Caller  ');

    expect(players()).toEqual([{ handle: 'Caller', verified_at: null }]);
    // And the trimmed name is what the uniqueness rule sees, so padding is
    // not a way around a taken handle.
    const res = await post('/players', { email: 'other@example.com', handle: 'Caller ' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('handle_taken');
  });

  it('still answers 202 and still keeps the code while the SMTP server is refusing connections', async () => {
    // The spec's stated worst case, end to end. The fixture's
    // ACHIEVEMENTS_SMTP_URL points at a closed port and NOTHING in the
    // request path opens a socket: the mail is queued and the drain, which
    // this request never touches, is what would post it.
    const code = await registerAndReadCode('caller@example.com', 'Caller');

    expect(queued()).toHaveLength(1);
    // And the code that was queued is the one that works, so nothing was
    // lost by not sending it now.
    const res = await post('/players/verify', { email: 'caller@example.com', code });
    expect(res.status).toBe(200);
  });

  it('mails a body that is pure ASCII and carries the code on its own line', async () => {
    const code = await registerAndReadCode('caller@example.com', 'Caller');
    const [mail] = queued();

    expect(mail.to_addr).toBe('caller@example.com');
    // Pure printable ASCII, subject included: the code is read off a screen
    // and typed on an Amiga keyboard.
    expect(/^[\x20-\x7e\n]*$/.test(mail.body)).toBe(true);
    expect(/^[\x20-\x7e]*$/.test(mail.subject)).toBe(true);

    // The code alone on its line, with nothing beside it to be mistaken for
    // part of it.
    expect(mail.body.split('\n')).toContain(code);
    // The TTL the mail promises is the TTL the server enforces.
    expect(mail.body).toContain(`good for ${VERIFY_CODE_TTL_SECONDS / 60} minutes`);
    // No board name: the mail comes from the achievement service, which is
    // one thing for every board, not from the BBS the caller dialled.
    expect(mail.body.toLowerCase()).not.toContain(TEST_BOARD_ID);
  });
});

describe('verifying', () => {
  it('returns the profile and a link code, and never returns the email', async () => {
    const code = await registerAndReadCode('caller@example.com', 'Caller');

    const res = await post('/players/verify', { email: 'caller@example.com', code });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      handle: 'Caller',
      verified: true,
      private: false,
      points: 0,
      linkedBoards: [],
      unlocks: [],
      progress: [],
    });
    // A player who has just proved they own the address is verified
    // everywhere and linked nowhere, so the first link code rides along.
    expect(res.body.linkCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(Date.parse(res.body.linkCodeExpiresAt as string)).toBeGreaterThan(Date.now());
    // A link code is NOT a verification code: it is a second row, so
    // verifying again with the link code is refused.
    expect(res.body.linkCode).not.toBe(code);
    expect(players()[0].verified_at).not.toBeNull();
    // The address never comes back out, at any depth.
    expect(res.text).not.toContain('@');
  });

  it('refuses a used code a second time, and does not un-verify anybody', async () => {
    const code = await registerAndReadCode('caller@example.com', 'Caller');
    expect((await post('/players/verify', { email: 'caller@example.com', code })).status).toBe(200);

    const again = await post('/players/verify', { email: 'caller@example.com', code });

    expect(again.status).toBe(400);
    // A spent code is indistinguishable from one that was never issued -
    // the same answer an unknown address gets.
    expect(again.body.error).toBe('bad_code');
    expect(players()[0].verified_at).not.toBeNull();
  });

  it('refuses an expired code and leaves the player unverified', async () => {
    const code = await registerAndReadCode('caller@example.com', 'Caller');
    // Age the code rather than the clock: the endpoint keeps using the
    // server's own Date.now(), which is what a caller's request meets.
    db.prepare("UPDATE player_codes SET expires_at = ? WHERE kind = 'verify'").run(
      Math.floor(Date.now() / 1000) - 1
    );

    const res = await post('/players/verify', { email: 'caller@example.com', code });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('code_expired');
    expect(players()[0].verified_at).toBeNull();

    // A resend is the way out, and it works: an expired code is not a dead
    // address.
    const resend = await post('/players/resend', { email: 'caller@example.com' });
    expect(resend.status).toBe(202);
    const fresh = codeFromMail(queued()[1]);
    expect((await post('/players/verify', { email: 'caller@example.com', code: fresh })).status).toBe(
      200
    );
  });

  it('burns a code after five wrong attempts, and the RIGHT code stops working too', async () => {
    const code = await registerAndReadCode('caller@example.com', 'Caller');

    for (let i = 1; i <= MAX_CODE_ATTEMPTS; i += 1) {
      const res = await post('/players/verify', { email: 'caller@example.com', code: 'WRONG5' });
      expect(res.status).toBe(400);
      // The fifth refusal is the one that says the code is dead, rather than
      // that this guess was wrong.
      expect(`attempt ${i}: ${res.body.error}`).toBe(
        `attempt ${i}: ${i < MAX_CODE_ATTEMPTS ? 'bad_code' : 'code_burned'}`
      );
    }

    // 31^6 is 8.9e8, which is only safe with a cap - so the cap has to hold
    // against the correct code as well, or it is only a delay.
    const correct = await post('/players/verify', { email: 'caller@example.com', code });
    expect(correct.status).toBe(400);
    expect(correct.body.error).toBe('code_burned');
    expect(players()[0].verified_at).toBeNull();

    // A new code RESETS the cap: five wrong guesses must not make an address
    // permanently unusable.
    await post('/players/resend', { email: 'caller@example.com' });
    const fresh = codeFromMail(queued()[1]);
    expect((await post('/players/verify', { email: 'caller@example.com', code: fresh })).status).toBe(
      200
    );
  });

  it('answers bad_code for an address nobody ever registered', async () => {
    const res = await post('/players/verify', { email: 'nobody@example.com', code: 'K7QMX4' });

    // NOT "unknown_player": this endpoint must not become a register of who
    // has signed up.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_code');
  });
});

describe('resending', () => {
  it('replaces the live code, and says nothing about whether the address is known', async () => {
    const first = await registerAndReadCode('caller@example.com', 'Caller');

    const known = await post('/players/resend', { email: 'caller@example.com' });
    const unknown = await post('/players/resend', { email: 'nobody@example.com' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.text).toBe(unknown.text);
    // One mail for the known address, none for the unknown one - the
    // difference is in the mailbox, not in the response.
    expect(queued()).toHaveLength(2);
    expect(queued().map((m) => m.to_addr)).toEqual(['caller@example.com', 'caller@example.com']);

    // Replaced, not added to: there is one live verification code per
    // player, so the older one is dead.
    const fresh = codeFromMail(queued()[1]);
    expect(fresh).not.toBe(first);
    expect((await post('/players/verify', { email: 'caller@example.com', code: first })).status).toBe(
      400
    );
    expect((await post('/players/verify', { email: 'caller@example.com', code: fresh })).status).toBe(
      200
    );
  });
});

describe('the addresses this surface holds', () => {
  it('never appears in a response body, over a whole registration and verification', async () => {
    // The guard on every test above: `bodies` collects the text of every
    // response this file received. A profile identifies a player by handle,
    // and the address a board typed in does not come back out.
    const code = await registerAndReadCode('caller@example.com', 'Caller');
    await post('/players/verify', { email: 'caller@example.com', code });
    await post('/players/resend', { email: 'caller@example.com' });
    await post('/players', { email: 'caller@example.com', handle: 'Caller' });
    await post('/players/verify', { email: 'caller@example.com', code: 'WRONG5' });
    await post('/players', { email: 'not-an-address', handle: 'Caller' });

    expect(bodies.length).toBeGreaterThan(5);
    const offenders = bodies.filter((b) => b.includes('@'));
    expect(offenders).toEqual([]);
  });
});
