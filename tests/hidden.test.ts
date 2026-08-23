/**
 * Taking a door out of the repository.
 *
 * The point of hiding rather than deleting: door_catalog is rewritten by
 * every corpus scan, so a DELETE would undo itself and leave the archive on
 * disk. These tests check that a hidden door is gone from EVERY surface -
 * including the archive download - that a re-scan does not bring it back,
 * and that restoring it is exact.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { openDb, applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { createApp } from '../src/app';
import { bootstrapAdmins } from '../src/auth';
import { _clearLoginFailuresForTests } from '../src/admin-routes';
import { _clearIndexTsvCacheForTests } from '../src/index-tsv';
import { _clearListCacheForTests } from '../src/manifest';
import { getCatalogRevision } from '../src/catalog';
import type { ServerConfig } from '../src/config';

const SECRET = 'a-test-secret-that-is-long-enough-to-pass';
let dir: string;
let cfg: ServerConfig;
let token: string;

const app = () => createApp(cfg);
const auth = () => ({ Authorization: `Bearer ${token}` });

function insertDoors(): void {
  const db = openDb(cfg);
  const insert = db.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, category, requires_bbs,
                               file_id_diz, archive_size, indexed_at)
     VALUES (?, ?, ?, ?, 'XIM', 'utility', '/X 3.38+', 'A door that does things', 1024, 1700000000)`
  );
  insert.run('id1', 'KEEP.LHA', 'AmiExpress/KEEP.LHA', 'Keeper');
  insert.run('id2', 'JUNK.LHA', 'AmiExpress/JUNK.LHA', 'Junker');
  db.close();
}

beforeEach(async () => {
  _clearLoginFailuresForTests();
  _clearIndexTsvCacheForTests();
  _clearListCacheForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-hide-'));
  fs.mkdirSync(path.join(dir, 'AmiExpress'));
  fs.writeFileSync(path.join(dir, 'AmiExpress', 'JUNK.LHA'), 'junk archive bytes');
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = {
    dbPath,
    archivesRoot: dir,
    port: 3010,
    adminKeys: [{ label: 'spot', key: 'correct horse battery staple' }],
    jwtSecret: SECRET,
  };
  const db = openDb(cfg);
  applySchema(db);
  runMigrations(db);
  bootstrapAdmins(db, cfg);
  db.close();
  insertDoors();

  const res = await request(app())
    .post('/api/door-repo/admin/login')
    .send({ username: 'spot', password: 'correct horse battery staple' });
  token = res.body.token;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function hide(archive = 'JUNK.LHA', reason?: string) {
  const res = await request(app())
    .delete(`/api/door-repo/admin/doors/${encodeURIComponent(archive)}`)
    .set(auth())
    .send(reason ? { reason } : {});
  _clearIndexTsvCacheForTests();
  _clearListCacheForTests();
  return res;
}

describe('hiding a door', () => {
  it('needs a token', async () => {
    expect((await request(app()).delete('/api/door-repo/admin/doors/JUNK.LHA')).status).toBe(401);
  });

  it('removes it from every listing at once', async () => {
    expect((await hide()).status).toBe(200);

    const listed = await request(app()).get('/api/door-repo/doors');
    expect(listed.body.total).toBe(1);
    expect(listed.body.rows.map((r: { archiveName: string }) => r.archiveName)).toEqual(['KEEP.LHA']);

    const tsv = await request(app()).get('/api/door-repo/index.tsv');
    expect(tsv.text).toContain('KEEP.LHA');
    expect(tsv.text).not.toContain('JUNK.LHA');

    const list = await request(app()).get('/api/door-repo/list.txt');
    expect(list.text).not.toContain('JUNK.LHA');
    // The header's door count has to agree with the rows beneath it, or a
    // C client reading line by line runs off the end.
    expect(list.text.split('\r\n')[0]).toBe(`DOORREPO|1|${getCatalogRevision(cfg)}|1`);

    const manifest = await request(app()).get('/api/door-repo/manifest');
    expect(manifest.body.doors).toHaveLength(1);

    expect((await request(app()).get('/api/door-repo/health')).body.doors).toBe(1);
  });

  it('stops the archive downloading', async () => {
    // Still on disk - hiding is not a delete - but no longer served.
    expect((await request(app()).get('/api/door-repo/archive/JUNK.LHA')).status).toBe(200);
    await hide();
    expect((await request(app()).get('/api/door-repo/archive/JUNK.LHA')).status).toBe(404);
    expect(fs.existsSync(path.join(dir, 'AmiExpress', 'JUNK.LHA'))).toBe(true);
  });

  it('404s on its public page', async () => {
    await hide();
    expect((await request(app()).get('/api/door-repo/doors/JUNK.LHA')).status).toBe(404);
  });

  it('stops being counted in the filters', async () => {
    const before = await request(app()).get('/api/door-repo/facets');
    expect(before.body.types).toEqual([{ value: 'XIM', n: 2 }]);
    await hide();
    const after = await request(app()).get('/api/door-repo/facets');
    expect(after.body.types).toEqual([{ value: 'XIM', n: 1 }]);
    expect(after.body.categories).toEqual([{ value: 'utility', n: 1 }]);
    expect(after.body.requires).toEqual([{ value: '/X 3.38+', n: 1 }]);
  });

  it('changes the catalog revision, so no cache serves it after the fact', async () => {
    const before = getCatalogRevision(cfg);
    await hide();
    expect(getCatalogRevision(cfg)).not.toBe(before);
  });

  it('survives a corpus re-scan rewriting the catalog row', async () => {
    await hide();
    // What a re-scan does: the row is rewritten, with a fresh indexed_at.
    const db = openDb(cfg);
    db.prepare("UPDATE door_catalog SET name = 'Junker v2', indexed_at = 1800000000 WHERE id = 'id2'").run();
    db.close();
    _clearIndexTsvCacheForTests();
    expect((await request(app()).get('/api/door-repo/doors')).body.total).toBe(1);
  });

  it('records who removed it and why', async () => {
    await hide('JUNK.LHA', 'duplicate of KEEP.LHA');
    const res = await request(app()).get('/api/door-repo/admin/hidden').set(auth());
    expect(res.body.rows).toEqual([
      {
        archiveName: 'JUNK.LHA',
        catalogName: 'Junker',
        reason: 'duplicate of KEEP.LHA',
        hiddenAt: expect.any(Number),
        hiddenBy: 'spot',
      },
    ]);
    const audit = await request(app()).get('/api/door-repo/admin/audit').set(auth());
    expect(audit.body.rows[0]).toMatchObject({ action: 'hide', by: 'spot' });
  });

  it('is still visible in the admin console, or it could never be restored', async () => {
    await hide();
    const res = await request(app()).get('/api/door-repo/admin/doors/JUNK.LHA').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.hidden).toBe(true);
  });

  it('404s for a door that does not exist', async () => {
    expect((await hide('NOPE.LHA')).status).toBe(404);
  });
});

describe('restoring a door', () => {
  it('puts it back everywhere, exactly as it was', async () => {
    const before = {
      tsv: (await request(app()).get('/api/door-repo/index.tsv')).text,
      revision: getCatalogRevision(cfg),
    };
    await hide();
    const res = await request(app()).post('/api/door-repo/admin/doors/JUNK.LHA/restore').set(auth());
    expect(res.body).toEqual({ ok: true, restored: true });
    _clearIndexTsvCacheForTests();

    expect((await request(app()).get('/api/door-repo/index.tsv')).text).toBe(before.tsv);
    expect(getCatalogRevision(cfg)).toBe(before.revision);
    expect((await request(app()).get('/api/door-repo/archive/JUNK.LHA')).status).toBe(200);
  });

  it('is honest when there was nothing to restore', async () => {
    const res = await request(app()).post('/api/door-repo/admin/doors/KEEP.LHA/restore').set(auth());
    expect(res.body).toEqual({ ok: true, restored: false });
  });
});
