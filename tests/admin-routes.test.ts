/**
 * The admin write API.
 *
 * Two things matter here beyond "does it save": an edit must reach the
 * public endpoints, and nothing a stranger sends may reach SQL or the
 * catalog.
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
import type { ServerConfig } from '../src/config';

const SECRET = 'a-test-secret-that-is-long-enough-to-pass';
let dir: string;
let cfg: ServerConfig;
let token: string;

beforeEach(async () => {
  _clearLoginFailuresForTests();
  _clearIndexTsvCacheForTests();
  _clearListCacheForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-adm-'));
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
  db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, binary_name, name, door_type, author,
        file_id_diz, description, archive_size, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'AmiExpress/ACC-V103.LHA', 'AccEd', 'Account Editor', 'XIM',
             'Wize/Access', 'Account Editor v1.0 for /X 3.38+ - edits user accounts', '__ ART __',
             4711, 1700000000)`
  ).run();
  bootstrapAdmins(db, cfg);
  db.close();

  const res = await request(createApp(cfg))
    .post('/api/door-repo/admin/login')
    .send({ username: 'spot', password: 'correct horse battery staple' });
  token = res.body.token;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const app = () => createApp(cfg);
const auth = () => ({ Authorization: `Bearer ${token}` });
const admin = (url: string) => `/api/door-repo/admin${url}`;

describe('every admin route needs a token', () => {
  it('refuses reads and writes alike', async () => {
    expect((await request(app()).get(admin('/doors/ACC-V103.LHA'))).status).toBe(401);
    expect((await request(app()).patch(admin('/doors/ACC-V103.LHA')).send({ name: 'x' })).status).toBe(401);
    expect((await request(app()).delete(admin('/doors/ACC-V103.LHA/overrides/name'))).status).toBe(401);
    expect((await request(app()).post(admin('/doors/ACC-V103.LHA/redescribe'))).status).toBe(401);
    expect((await request(app()).get(admin('/audit'))).status).toBe(401);
  });
});

describe('GET /admin/doors/:archiveName', () => {
  it('shows the scanned value and the classifier\'s reading side by side', async () => {
    const res = await request(app()).get(admin('/doors/ACC-V103.LHA')).set(auth());
    expect(res.status).toBe(200);
    // The scanned description is box art; the derived one is the door's line.
    expect(res.body.fields.description.scanned).toBe('__ ART __');
    expect(res.body.fields.description.derived).toContain('edits user accounts');
    expect(res.body.fields.description.isEdited).toBe(false);
    expect(res.body.fields.requires_bbs.derived).toBe('/X 3.38+');
    expect(res.body.fileIdDiz).toContain('Account Editor v1.0');
  });

  it('marks a field a human has written', async () => {
    await request(app()).patch(admin('/doors/ACC-V103.LHA')).set(auth()).send({ description: 'mine' });
    const res = await request(app()).get(admin('/doors/ACC-V103.LHA')).set(auth());
    expect(res.body.fields.description.isEdited).toBe(true);
    expect(res.body.fields.description.edited).toBe('mine');
    // ...without losing what it was before.
    expect(res.body.fields.description.scanned).toBe('__ ART __');
  });
});

describe('PATCH /admin/doors/:archiveName', () => {
  it('saves an edit and serves it from the public API', async () => {
    const res = await request(app())
      .patch(admin('/doors/ACC-V103.LHA'))
      .set(auth())
      .send({ description: 'Edits every field of a user account', category: 'sysop' });
    expect(res.status).toBe(200);

    const listed = await request(app()).get('/api/door-repo/doors?q=ACC');
    expect(listed.body.rows[0].description).toBe('Edits every field of a user account');
    expect(listed.body.rows[0].descriptionSource).toBe('edited');
    expect(listed.body.rows[0].category).toBe('sysop');

    // ...and from the byte-exact endpoints the Amiga clients read.
    _clearIndexTsvCacheForTests();
    _clearListCacheForTests();
    const tsv = await request(app()).get('/api/door-repo/index.tsv');
    expect(tsv.text).toContain('Edits every field of a user account');
  });

  it('writes one override row per field, and one audit row per field', async () => {
    await request(app())
      .patch(admin('/doors/ACC-V103.LHA'))
      .set(auth())
      .send({ description: 'one', name: 'two' });
    const db = openDb(cfg);
    const overrides = db.prepare('SELECT field, value FROM door_catalog_overrides ORDER BY field').all();
    const audit = db.prepare("SELECT action, target FROM admin_audit WHERE action = 'edit'").all();
    db.close();
    expect(overrides).toEqual([
      { field: 'description', value: 'one' },
      { field: 'name', value: 'two' },
    ]);
    expect(audit).toHaveLength(2);
  });

  it('records who made the change and what it was before', async () => {
    await request(app()).patch(admin('/doors/ACC-V103.LHA')).set(auth()).send({ description: 'first' });
    await request(app()).patch(admin('/doors/ACC-V103.LHA')).set(auth()).send({ description: 'second' });
    const res = await request(app()).get(admin('/audit')).set(auth());
    const edits = res.body.rows.filter((r: { action: string }) => r.action === 'edit');
    expect(edits[0].by).toBe('spot');
    expect(edits[0].detail).toEqual({ field: 'description', from: 'first', to: 'second' });
  });

  it('refuses a field that is not editable', async () => {
    const res = await request(app())
      .patch(admin('/doors/ACC-V103.LHA'))
      .set(auth())
      .send({ md5: 'deadbeef' });
    expect(res.status).toBe(400);
    const db = openDb(cfg);
    const row = db.prepare('SELECT md5 FROM door_catalog WHERE id = ?').get('id1') as { md5: string | null };
    db.close();
    expect(row.md5).toBeNull();
  });

  it('refuses a field name that is really a SQL fragment', async () => {
    const res = await request(app())
      .patch(admin('/doors/ACC-V103.LHA'))
      .set(auth())
      .send({ "name = 'x' WHERE 1=1 --": 'boom' });
    expect(res.status).toBe(400);
    const db = openDb(cfg);
    expect(db.prepare('SELECT COUNT(*) n FROM door_catalog').get()).toEqual({ n: 1 });
    db.close();
  });

  it('refuses a value that is not text', async () => {
    expect(
      (await request(app()).patch(admin('/doors/ACC-V103.LHA')).set(auth()).send({ name: 42 })).status
    ).toBe(400);
    expect((await request(app()).patch(admin('/doors/ACC-V103.LHA')).set(auth()).send({})).status).toBe(400);
  });

  it('accepts null as "blank this field"', async () => {
    const res = await request(app()).patch(admin('/doors/ACC-V103.LHA')).set(auth()).send({ author: null });
    expect(res.status).toBe(200);
    const listed = await request(app()).get('/api/door-repo/doors?q=ACC');
    expect(listed.body.rows[0].author).toBeNull();
  });

  it('404s for a door that does not exist', async () => {
    expect(
      (await request(app()).patch(admin('/doors/NOPE.LHA')).set(auth()).send({ name: 'x' })).status
    ).toBe(404);
  });
});

describe('DELETE /admin/doors/:archiveName/overrides/:field', () => {
  it('puts the scanned value back', async () => {
    await request(app()).patch(admin('/doors/ACC-V103.LHA')).set(auth()).send({ name: 'Renamed' });
    expect((await request(app()).get('/api/door-repo/doors?q=ACC')).body.rows[0].name).toBe('Renamed');

    const res = await request(app()).delete(admin('/doors/ACC-V103.LHA/overrides/name')).set(auth());
    expect(res.body).toEqual({ ok: true, reverted: true });
    expect((await request(app()).get('/api/door-repo/doors?q=ACC')).body.rows[0].name).toBe('Account Editor');
  });

  it('is honest when there was nothing to revert', async () => {
    const res = await request(app()).delete(admin('/doors/ACC-V103.LHA/overrides/name')).set(auth());
    expect(res.body).toEqual({ ok: true, reverted: false });
  });

  it('refuses a field that is not editable', async () => {
    expect((await request(app()).delete(admin('/doors/ACC-V103.LHA/overrides/md5')).set(auth())).status).toBe(400);
  });
});

describe('POST /admin/doors/:archiveName/redescribe', () => {
  it('previews what the classifier would say, and writes nothing', async () => {
    await request(app()).patch(admin('/doors/ACC-V103.LHA')).set(auth()).send({ description: 'mine' });
    const res = await request(app()).post(admin('/doors/ACC-V103.LHA/redescribe')).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.description).toContain('edits user accounts');
    expect(res.body.requiresBbs).toBe('/X 3.38+');
    // The human's text is still what the public API serves.
    expect((await request(app()).get('/api/door-repo/doors?q=ACC')).body.rows[0].description).toBe('mine');
  });
});
