/**
 * AC-13 - PUT /catalog/doors/<door>: door-defined achievements.
 *
 * SYM-10 MOVED HERE from the RED file. The reachability test is the
 * fourth: a door definition that never fires through POST /events is the
 * failure mode this endpoint exists to prevent.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { makeAchievementsFixture, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

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

const def = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'First Blood',
  description: 'Win a game of chess',
  family: 'door',
  tier: 'bronze',
  points: 5,
  hidden: false,
  rule: { op: 'count', type: 'door.grandmaster.win', n: 1 },
  ...extra,
});

const push = (door: string, achievements: unknown[], digest = 'sha256:abc'): request.Test =>
  request(fx.app).put(`/achievements/v1/catalog/doors/${door}`).set('Authorization', fx.auth).send({ digest, achievements });

const published = (): { id: string; name: string; source: string }[] =>
  db.prepare('SELECT id, name, source FROM achievements ORDER BY id').all() as { id: string; name: string; source: string }[];

describe('door-defined achievements', () => {
  it('SYM-10: a door redefining a published id is refused with 409 and the published definition still stands', async () => {
    const first = await push('grandmaster', [def('door.grandmaster.first_win')]);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ added: 1, unchanged: 0, total: 1 });

    const renamed = await push('grandmaster', [def('door.grandmaster.first_win', { name: 'First Kill' })], 'sha256:def');
    expect(renamed.status).toBe(409);
    expect(renamed.body.error).toBe('definition_changed');
    expect(renamed.body.detail).toContain('door.grandmaster.first_win');

    // A rule change is the same 409; and a NEW id in the same push is not
    // written either - rejection is whole-request.
    const changed = await push('grandmaster', [
      def('door.grandmaster.first_win', { rule: { op: 'count', type: 'door.grandmaster.win', n: 2 } }),
      def('door.grandmaster.second', { name: 'Second' }),
    ]);
    expect(changed.status).toBe(409);
    expect(published()).toEqual([{ id: 'door.grandmaster.first_win', name: 'First Blood', source: 'door:grandmaster' }]);

    const catalog = await request(fx.app).get('/achievements/v1/catalog').set('Authorization', fx.auth);
    expect((catalog.body.achievements as { id: string; name: string }[]).find((a) => a.id === 'door.grandmaster.first_win')?.name).toBe('First Blood');
  });

  it("an id in another door's namespace is refused, naming the id", async () => {
    for (const id of ['door.phreakwars.first_win', 'msg.post.100', 'door.grandmaster', 'door.grandmaster.First']) {
      const res = await push('grandmaster', [def('door.grandmaster.ok'), def(id)]);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_namespace');
      expect(res.body.detail).toContain(id);
    }
    expect(published()).toEqual([]);
    // The door segment itself must be a slug.
    const badDoor = await push('Grand_Master', [def('door.Grand_Master.x')]);
    expect(badDoor.status).toBe(400);
    expect(badDoor.body.error).toBe('bad_door');
  });

  it('re-pushing an unchanged manifest adds nothing and answers 200', async () => {
    await push('grandmaster', [def('door.grandmaster.first_win')]);
    const again = await push('grandmaster', [def('door.grandmaster.first_win')]);

    expect(again.status).toBe(200);
    expect(again.body).toEqual({ added: 0, unchanged: 1, total: 1 });
    expect(db.prepare('SELECT door, digest FROM door_catalog_digests').all()).toEqual([{ door: 'grandmaster', digest: 'sha256:abc' }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM board_audit WHERE action = 'catalog:grandmaster'`).get()).toEqual({ n: 2 });
  });

  it('a door achievement unlocks through the same POST /events path as a BBS one', async () => {
    await push('grandmaster', [def('door.grandmaster.first_win')]);
    // A caller, the way a caller arrives: registered, verified, linked.
    const post = (path: string, body: unknown): request.Test =>
      request(fx.app).post(`/achievements/v1${path}`).set('Authorization', fx.auth).send(body as object);
    await post('/players', { email: 'caller@example.com', handle: 'Caller' });
    const mail = db.prepare('SELECT body FROM mail_queue ORDER BY id DESC LIMIT 1').get() as { body: string };
    const code = mail.body.split('\n').filter((l) => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(l))[0];
    const verify = await post('/players/verify', { email: 'caller@example.com', code });
    await post('/links', { email: 'caller@example.com', code: verify.body.linkCode });

    const res = await post('/events', {
      events: [{ ref: `${TEST_BOARD_ID}:01J8Z0000000000000000000A`, email: 'caller@example.com', type: 'door.grandmaster.win', at: new Date().toISOString(), door: 'grandmaster' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.unlocks).toEqual([expect.objectContaining({ id: 'door.grandmaster.first_win', name: 'First Blood' })]);
  });

  it('a door rule naming meta.unlock is refused', async () => {
    const res = await push('grandmaster', [def('door.grandmaster.meta', { rule: { op: 'count', type: 'meta.unlock', n: 3 } })]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_rule');
    expect(published()).toEqual([]);
  });

  it('a door defining a granted rule is refused', async () => {
    const granted = await push('grandmaster', [def('door.grandmaster.champion', { rule: { op: 'granted' } })]);
    expect(granted.status).toBe(400);
    expect(granted.body.error).toBe('bad_rule');
    const unknown = await push('grandmaster', [def('door.grandmaster.odd', { rule: { op: 'sometimes', type: 'x', n: 1 } })]);
    expect(unknown.body.error).toBe('bad_rule');
    // And the shape rules, one each.
    for (const extra of [{ tier: 'diamond' }, { points: 0 }, { points: 101 }, { name: '' }, { description: 'x'.repeat(161) }]) {
      const res = await push('grandmaster', [def('door.grandmaster.shape', extra)]);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_definition');
    }
    expect(published()).toEqual([]);
  });

  it('sixty-five achievements in one door are refused whole', async () => {
    const many = Array.from({ length: 65 }, (_, i) => def(`door.grandmaster.a${i}`));
    const res = await push('grandmaster', many);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('too_many');
    expect(published()).toEqual([]);

    const ok = await push('grandmaster', many.slice(0, 64));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ added: 64, unchanged: 0, total: 64 });
  });
});
