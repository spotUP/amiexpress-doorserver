/**
 * The requests router over the real app: the mount, the board gate, the
 * lifecycle, idempotent votes, the claim that cannot be won twice.
 *
 * The app under test is the real createApp(cfg) the achievements suites use,
 * so the board key is a real minted key and the surface is reached the way a
 * door reaches it. The fixture already runs ACHIEVEMENTS_MIGRATIONS, so the
 * requests tables exist.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import { makeAchievementsFixture, TEST_BOARD_ID } from '../achievements/helpers';
import type { AchievementsFixture } from '../achievements/helpers';
import { createBoard, setBoardSuspended } from '../../src/achievements/boards';
import { REQUESTS_CONTRACT_VERSION } from '../../contract/request-types';

let fx: AchievementsFixture;
let store: Database.Database;

beforeEach(() => {
  fx = makeAchievementsFixture();
  store = fx.openAchievements();
});

afterEach(() => {
  store.close();
  fx.cleanup();
});

const post = (p: string, body: unknown, key = fx.auth): request.Test =>
  request(fx.app).post(`/requests/v1${p}`).set('Authorization', key).send(body as object);
const get = (p: string, key = fx.auth): request.Test => request(fx.app).get(`/requests/v1${p}`).set('Authorization', key);

const raw = (p: string): request.Test =>
  get(p)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

async function postOne(over: Record<string, unknown> = {}): Promise<number> {
  const res = await post('/requests', { kind: 'release', title: 'A release', handle: 'Spot', ...over });
  expect(res.status).toBe(200);
  return res.body.id as number;
}

describe('where it is mounted', () => {
  it('answers /requests/v1/health without a key and is not the single-page app', async () => {
    const own = await request(fx.app).get('/requests/v1/health');
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ status: 'ok', contractVersion: REQUESTS_CONTRACT_VERSION, open: 0, claimed: 0, done: 0, boards: 1 });
    expect(own.headers['content-type']).toContain('application/json');
    expect(own.text).not.toContain('<div id="root">');

    const unknown = await get('/no-such-thing');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('not_found');

    const underDoorRepo = await request(fx.app).get('/api/door-repo/requests/v1/health');
    expect(underDoorRepo.status).toBe(404);
  });

  it('carries the contract header on every response, errors included', async () => {
    const ok = await request(fx.app).get('/requests/v1/health');
    const noKey = await request(fx.app).get('/requests/v1/list');
    for (const res of [ok, noKey]) {
      expect(res.headers['x-requests-contract']).toBe(REQUESTS_CONTRACT_VERSION);
      expect(res.headers['x-requests-revision']).toMatch(/^r\d+-t\d+$/);
    }
    expect(noKey.status).toBe(401);
  });
});

describe('the board gate', () => {
  it('401s a missing or wrong key indistinguishably', async () => {
    expect((await request(fx.app).get('/requests/v1/list')).status).toBe(401);
    expect((await get('/list', `Board ${TEST_BOARD_ID}.not-the-secret`)).status).toBe(401);
  });

  it('403s a suspended board write but still serves its reads', async () => {
    await postOne();
    setBoardSuspended(store, TEST_BOARD_ID, true);
    expect((await post('/requests', { kind: 'art', title: 'x', handle: 'Spot' })).status).toBe(403);
    expect((await get('/list.txt?state=open')).status).toBe(200);
  });
});

describe('posting', () => {
  it('creates an open request and shows it with the right tag', async () => {
    const id = await postOne({ kind: 'art', title: 'Login screen for /X' });
    const detail = await get(`/requests/${id}`);
    expect(detail.body).toMatchObject({ id, kind: 'art', state: 'open', votes: 0, board: TEST_BOARD_ID, handle: 'Spot', title: 'Login screen for /X' });
  });

  it('refuses a bad kind, an empty or over-long title, and a missing handle', async () => {
    expect((await post('/requests', { kind: 'demo', title: 'x', handle: 'Spot' })).body.error).toBe('bad_kind');
    expect((await post('/requests', { kind: 'release', title: '', handle: 'Spot' })).body.error).toBe('bad_title');
    expect((await post('/requests', { kind: 'release', title: 'x'.repeat(61), handle: 'Spot' })).body.error).toBe('bad_title');
    expect((await post('/requests', { kind: 'release', title: 'x', handle: '' })).body.error).toBe('bad_handle');
  });

  it('list.txt is the byte format the door parses', async () => {
    await postOne({ title: 'Fairlight - Nexus 7' });
    const res = await raw('/list.txt?state=open');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=ISO-8859-1');
    const text = (res.body as Buffer).toString('latin1');
    expect(text.startsWith('REQUEST|1|r1-t')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    const rowLine = text.split('\r\n')[1];
    const f = rowLine.split('|');
    expect(f[1]).toBe('release');
    expect(f[2]).toBe('open');
    expect(f[5]).toBe('Spot');
    expect(f[6]).toBe('Fairlight - Nexus 7');
  });
});

describe('voting', () => {
  it('moves the count once per identity, and a repeat is a no-op', async () => {
    const id = await postOne();
    const first = await post(`/requests/${id}/vote`, { handle: 'Voter' });
    expect(first.body).toMatchObject({ id, votes: 1, voted: true });
    const again = await post(`/requests/${id}/vote`, { handle: 'Voter' });
    expect(again.body).toMatchObject({ id, votes: 1, voted: false });
    const other = await post(`/requests/${id}/vote`, { handle: 'Other' });
    expect(other.body).toMatchObject({ id, votes: 2, voted: true });
  });

  it('a case-different handle is the same voter', async () => {
    const id = await postOne();
    await post(`/requests/${id}/vote`, { handle: 'Voter' });
    const again = await post(`/requests/${id}/vote`, { handle: '  voter ' });
    expect(again.body.voted).toBe(false);
    expect(again.body.votes).toBe(1);
  });

  it('refuses a vote on a closed request', async () => {
    const id = await postOne();
    await post(`/requests/${id}/withdraw`, { handle: 'Spot' });
    expect((await post(`/requests/${id}/vote`, { handle: 'Voter' })).body.error).toBe('wrong_state');
  });
});

describe('the lifecycle', () => {
  it('claims once, and a second caller cannot claim it in between', async () => {
    const id = await postOne();
    const first = await post(`/requests/${id}/claim`, { handle: 'Rebel' });
    expect(first.body).toMatchObject({ id, state: 'claimed', claimHandle: 'Rebel' });
    const otherKey = `Board ${createBoard(store, 'other', 'Other', null).key}`;
    const second = await post(`/requests/${id}/claim`, { handle: 'Phantasm' }, otherKey);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('already_claimed');
  });

  it('only the claimer may release or mark done', async () => {
    const id = await postOne();
    await post(`/requests/${id}/claim`, { handle: 'Rebel' });
    const otherKey = `Board ${createBoard(store, 'other', 'Other', null).key}`;
    expect((await post(`/requests/${id}/done`, { handle: 'Phantasm' }, otherKey)).body.error).toBe('not_yours');
    expect((await post(`/requests/${id}/release`, { handle: 'Phantasm' }, otherKey)).body.error).toBe('not_yours');
    const done = await post(`/requests/${id}/done`, { handle: 'Rebel', note: 'uploaded to /X' });
    expect(done.body).toMatchObject({ id, state: 'done' });
    const detail = await get(`/requests/${id}`);
    expect(detail.body).toMatchObject({ state: 'done', doneNote: 'uploaded to /X' });
  });

  it('release returns a claimed request to the open pool', async () => {
    const id = await postOne();
    await post(`/requests/${id}/claim`, { handle: 'Rebel' });
    const released = await post(`/requests/${id}/release`, { handle: 'Rebel' });
    expect(released.body).toMatchObject({ id, state: 'open' });
    expect((await get(`/requests/${id}`)).body.claimHandle).toBeNull();
  });

  it('a done request takes no more votes and cannot be reclaimed', async () => {
    const id = await postOne();
    await post(`/requests/${id}/claim`, { handle: 'Rebel' });
    await post(`/requests/${id}/done`, { handle: 'Rebel' });
    expect((await post(`/requests/${id}/vote`, { handle: 'V' })).body.error).toBe('wrong_state');
    expect((await post(`/requests/${id}/claim`, { handle: 'X' })).body.error).toBe('wrong_state');
  });

  it('only the author may withdraw, and a withdrawn request leaves the open list', async () => {
    const id = await postOne();
    const otherKey = `Board ${createBoard(store, 'other', 'Other', null).key}`;
    expect((await post(`/requests/${id}/withdraw`, { handle: 'Someone' }, otherKey)).body.error).toBe('not_yours');
    const withdrawn = await post(`/requests/${id}/withdraw`, { handle: 'Spot' });
    expect(withdrawn.body).toMatchObject({ id, state: 'withdrawn' });
    const open = await get('/list?state=open');
    expect(open.body.rows.find((r: { id: number }) => r.id === id)).toBeUndefined();
  });

  it('404s an action on a request that does not exist', async () => {
    expect((await get('/requests/9999')).status).toBe(404);
    expect((await post('/requests/9999/vote', { handle: 'V' })).status).toBe(404);
    expect((await get('/requests/not-a-number')).status).toBe(404);
  });
});

describe('scope and identity', () => {
  it('scope=mine shows what this caller authored AND what they claimed, in any state', async () => {
    const mine = await postOne({ title: 'mine' });
    const theirs = (await post('/requests', { kind: 'art', title: 'someone else', handle: 'Rebel' })).body.id as number;
    // Claim someone else's request: it must show up in my "mine and claimed".
    await post(`/requests/${theirs}/claim`, { handle: 'Spot' });

    const res = await get(`/list?scope=mine&handle=${encodeURIComponent('Spot')}&state=any`);
    const ids = (res.body.rows as { id: number }[]).map((r) => r.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(theirs);

    // A request I neither authored nor claimed is not in my mine list.
    const other = (await post('/requests', { kind: 'release', title: 'not mine', handle: 'Phantasm' })).body.id as number;
    const res2 = await get(`/list?scope=mine&handle=${encodeURIComponent('Spot')}&state=any`);
    expect((res2.body.rows as { id: number }[]).map((r) => r.id)).not.toContain(other);
  });

  it('scope=mine with no handle is empty, never the whole world', async () => {
    await postOne();
    const res = await get('/list?scope=mine&state=any');
    expect(res.body.rows).toEqual([]);
  });

  it('a board key cannot post as another board', async () => {
    const id = await postOne();
    const detail = await get(`/requests/${id}`);
    expect(detail.body.board).toBe(TEST_BOARD_ID);
  });
});

describe('curation', () => {
  it('DELETE /admin/requests/<id> needs the admin token, not a board key', async () => {
    const adminFx = makeAchievementsFixture({ admin: true });
    const s = adminFx.openAchievements();
    const created = await request(adminFx.app).post('/requests/v1/requests').set('Authorization', adminFx.auth).send({ kind: 'release', title: 'zap me', handle: 'Spot' });
    const id = created.body.id as number;

    // A board key is refused by the admin gate.
    const asBoard = await request(adminFx.app).delete(`/requests/v1/admin/requests/${id}`).set('Authorization', adminFx.auth);
    expect(asBoard.status).toBe(401);

    const token = await adminFx.adminToken();
    const asAdmin = await request(adminFx.app).delete(`/requests/v1/admin/requests/${id}`).set('Authorization', `Bearer ${token}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toEqual({ deleted: true });
    expect((await request(adminFx.app).get(`/requests/v1/requests/${id}`).set('Authorization', adminFx.auth)).status).toBe(404);
    s.close();
    adminFx.cleanup();
  });
});
