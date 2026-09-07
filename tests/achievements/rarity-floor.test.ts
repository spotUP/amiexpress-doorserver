/**
 * The floor is one answer, not three.
 *
 * Symptom, caught by capturing docs/ACHIEVEMENTS-API.md's examples from
 * the real server: a freshly unlocked achievement came back with
 * `rarityPctTenths: 0` - "held by nobody", the most legendary number the
 * bucket table has - from both the events response and the profile, while
 * the catalog reported the documented floor of 1000 for the same
 * achievement in the same breath. `POST /events` was worse than
 * inconsistent: it hardcoded 0 and never read the rarity row at all, so
 * even a board with a computed rarity saw 0 on every unlock it earned.
 *
 * The document has said since it was written that with fewer than twenty
 * verified players every achievement is common at 1000, "because on day one
 * the arithmetic would otherwise make everything legendary" - which is
 * exactly what a door printed.
 */
import request from 'supertest';
import type Database from 'better-sqlite3';
import { makeAchievementsFixture, defineAchievement } from './helpers';
import type { AchievementsFixture } from './helpers';
import { RARITY_FLOOR } from '../../src/achievements/rarity';

let fx: AchievementsFixture;
let db: Database.Database;

beforeEach(() => {
  fx = makeAchievementsFixture();
  db = fx.openAchievements();
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

const post = (path: string, body: unknown) =>
  request(fx.app).post(`/achievements/v1${path}`).set('Authorization', fx.auth).send(body as object);

const get = (path: string) =>
  request(fx.app).get(`/achievements/v1${path}`).set('Authorization', fx.auth);

/** The code the server queued, as a caller reads it off the mail. */
function mailedCode(email: string): string {
  const rows = db
    .prepare('SELECT body FROM mail_queue WHERE to_addr = ? ORDER BY id')
    .all(email) as { body: string }[];
  const lines = rows[rows.length - 1].body
    .split('\n')
    .filter((l) => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(l.trim()));
  return lines[0].trim();
}

/** A verified player with this board linked, through the real endpoints. */
async function linkedPlayer(email: string, handle: string): Promise<void> {
  expect((await post('/players', { email, handle })).status).toBe(202);
  const verified = await post('/players/verify', { email, code: mailedCode(email) });
  expect(verified.status).toBe(200);
  const linked = await post('/links', { email, code: verified.body.linkCode });
  expect(linked.status).toBe(200);
}

describe('the rarity floor, at every surface that reports one', () => {
  it('does not report a freshly unlocked achievement as held by nobody', async () => {
    await linkedPlayer('caller@example.com', 'Spot');
    defineAchievement(db, { id: 'msg.post.1', rule: { op: 'count', type: 'msg.post', n: 1 } });

    const res = await post('/events', {
      events: [
        {
          ref: 'uprough:01J8Z4M0000000000000000001',
          email: 'caller@example.com',
          type: 'msg.post',
          at: new Date().toISOString(),
          value: 1,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.unlocks).toHaveLength(1);
    // The bug: 0, which bucketFor() calls legendary.
    expect(res.body.unlocks[0].rarityPctTenths).toBe(RARITY_FLOOR.pctTenths);
  });

  it('gives the profile and the catalog the same number for the same achievement', async () => {
    await linkedPlayer('caller@example.com', 'Spot');
    defineAchievement(db, { id: 'msg.post.1', rule: { op: 'count', type: 'msg.post', n: 1 } });
    await post('/events', {
      events: [
        {
          ref: 'uprough:01J8Z4M0000000000000000002',
          email: 'caller@example.com',
          type: 'msg.post',
          at: new Date().toISOString(),
          value: 1,
        },
      ],
    });

    const profile = await get(`/players/${encodeURIComponent('caller@example.com')}`);
    const catalog = await get('/catalog');
    expect(profile.status).toBe(200);
    expect(catalog.status).toBe(200);

    const inProfile = profile.body.unlocks.find((u: { id: string }) => u.id === 'msg.post.1');
    const inCatalog = catalog.body.achievements.find((a: { id: string }) => a.id === 'msg.post.1');
    expect(inProfile).toBeDefined();
    expect(inCatalog).toBeDefined();
    expect(inProfile.rarityPctTenths).toBe(inCatalog.rarityPctTenths);
    expect(inProfile.rarityPctTenths).toBe(RARITY_FLOOR.pctTenths);
  });

  it('reports a computed rarity where one exists, and does not floor it away', async () => {
    await linkedPlayer('caller@example.com', 'Spot');
    defineAchievement(db, { id: 'msg.post.1', rule: { op: 'count', type: 'msg.post', n: 1 } });
    // A rarity row as computeRarity writes it once a board is past the
    // twenty-player floor: 8.1%, the document's own worked number.
    db.prepare(
      `INSERT INTO rarity (achievement_id, unlocked, verified, pct_tenths, bucket, computed_at)
       VALUES ('msg.post.1', 2, 25, 81, 'rare', 1700000000)`
    ).run();

    const res = await post('/events', {
      events: [
        {
          ref: 'uprough:01J8Z4M0000000000000000003',
          email: 'caller@example.com',
          type: 'msg.post',
          at: new Date().toISOString(),
          value: 1,
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.unlocks[0].rarityPctTenths).toBe(81);
  });
});
