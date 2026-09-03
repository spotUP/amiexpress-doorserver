/**
 * AC-4 - boards: the only identity that may report an event.
 *
 * Every test drives the real `createApp(cfg)` over HTTP. SYM-2 and SYM-3
 * from AC-1's RED file move here, unchanged in intent: an unknown key reads
 * nothing, and a suspended board reports nothing.
 *
 * The two that are easy to get wrong are the cache pair. D2 buys the write
 * path out of a 50 ms scrypt per request, and the whole safety of that trade
 * is that the row is still read every time: the cached entry is honoured
 * only while the row's key hash is unchanged, so a rotation bites on the
 * very next request. Both halves are asserted here - the saved hash AND the
 * rotation - because a cache that only ever hits is indistinguishable from a
 * cache that never expires.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './helpers';
import type { AchievementsFixture } from './helpers';
import { _boardKeyVerifyCountForTests } from '../../src/achievements/boards';

let fx: AchievementsFixture;

afterEach(() => fx.cleanup());

/** Suspend the fixture's real board, the way the curation route would. */
function suspend(): void {
  const db = fx.openAchievements();
  try {
    db.prepare('UPDATE boards SET suspended_at = 1700000001 WHERE id = ?').run(fx.boardId);
  } finally {
    db.close();
  }
}

describe('the board key, as a board author meets it', () => {
  beforeEach(() => {
    fx = makeAchievementsFixture();
  });

  it('SYM-2: a board with an unknown key can still read the catalog', async () => {
    const res = await request(fx.app)
      .get('/achievements/v1/catalog')
      .set('Authorization', 'Board nosuchboard.wrongsecret');

    // Must be 401: an unknown key reads nothing, and the refusal never says
    // which half of `<id>.<secret>` was wrong.
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/nosuchboard|wrongsecret/);
  });

  it('SYM-3: a suspended board keeps reporting events', async () => {
    suspend();

    const res = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', fx.auth)
      .send({ events: [] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('board_suspended');
  });

  it('a request with no Authorization header is refused with 401, not served', async () => {
    const res = await request(fx.app).post('/achievements/v1/events').send({ events: [] });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthenticated');
    // Not the single-page app, and not a 404 that would mean "this host does
    // not run achievements at all".
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('a key naming an unknown board is refused with 401 and does not say which half was wrong', async () => {
    const unknown = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', 'Board nosuchboard.wrongsecret')
      .send({ events: [] });
    const malformed = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', 'Board no-dot-at-all')
      .send({ events: [] });
    const wrongScheme = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', `Bearer ${fx.boardKey}`)
      .send({ events: [] });

    for (const res of [unknown, malformed, wrongScheme]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthenticated' });
    }
  });

  it('a key with the right board id and a wrong secret is refused with 401', async () => {
    const res = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', `Board ${fx.boardId}.qeAtPnDs4Wv2Lm7xKcRb9TfHgJyZuNe3`)
      .send({ events: [] });

    expect(res.status).toBe(401);
    // Indistinguishable from an unknown board: the same body, byte for byte.
    expect(res.body).toEqual({ error: 'unauthenticated' });
  });

  it("a suspended board's events are refused with 403 while its reads still work", async () => {
    suspend();

    const write = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', fx.auth)
      .send({ events: [] });
    const read = await request(fx.app).get('/achievements/v1/catalog').set('Authorization', fx.auth);

    expect(write.status).toBe(403);
    expect(write.body.error).toBe('board_suspended');
    // Suspension stops a board REPORTING. Its door's catalog display keeps
    // working, and the read is refused by nothing here - /catalog itself
    // arrives in AC-12, so what this asserts is that the gate let it past.
    expect(read.status).not.toBe(401);
    expect(read.status).not.toBe(403);
  });

  it('a verified key is not hashed a second time within the cache window', async () => {
    const before = _boardKeyVerifyCountForTests();
    await request(fx.app).get('/achievements/v1/catalog').set('Authorization', fx.auth);
    const afterFirst = _boardKeyVerifyCountForTests();
    await request(fx.app).get('/achievements/v1/catalog').set('Authorization', fx.auth);
    await request(fx.app).get('/achievements/v1/catalog').set('Authorization', fx.auth);

    // One scrypt for the first request; the next two are free. This is the
    // whole point of D2 - three requests would otherwise cost 150 ms of CPU.
    expect(afterFirst).toBe(before + 1);
    expect(_boardKeyVerifyCountForTests()).toBe(afterFirst);
  });
});

describe('the curation routes, as the sysop who issues keys meets them', () => {
  beforeEach(() => {
    fx = makeAchievementsFixture({ admin: true });
  });

  const admin = (url: string) => `/achievements/v1/admin${url}`;

  it('rotating a key stops the old key on the very next request', async () => {
    const token = await fx.adminToken();
    const oldKey = fx.boardKey;

    // Warm the cache: the old key is now verified and remembered.
    const warm = await request(fx.app).get('/achievements/v1/catalog').set('Authorization', `Board ${oldKey}`);
    expect(warm.status).not.toBe(401);

    const rotated = await request(fx.app)
      .post(admin(`/boards/${fx.boardId}/rotate`))
      .set('Authorization', `Bearer ${token}`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.key).not.toBe(oldKey);
    expect(rotated.body.key.startsWith(`${fx.boardId}.`)).toBe(true);

    // No cache was flushed anywhere. The entry is simply no longer honoured,
    // because the row's hash moved out from under it.
    const stale = await request(fx.app)
      .get('/achievements/v1/catalog')
      .set('Authorization', `Board ${oldKey}`);
    expect(stale.status).toBe(401);

    const fresh = await request(fx.app)
      .get('/achievements/v1/catalog')
      .set('Authorization', `Board ${rotated.body.key}`);
    expect(fresh.status).not.toBe(401);
  });

  it('a board id that is not lowercase-slug shaped is refused at creation', async () => {
    const token = await fx.adminToken();

    for (const id of ['UpRough', 'a', 'has space', 'has.dot', '-leading', 'a'.repeat(33)]) {
      const res = await request(fx.app)
        .post(admin('/boards'))
        .set('Authorization', `Bearer ${token}`)
        .send({ id, name: 'Whatever' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('bad_request');
    }

    const db = fx.openAchievements();
    try {
      const n = db.prepare('SELECT COUNT(*) AS n FROM boards').get() as { n: number };
      expect(n.n).toBe(1); // only the fixture's own board
    } finally {
      db.close();
    }
  });

  it('an accepted curation write appends one board_audit row naming the board and the count', async () => {
    const token = await fx.adminToken();

    const created = await request(fx.app)
      .post(admin('/boards'))
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'nordicelite', name: 'Nordic Elite', contact: 'sysop@example.invalid' });
    expect(created.status).toBe(200);

    const db = fx.openAchievements();
    try {
      const rows = db
        .prepare('SELECT board_id, action, count FROM board_audit ORDER BY id')
        .all() as { board_id: string; action: string; count: number }[];
      expect(rows).toEqual([{ board_id: 'nordicelite', action: 'board:create', count: 1 }]);
    } finally {
      db.close();
    }
  });

  it('creating a board twice with the same id fails and does not change the stored hash', async () => {
    const token = await fx.adminToken();
    const stored = () => {
      const db = fx.openAchievements();
      try {
        return (db.prepare('SELECT key_hash FROM boards WHERE id = ?').get(fx.boardId) as {
          key_hash: string;
        }).key_hash;
      } finally {
        db.close();
      }
    };

    const before = stored();
    const res = await request(fx.app)
      .post(admin('/boards'))
      .set('Authorization', `Bearer ${token}`)
      .send({ id: fx.boardId, name: 'Impostor' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('board_exists');
    expect(stored()).toBe(before);

    // And the key that was already issued still works.
    const still = await request(fx.app).get('/achievements/v1/catalog').set('Authorization', fx.auth);
    expect(still.status).not.toBe(401);
  });

  it('the curation routes take an admin token, never a board key', async () => {
    const withBoardKey = await request(fx.app).get(admin('/boards')).set('Authorization', fx.auth);
    const withNothing = await request(fx.app).get(admin('/boards'));
    const token = await fx.adminToken();
    const withToken = await request(fx.app).get(admin('/boards')).set('Authorization', `Bearer ${token}`);

    expect(withBoardKey.status).toBe(401);
    expect(withNothing.status).toBe(401);
    expect(withToken.status).toBe(200);
    expect((withToken.body as { id: string }[]).map((b) => b.id)).toEqual([fx.boardId]);
  });
});
