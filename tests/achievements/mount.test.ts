/**
 * AC-5 - the mount, the health object, the contract header.
 *
 * The test that would otherwise only ever show up in a browser is the second
 * one. src/app.ts's single-page-app catch-all exempts /api/ and nothing
 * else, so an achievements path mounted BELOW it is answered with
 * index.html and a 200 - AC-1 measured exactly that before this surface
 * existed. A suite that only checked "the endpoint works" would pass with
 * the mount in the wrong place, because supertest is happy to receive HTML.
 */
import request from 'supertest';
import { createApp } from '../../src/app';
import { ACHIEVEMENTS_CONTRACT_VERSION } from '../../contract/achievement-types';
import { makeAchievementsFixture } from './helpers';
import type { AchievementsFixture } from './helpers';
import { weakEtag } from '../weak-etag';

let fx: AchievementsFixture;

beforeEach(() => {
  fx = makeAchievementsFixture();
});

afterEach(() => fx.cleanup());

/** The same server, configured by a sysop who never wanted achievements. */
const withoutAchievements = () => createApp({ ...fx.cfg, achievements: null, releases: null });

describe('the achievements surface, where it is mounted', () => {
  it('answers on /achievements/v1, not under /api/door-repo', async () => {
    const own = await request(fx.app).get('/achievements/v1/health');
    const underDoorRepo = await request(fx.app).get('/api/door-repo/achievements/v1/health');

    expect(own.status).toBe(200);
    expect(own.body.status).toBe('ok');
    expect(own.body.contractVersion).toBe(ACHIEVEMENTS_CONTRACT_VERSION);
    // A brand new database: no players, no mail, one board (the fixture's).
    expect(own.body).toMatchObject({ players: 0, boards: 1, pendingMail: 0, season: null });
    expect(own.body.revision).toBe('a0-t0');

    expect(underDoorRepo.status).toBe(404);
  });

  it('does not fall through to the single-page app', async () => {
    const withKey = await request(fx.app).get('/achievements/v1/catalog').set('Authorization', fx.auth);
    const withoutKey = await request(fx.app).get('/achievements/v1/catalog');
    const unknown = await request(fx.app).get('/achievements/v1/no-such-thing').set('Authorization', fx.auth);

    for (const res of [withKey, withoutKey, unknown]) {
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.text).not.toContain('<div id="root">');
      expect(res.headers['cache-control']).toBeUndefined();
    }
    // This API answers the path, and the site does not: a key gets the
    // catalog (AC-12), no key gets this API's own 401, and a path nothing
    // here serves gets this API's own JSON 404 - never index.html.
    expect(withoutKey.status).toBe(401);
    expect(withKey.status).toBe(200);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('bad_request');
  });

  it('carries the contract version header on every response, errors included', async () => {
    const ok = await request(fx.app).get('/achievements/v1/health');
    const unauthenticated = await request(fx.app).get('/achievements/v1/catalog');
    const notFound = await request(fx.app).get('/achievements/v1/nothing-here').set('Authorization', fx.auth);
    const badBody = await request(fx.app)
      .post('/achievements/v1/events')
      .set('Authorization', fx.auth)
      .set('Content-Type', 'application/json')
      .send('{not json');

    for (const res of [ok, unauthenticated, notFound, badBody]) {
      expect(res.headers['x-achievements-contract']).toBe(ACHIEVEMENTS_CONTRACT_VERSION);
      expect(res.headers['x-achievements-revision']).toBe('a0-t0');
    }
    expect(unauthenticated.status).toBe(401);
    expect(notFound.status).toBe(404);
    expect(badBody.status).toBe(400);
  });

  it('is distinguishable from a host that does not run achievements at all', async () => {
    // The "a 404 means two different things" complaint docs/DOOR-REPO-API.md
    // already makes about the door repo. Here the two are told apart by the
    // header, not by the status: a surface that is mounted answers as itself
    // even when the path is wrong.
    const mounted = await request(fx.app).get('/achievements/v1/nothing-here').set('Authorization', fx.auth);
    const absent = await request(withoutAchievements()).get('/achievements/v1/nothing-here');

    expect(mounted.headers['x-achievements-contract']).toBe(ACHIEVEMENTS_CONTRACT_VERSION);
    expect(absent.headers['x-achievements-contract']).toBeUndefined();
  });

  it('adds achievements to the door-repo health object without changing a field it had', async () => {
    const res = await request(fx.app).get('/api/door-repo/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.doors).toBe(1);
    expect(typeof res.body.revision).toBe('string');
    expect(res.headers['x-door-repo-revision']).toBe(res.body.revision);
    expect(res.body.achievements).toEqual({
      enabled: true,
      contractVersion: ACHIEVEMENTS_CONTRACT_VERSION,
      players: 0,
      pendingMail: 0,
    });
  });

  it('reports enabled:false with achievements off, and still passes the container healthcheck', async () => {
    // The healthcheck is wget -qO- http://localhost:3010/api/door-repo/health
    // (docker-compose.yml). It must keep passing on a server whose sysop
    // never configured achievements.
    const res = await request(withoutAchievements()).get('/api/door-repo/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.doors).toBe(1);
    expect(res.body.achievements).toEqual({ enabled: false });
  });

  it('leaves the door-repo health object byte-identical once the new key is lifted out', async () => {
    // The mechanism tests/parity.test.ts uses against the BBS captures,
    // proven here where the numbers are known: delete `achievements` from
    // the parsed body, re-serialise, and the bytes are what the door repo
    // has always answered - same keys, same ORDER, same length.
    //
    // This is the ONLY CI-runnable exercise of that mechanism: parity skips
    // itself without PARITY_DB (README, "Commands"), so a mistake in the
    // reconstruction would otherwise surface for the first time on the
    // machine running the pre-deploy parity check.
    const res = await request(fx.app).get('/api/door-repo/health').buffer(true);
    const parsed = JSON.parse(res.text) as Record<string, unknown>;
    const { achievements, ...withoutOurs } = parsed;

    expect(achievements).toBeDefined();
    const reconstructed = Buffer.from(JSON.stringify(withoutOurs), 'utf-8');
    expect(reconstructed.toString('utf-8')).toBe(
      JSON.stringify({ status: 'ok', revision: parsed.revision, doors: 1 })
    );

    // The two body-derived headers describe the LIVE body...
    const live = Buffer.from(res.text, 'utf-8');
    expect(Number(res.headers['content-length'])).toBe(live.length);
    expect(res.headers.etag).toBe(weakEtag(live));
    // ...and BOTH therefore moved with it. Content-Length is the obvious
    // one; the ETag is the one that is easy to miss, because it does not
    // look like a length. A byte-parity comparison that lifts the new key
    // out of the body has to lift BOTH of these out of the headers and
    // re-derive them from the reconstruction, or it fails a response that
    // is entirely correct.
    expect(reconstructed.length).not.toBe(live.length);
    expect(weakEtag(reconstructed)).not.toBe(res.headers.etag);
  });

  it('sends no Access-Control-Allow-Origin on any achievements response (D13)', async () => {
    const responses = [
      await request(fx.app).get('/achievements/v1/health'),
      await request(fx.app).get('/achievements/v1/catalog'),
      await request(fx.app).get('/achievements/v1/catalog').set('Authorization', fx.auth),
      await request(fx.app).get('/achievements/v1/health').set('Origin', 'https://example.invalid'),
    ];

    for (const res of responses) {
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-expose-headers']).toBeUndefined();
    }
    // The door repo is the opposite case, and stays that way.
    const doorRepo = await request(fx.app).get('/api/door-repo/health');
    expect(doorRepo.headers['access-control-allow-origin']).toBe('*');
  });
});
