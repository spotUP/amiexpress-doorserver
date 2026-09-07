/**
 * AC-14 - GET /players/<email> and the private flag.
 *
 * Gated by the link, never by the flag. The last-but-one test is the
 * players suite's guard, applied here: no body this suite received
 * contains an address.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { createBoard } from '../../src/achievements/boards';
import { defineAchievement, makeAchievementsFixture, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

let fx: AchievementsFixture;
let db: Database.Database;
/** Every body the whole file received; the last test reads them all. */
const bodies: string[] = [];

beforeEach(() => {
  fx = makeAchievementsFixture();
  db = fx.openAchievements();
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

async function send(method: 'get' | 'post' | 'patch', path: string, body?: unknown, auth = fx.auth): Promise<Response> {
  let t = request(fx.app)[method](`/achievements/v1${path}`).set('Authorization', auth);
  if (body !== undefined) t = t.send(body as object);
  const res = await t;
  bodies.push(res.text ?? '');
  return res;
}

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
function codeFromLatestMail(): string {
  const mail = db.prepare('SELECT body FROM mail_queue ORDER BY id DESC LIMIT 1').get() as { body: string };
  return mail.body.split('\n').filter((l) => CODE.test(l))[0];
}

/** Register, verify, link this board; returns the next link code. */
async function linkedPlayer(email: string, handle: string): Promise<string> {
  await send('post', '/players', { email, handle });
  const verify = await send('post', '/players/verify', { email, code: codeFromLatestMail() });
  const link = await send('post', '/links', { email, code: verify.body.linkCode });
  expect(link.status).toBe(200);
  return link.body.linkCode as string;
}

const profile = (email: string, auth = fx.auth): Promise<Response> => send('get', `/players/${encodeURIComponent(email)}`, undefined, auth);

describe('the profile', () => {
  it('a board not linked to an email is refused, whether or not that player exists', async () => {
    await send('post', '/players', { email: 'caller@example.com', handle: 'Caller' });
    await send('post', '/players/verify', { email: 'caller@example.com', code: codeFromLatestMail() });

    const unlinked = await profile('caller@example.com');
    const nobody = await profile('nobody@example.com');

    expect(unlinked.status).toBe(403);
    expect(nobody.status).toBe(403);
    expect(unlinked.body).toEqual(nobody.body);
    expect(unlinked.body.error).toBe('not_linked');
  });

  it('a linked board reading a private player still gets the profile', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    const made = await send('patch', '/players/caller%40example.com', { private: true });
    expect(made.status).toBe(200);
    expect(made.body.private).toBe(true);

    const res = await profile('CALLER@Example.com');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handle: 'Caller', verified: true, private: true, points: 0, linkedBoards: [TEST_BOARD_ID], unlocks: [], progress: [] });
  });

  it('setting the profile private from one linked board is visible from another', async () => {
    const code = await linkedPlayer('caller@example.com', 'Caller');
    const other = `Board ${createBoard(db, 'other', 'Other', null).key}`;
    expect((await send('post', '/links', { email: 'caller@example.com', code }, other)).status).toBe(200);

    await send('patch', '/players/caller%40example.com', { private: true });

    const seen = await profile('caller@example.com', other);
    expect(seen.body.private).toBe(true);
    expect(seen.body.linkedBoards).toEqual(['other', TEST_BOARD_ID]);
    // A board that is not linked cannot flip the flag, private or not.
    const third = `Board ${createBoard(db, 'third', 'Third', null).key}`;
    expect((await send('patch', '/players/caller%40example.com', { private: false }, third)).status).toBe(403);
    expect((await profile('caller@example.com')).body.private).toBe(true);
  });

  it('progress omits hidden achievements the player has not unlocked', async () => {
    defineAchievement(db, { id: 'msg.post.100', rule: { op: 'count', type: 'msg.post', n: 100 } });
    defineAchievement(db, { id: 'rare.midnight.5', rule: { op: 'count', type: 'msg.post', n: 5 }, hidden: true, name: 'Night Owl' });
    defineAchievement(db, { id: 'msg.post.2', rule: { op: 'count', type: 'msg.post', n: 2 } });
    defineAchievement(db, { id: 'file.up.10', rule: { op: 'count', type: 'file.upload', n: 10 } });
    await linkedPlayer('caller@example.com', 'Caller');
    for (let i = 0; i < 3; i += 1) {
      await send('post', '/events', { events: [{ ref: `${TEST_BOARD_ID}:r${i}`, email: 'caller@example.com', type: 'msg.post', at: new Date().toISOString() }] });
    }

    const res = await profile('caller@example.com');

    expect(res.body.unlocks.map((u: { id: string }) => u.id)).toEqual(['msg.post.2']);
    expect(res.body.points).toBe(5);
    // The hidden one is three fifths of the way and is not listed; the
    // untouched file achievement is not listed either.
    expect(res.body.progress).toEqual([{ id: 'msg.post.100', have: 3, need: 100 }]);
  });

  it('a handle change to a taken handle is refused and the old handle stands', async () => {
    await linkedPlayer('caller@example.com', 'Caller');
    await linkedPlayer('other@example.com', 'Other');

    const taken = await send('patch', '/players/caller%40example.com', { handle: 'OTHER' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('handle_taken');
    const bad = await send('patch', '/players/caller%40example.com', { handle: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_handle');
    expect((await profile('caller@example.com')).body.handle).toBe('Caller');

    const renamed = await send('patch', '/players/caller%40example.com', { handle: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.handle).toBe('Renamed');
    // Renaming to your own handle in another case is not "taken".
    expect((await send('patch', '/players/caller%40example.com', { handle: 'RENAMED' })).status).toBe(200);
  });

  it('the profile never contains an email address', () => {
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain('@');
  });
});
