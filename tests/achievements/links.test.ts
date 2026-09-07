/**
 * AC-8 - links: link, unlink, rotate, and meta.link.
 *
 * Every test drives the real app over HTTP. A player is registered and
 * verified the way a caller is - the verification code is read out of the
 * queued mail - and the FIRST link code comes back on the verify response,
 * exactly as the door will receive it.
 *
 * SYM-5 ("a board reports for an email that never linked it and the events
 * land") STAYS in tests/achievements/symptoms.test.ts, red, until AC-9
 * writes POST /events - the endpoint it drives. This task delivers the half
 * it honestly can: the link row exists for the key's board only, and nothing
 * here can create one for any other board. The same goes for "unlinking
 * stops new events": asserted at the storage level here, and again through
 * POST /events in AC-9.
 *
 * The last test is the guard the players suite has: no body this suite ever
 * received contains an `@`.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { createBoard } from '../../src/achievements/boards';
import { makeAchievementsFixture, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

let fx: AchievementsFixture;
let db: Database.Database;
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

async function send(method: 'post' | 'delete', path: string, body: unknown, auth = fx.auth): Promise<Response> {
  const res = await request(fx.app)
    [method](`/achievements/v1${path}`)
    .set('Authorization', auth)
    .send(body as object);
  bodies.push(res.text ?? '');
  return res;
}

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

function codeFromLatestMail(): string {
  const mail = db.prepare('SELECT body FROM mail_queue ORDER BY id DESC LIMIT 1').get() as { body: string };
  const lines = mail.body.split('\n').filter((l) => CODE.test(l));
  expect(lines).toHaveLength(1);
  return lines[0];
}

/** Register, verify, and come back holding the first link code. */
async function verifiedPlayer(email: string, handle: string): Promise<string> {
  expect((await send('post', '/players', { email, handle })).status).toBe(202);
  const verify = await send('post', '/players/verify', { email, code: codeFromLatestMail() });
  expect(verify.status).toBe(200);
  expect(verify.body.linkCode).toMatch(CODE);
  return verify.body.linkCode as string;
}

/** A second board, minted the way the CLI mints one, with its own key. */
function secondBoard(id = 'other'): string {
  return `Board ${createBoard(db, id, 'Other Board', null).key}`;
}

const links = (): { board_id: string }[] =>
  db.prepare('SELECT board_id FROM links ORDER BY board_id').all() as { board_id: string }[];

const metaLinks = (): { key: string; n: number }[] =>
  db
    .prepare(
      `SELECT e.key, c.n FROM events e
         JOIN counters c ON c.player_id = e.player_id AND c.type = e.type AND c.key = ''
        WHERE e.type = 'meta.link' ORDER BY e.key`
    )
    .all() as { key: string; n: number }[];

describe('linking', () => {
  it('a link is for the key\'s board only, and a board that never linked the address has no row', async () => {
    const code = await verifiedPlayer('caller@example.com', 'Caller');
    secondBoard();

    const res = await send('post', '/links', { email: 'caller@example.com', code });

    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(res.body.boards).toEqual([TEST_BOARD_ID]);
    // Storage says the same: one row, this board. 'other' reporting for this
    // address is what SYM-5 will refuse once POST /events exists (AC-9).
    expect(links()).toEqual([{ board_id: TEST_BOARD_ID }]);
    expect(metaLinks()).toEqual([{ key: TEST_BOARD_ID, n: 1 }]);
  });

  it('a link code works exactly once and the second board must use the fresh one', async () => {
    const first = await verifiedPlayer('caller@example.com', 'Caller');
    const other = secondBoard();

    const one = await send('post', '/links', { email: 'caller@example.com', code: first });
    expect(one.status).toBe(200);
    const fresh = one.body.linkCode as string;
    expect(fresh).toMatch(CODE);
    expect(fresh).not.toBe(first);

    // The spent code is worthless at the next board...
    const stale = await send('post', '/links', { email: 'caller@example.com', code: first }, other);
    expect(stale.status).toBe(400);
    expect(stale.body.error).toBe('bad_code');
    expect(links()).toEqual([{ board_id: TEST_BOARD_ID }]);

    // ...and the fresh one links it.
    const two = await send('post', '/links', { email: 'caller@example.com', code: fresh }, other);
    expect(two.status).toBe(200);
    expect(two.body.boards).toEqual(['other', TEST_BOARD_ID]);
    expect(metaLinks()).toEqual([
      { key: 'other', n: 2 },
      { key: TEST_BOARD_ID, n: 2 },
    ]);
  });

  it('an expired link code is refused and the player can rotate a new one', async () => {
    const code = await verifiedPlayer('caller@example.com', 'Caller');
    // The clock, moved: the code's expiry is set into the past, which is the
    // only way a fifteen-minute TTL can lapse inside a test.
    db.prepare(`UPDATE player_codes SET expires_at = expires_at - 3600 WHERE kind = 'link'`).run();

    const expired = await send('post', '/links', { email: 'caller@example.com', code });
    expect(expired.status).toBe(400);
    expect(expired.body.error).toBe('code_expired');
    expect(links()).toEqual([]);

    // Rotation takes the expired code as the proof of identity...
    const rotated = await send('post', '/links/rotate', { email: 'caller@example.com', code });
    expect(rotated.status).toBe(200);
    expect(rotated.body.linkCode).toMatch(CODE);
    expect(rotated.body.linkCode).not.toBe(code);
    expect(typeof rotated.body.linkCodeExpiresAt).toBe('string');

    // ...and refuses a wrong one, because rotation is not a way around the code.
    const wrong = await send('post', '/links/rotate', { email: 'caller@example.com', code: 'ZZZZZZ' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('bad_code');

    const linked = await send('post', '/links', { email: 'caller@example.com', code: rotated.body.linkCode });
    expect(linked.status).toBe(200);
    expect(links()).toEqual([{ board_id: TEST_BOARD_ID }]);
  });

  it('a board can only unlink itself, never another board', async () => {
    const first = await verifiedPlayer('caller@example.com', 'Caller');
    const other = secondBoard();
    const one = await send('post', '/links', { email: 'caller@example.com', code: first });
    await send('post', '/links', { email: 'caller@example.com', code: one.body.linkCode }, other);
    expect(links()).toEqual([{ board_id: 'other' }, { board_id: TEST_BOARD_ID }]);

    // 'other' unlinks. There is no board field to name anyone else.
    const res = await send('delete', '/links', { email: 'caller@example.com' }, other);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: false, boards: [TEST_BOARD_ID] });
    expect(links()).toEqual([{ board_id: TEST_BOARD_ID }]);
  });

  it('unlinking removes the link and keeps the unlocks already earned', async () => {
    const code = await verifiedPlayer('caller@example.com', 'Caller');
    await send('post', '/links', { email: 'caller@example.com', code });
    // An unlock the engine (AC-10) will write; here it is storage that must
    // survive the unlink, and the row records the board it was earned on.
    db.prepare(
      `INSERT INTO achievements (id, name, description, family, tier, points, hidden, rule, digest, source, created_at, updated_at)
       VALUES ('msg.first', 'First Words', 'Post a message', 'msg', 'bronze', 5, 0, '{"op":"first","type":"msg.post"}', 'x', 'seed', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO unlocks (player_id, achievement_id, board_id, season_id, at) VALUES (1, 'msg.first', ?, '2026Q3', 1)`
    ).run(TEST_BOARD_ID);

    const res = await send('delete', '/links', { email: 'caller@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linked: false, boards: [] });
    expect(links()).toEqual([]);
    expect(db.prepare('SELECT achievement_id, board_id FROM unlocks').all()).toEqual([
      { achievement_id: 'msg.first', board_id: TEST_BOARD_ID },
    ]);
    // And unlinking is idempotent: nothing to remove is still a 200.
    const again = await send('delete', '/links', { email: 'caller@example.com' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ linked: false, boards: [] });
  });

  it('relinking the same board does not append a second meta.link', async () => {
    const first = await verifiedPlayer('caller@example.com', 'Caller');
    const one = await send('post', '/links', { email: 'caller@example.com', code: first });

    // Linking again while linked: an idempotent success that changes nothing
    // - not even the code, which is still the player's to use elsewhere.
    const same = await send('post', '/links', { email: 'caller@example.com', code: 'ZZZZZZ' });
    expect(same.status).toBe(200);
    expect(same.body).toEqual({ linked: true, boards: [TEST_BOARD_ID] });

    // Unlink, then link again with the code the first link issued.
    await send('delete', '/links', { email: 'caller@example.com' });
    const back = await send('post', '/links', { email: 'caller@example.com', code: one.body.linkCode });
    expect(back.status).toBe(200);
    expect(links()).toEqual([{ board_id: TEST_BOARD_ID }]);

    // One meta.link, one count: the player linked this board, once, ever.
    expect(metaLinks()).toEqual([{ key: TEST_BOARD_ID, n: 1 }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'meta.link'`).get()).toEqual({ n: 1 });
  });

  it('an unverified player cannot link a board', async () => {
    expect((await send('post', '/players', { email: 'caller@example.com', handle: 'Caller' })).status).toBe(202);
    const verifyCode = codeFromLatestMail();

    const res = await send('post', '/links', { email: 'caller@example.com', code: verifyCode });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unverified_player');
    expect(links()).toEqual([]);
    // An address nobody registered is bad_code, not a hint that it is unknown.
    const nobody = await send('post', '/links', { email: 'nobody@example.com', code: verifyCode });
    expect(nobody.status).toBe(400);
    expect(nobody.body.error).toBe('bad_code');
  });

  it('the profile lists every board that is reporting for the player', async () => {
    const first = await verifiedPlayer('caller@example.com', 'Caller');
    const other = secondBoard();
    const third = secondBoard('third');
    const one = await send('post', '/links', { email: 'caller@example.com', code: first });
    const two = await send('post', '/links', { email: 'caller@example.com', code: one.body.linkCode }, other);
    const three = await send('post', '/links', { email: 'caller@example.com', code: two.body.linkCode }, third);

    expect(three.status).toBe(200);
    expect(three.body.boards).toEqual(['other', 'third', TEST_BOARD_ID]);
    // The profile reads the same rows the link response does.
    const profile = db.prepare('SELECT board_id FROM links WHERE player_id = 1 ORDER BY board_id').all();
    expect(profile).toEqual([{ board_id: 'other' }, { board_id: 'third' }, { board_id: TEST_BOARD_ID }]);
  });

  it('linking a second board unlocks the two-boards award, at the link', async () => {
    db.prepare(
      `INSERT INTO achievements (id, name, description, family, tier, points, hidden, rule, digest, source, created_at, updated_at)
       VALUES ('boards.linked.2', 'Two Timer', 'Link two boards', 'boards', 'bronze', 5, 0, '{"op":"distinct","type":"meta.link","dim":"board","n":2}', 'x', 'seed', 1, 1)`
    ).run();
    db.prepare(`INSERT INTO achievement_types (achievement_id, type) VALUES ('boards.linked.2', 'meta.link')`).run();
    const first = await verifiedPlayer('caller@example.com', 'Caller');
    const other = secondBoard();
    const one = await send('post', '/links', { email: 'caller@example.com', code: first });
    expect(db.prepare('SELECT COUNT(*) AS n FROM unlocks').get()).toEqual({ n: 0 });

    await send('post', '/links', { email: 'caller@example.com', code: one.body.linkCode }, other);

    expect(db.prepare('SELECT achievement_id, board_id FROM unlocks').all()).toEqual([{ achievement_id: 'boards.linked.2', board_id: 'other' }]);
  });

  it('no response body this suite produced contains an email address', () => {
    for (const body of bodies) expect(body).not.toContain('@');
  });
});
