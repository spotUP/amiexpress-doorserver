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
import { createJob } from '../src/batch-jobs';
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
    jwtSecret: SECRET, learnKey: null,
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
    expect((await request(app()).post(admin('/tidy-case'))).status).toBe(401);
    expect((await request(app()).get(admin('/audit'))).status).toBe(401);
    expect((await request(app()).get(admin('/jobs/some-id'))).status).toBe(401);
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
    expect(res.body.fields.requires_bbs.derived).toBe('AmiExpress');
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
    expect(res.body.requiresBbs).toBe('AmiExpress');
    // The human's text is still what the public API serves.
    expect((await request(app()).get('/api/door-repo/doors?q=ACC')).body.rows[0].description).toBe('mine');
  });
});

describe('GET /admin/jobs/:id', () => {
  it('returns the job at 200 with its expected shape', async () => {
    const jobId = createJob(cfg, 'reextract', ['A.LHA', 'B.LHA'], null);
    const res = await request(app()).get(admin(`/jobs/${jobId}`)).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: jobId,
      kind: 'reextract',
      status: 'running',
      total: 2,
      completed: 0,
      failedCount: 0,
    });
    expect(res.body.items).toEqual([
      { archiveName: 'A.LHA', status: 'pending', error: null },
      { archiveName: 'B.LHA', status: 'pending', error: null },
    ]);
  });

  it('404s for a job that does not exist', async () => {
    const res = await request(app()).get(admin('/jobs/no-such-job')).set(auth());
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/doors/batch-reextract', () => {
  it('starts a job that reextracts every named door', async () => {
    // reextractOneDoor() reads the real archive file off disk - the
    // catalog row's archive_path is 'AmiExpress/ACC-V103.LHA' but nothing
    // in beforeEach() writes that file, so it must exist here or the job
    // item would come back 'error' with 'archive file missing'. Content is
    // irrelevant: the LHA reader returns an empty file list gracefully on
    // unparsable bytes rather than throwing (see archive-reader.ts).
    const archiveAbsPath = path.join(dir, 'AmiExpress', 'ACC-V103.LHA');
    fs.mkdirSync(path.dirname(archiveAbsPath), { recursive: true });
    fs.writeFileSync(archiveAbsPath, 'not a real archive, just needs to exist');

    const start = await request(app()).post(admin('/doors/batch-reextract')).set(auth()).send({ archiveNames: ['ACC-V103.LHA'] });
    expect(start.status).toBe(200);
    const { jobId } = start.body;
    expect(jobId).toBeTruthy();

    // The job runs across event-loop turns; poll briefly for completion.
    let job;
    for (let i = 0; i < 20; i++) {
      job = (await request(app()).get(admin(`/jobs/${jobId}`)).set(auth())).body;
      if (job.status === 'done') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(job.status).toBe('done');
    expect(job.completed).toBe(1);
    expect(job.failedCount).toBe(0);
    expect(job.items).toEqual([{ archiveName: 'ACC-V103.LHA', status: 'ok', error: null }]);
  });
});

describe('POST /admin/doors/:archiveName/strip-preview', () => {
  // Regression coverage for the previewStripOne() extraction (task 6): the
  // route's response shape must stay byte-for-byte identical to what it was
  // before the extraction. A narrower `previewStripOne` (stripped narrowed
  // to {path,reason}, notJunk hardcoded to [], archivePath dropped) would
  // silently break DoorDetail.tsx's live "Strip ads" review UI - nothing
  // else in this suite exercised /strip-preview before this task.
  function writeZip(zipPath: string, entries: Array<{ name: string; content: string }>): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    for (const e of entries) zip.addFile(e.name, Buffer.from(e.content));
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    zip.writeZip(zipPath);
  }

  it('returns full StripEntry objects, a reason map, the real notJunk list, and archivePath', async () => {
    // Point the catalog's archive_path at a real ZIP so analyzeArchive has
    // something to classify (readArchiveFiles picks its reader by file
    // extension, so the on-disk file must actually end in .zip).
    const zipPath = path.join(dir, 'AmiExpress', 'ACC-V103.zip');
    writeZip(zipPath, [
      { name: 'DOOR.FIM', content: 'binary door bytes' },
      { name: '!call_diz_now!', content: 'an ad payload' },
    ]);
    const db = openDb(cfg);
    db.prepare('UPDATE door_catalog SET archive_path = ? WHERE archive_name = ?')
      .run('AmiExpress/ACC-V103.zip', 'ACC-V103.LHA');
    // A file the admin has already told the stripper to leave alone.
    db.prepare('INSERT INTO door_not_junk (archive_name, file_path, reason) VALUES (?, ?, ?)')
      .run('ACC-V103.LHA', 'DOOR.FIM', 'it is the door binary');
    db.close();

    const res = await request(app()).post(admin('/doors/ACC-V103.LHA/strip-preview')).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.archiveName).toBe('ACC-V103.LHA');
    expect(res.body.archivePath).toBe(zipPath);
    // The literal brief text narrows stripped to {path,reason} - assert the
    // real StripEntry shape (size + md5) survives the extraction instead.
    expect(res.body.stripped.length).toBeGreaterThan(0);
    for (const entry of res.body.stripped) {
      expect(entry).toHaveProperty('path');
      expect(entry).toHaveProperty('size');
      expect(entry).toHaveProperty('md5');
    }
    // `reason` is a full map, separate from `stripped`, not folded into it.
    expect(typeof res.body.reason).toBe('object');
    expect(Object.keys(res.body.reason).length).toBeGreaterThan(0);
    // The real admin-marked not-junk paths, not a hardcoded [].
    expect(res.body.notJunk).toEqual(['DOOR.FIM']);
  });

  it('answers 400 with the LZX message when an LZX archive comes back with no members at all', async () => {
    // A genuinely 0-byte file is the case that reaches the empty-result
    // branch without throwing: ami-stripper's readArchiveContents() only
    // throws "reader returned 0 files" for a *non-empty* buffer that fails
    // to parse (garbage bytes) - a 0-byte file skips that guard entirely
    // and analyzeArchive comes back with kept=[] and stripped=[] cleanly.
    const lzxAbsPath = path.join(dir, 'AmiExpress', 'EMPTY.LZX');
    fs.mkdirSync(path.dirname(lzxAbsPath), { recursive: true });
    fs.writeFileSync(lzxAbsPath, Buffer.alloc(0));
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, archive_size, indexed_at)
       VALUES ('id2', 'EMPTY.LZX', 'AmiExpress/EMPTY.LZX', 'Empty LZX', 23, 1700000000)`
    ).run();
    db.close();

    const res = await request(app()).post(admin('/doors/EMPTY.LZX/strip-preview')).set(auth());
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'LZX archives cannot be read by this server' });
  });
});

describe('POST /admin/doors/batch-strip-preview', () => {
  it('runs strip-preview for every archive and stores the aggregated result on the job', async () => {
    // previewStripOne() reads the real archive file off disk via
    // analyzeArchive(), which (unlike reextractOneDoor's direct
    // readLhaContents() call) throws on a *non-empty* file that fails to
    // parse - see ami-stripper's readArchiveContents(). A 0-byte file
    // skips that guard and comes back as a clean "nothing to strip" result.
    const archiveAbsPath = path.join(dir, 'AmiExpress', 'ACC-V103.LHA');
    fs.mkdirSync(path.dirname(archiveAbsPath), { recursive: true });
    fs.writeFileSync(archiveAbsPath, Buffer.alloc(0));

    const start = await request(app()).post(admin('/doors/batch-strip-preview')).set(auth()).send({ archiveNames: ['ACC-V103.LHA'] });
    expect(start.status).toBe(200);
    const { jobId } = start.body;

    let job;
    for (let i = 0; i < 20; i++) {
      job = (await request(app()).get(admin(`/jobs/${jobId}`)).set(auth())).body;
      if (job.status === 'done') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(job.status).toBe('done');
    const result = JSON.parse(job.resultJson);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('archiveName', 'ACC-V103.LHA');
    expect(result[0]).toHaveProperty('stripped');
  });

  it('includes an archive with zero flagged files rather than omitting it', async () => {
    const archiveAbsPath = path.join(dir, 'AmiExpress', 'ACC-V103.LHA');
    fs.mkdirSync(path.dirname(archiveAbsPath), { recursive: true });
    fs.writeFileSync(archiveAbsPath, Buffer.alloc(0));

    const start = await request(app()).post(admin('/doors/batch-strip-preview')).set(auth()).send({ archiveNames: ['ACC-V103.LHA'] });
    const { jobId } = start.body;
    let job;
    for (let i = 0; i < 20; i++) {
      job = (await request(app()).get(admin(`/jobs/${jobId}`)).set(auth())).body;
      if (job.status === 'done') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const result = JSON.parse(job.resultJson);
    expect(result).toEqual([{ archiveName: 'ACC-V103.LHA', stripped: [] }]);
  });
});

describe('POST /admin/doors/batch-strip-apply', () => {
  it('strips only the confirmed members per archive, skipping an empty selection', async () => {
    // stripArchiveOnServer's empty-members branch still requires the
    // catalog row's archive file to exist on disk and a real lha/lzh
    // extension before it reaches the "0 members = mark reviewed, don't
    // touch the file" shortcut - see src/catalog.ts's stripArchiveOnServer.
    const archiveAbsPath = path.join(dir, 'AmiExpress', 'ACC-V103.LHA');
    fs.mkdirSync(path.dirname(archiveAbsPath), { recursive: true });
    fs.writeFileSync(archiveAbsPath, Buffer.alloc(0));

    const start = await request(app())
      .post(admin('/doors/batch-strip-apply'))
      .set(auth())
      .send({ selections: [{ archiveName: 'ACC-V103.LHA', members: [] }] });
    expect(start.status).toBe(200);
    const { jobId } = start.body;

    let job;
    for (let i = 0; i < 20; i++) {
      job = (await request(app()).get(admin(`/jobs/${jobId}`)).set(auth())).body;
      if (job.status === 'done') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(job.status).toBe('done');
    expect(job.items[0]).toMatchObject({ archiveName: 'ACC-V103.LHA', status: 'ok' });

    // The empty selection must be a genuine skip, not a silent strip: the
    // door is marked reviewed (ads_stripped = 1) but the on-disk file is
    // untouched, and no members were deleted from door_catalog_files.
    const db = openDb(cfg);
    const row = db.prepare('SELECT ads_stripped FROM door_catalog WHERE archive_name = ?').get('ACC-V103.LHA') as { ads_stripped: number };
    expect(row.ads_stripped).toBe(1);
    db.close();
    expect(fs.statSync(archiveAbsPath).size).toBe(0);

    // The audit log records the archive with an empty members list and
    // zero removed, not a re-derived classifier result.
    const auditRes = await request(app()).get(admin('/audit')).set(auth());
    const stripEntry = auditRes.body.rows.find((e: { action: string }) => e.action === 'strip');
    expect(stripEntry).toMatchObject({ target: 'ACC-V103.LHA' });
    expect(stripEntry.detail).toMatchObject({ members: [], removed: 0 });
  });

  it('answers 400 when selections is missing or empty', async () => {
    const res = await request(app()).post(admin('/doors/batch-strip-apply')).set(auth()).send({});
    expect(res.status).toBe(400);
    const res2 = await request(app()).post(admin('/doors/batch-strip-apply')).set(auth()).send({ selections: [] });
    expect(res2.status).toBe(400);
  });
});

describe('POST /admin/doors/batch-tags', () => {
  it('adds and removes tags across multiple doors, skipping an unknown archive', async () => {
    await request(app()).patch(admin('/doors/ACC-V103.LHA/tags')).set(auth()).send({ tags: ['keep-me'] });
    const res = await request(app())
      .post(admin('/doors/batch-tags'))
      .set(auth())
      .send({ archiveNames: ['ACC-V103.LHA', 'NOPE.LHA'], add: ['fresh'], remove: ['keep-me'] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { archiveName: 'ACC-V103.LHA', ok: true },
      { archiveName: 'NOPE.LHA', ok: false, error: 'not found' },
    ]);
    const tagsRes = await request(app()).get(admin('/doors/ACC-V103.LHA/tags')).set(auth());
    expect(tagsRes.body.tags).toEqual(['fresh']);
  });
});

describe('POST /admin/doors/batch-delete', () => {
  it('rejects a request whose confirm count does not match', async () => {
    const res = await request(app())
      .post(admin('/doors/batch-delete'))
      .set(auth())
      .send({ archiveNames: ['ACC-V103.LHA'], confirm: '2' });
    expect(res.status).toBe(400);
  });

  it('rejects a batch over 200 archives', async () => {
    const names = Array.from({ length: 201 }, (_, i) => `F${i}.LHA`);
    const res = await request(app())
      .post(admin('/doors/batch-delete'))
      .set(auth())
      .send({ archiveNames: names, confirm: '201' });
    expect(res.status).toBe(400);
  });

  it('permanently removes the catalog row, every child-table row, and the archive file', async () => {
    const before = await request(app()).get('/api/door-repo/doors?q=ACC-V103').set(auth());
    expect(before.body.rows).toHaveLength(1);

    // Seed one row in every catalog_id-keyed child table, plus the
    // archive_name-keyed door_not_junk table, so a regression that drops
    // any single DELETE statement is caught here instead of passing
    // silently because the table was empty anyway.
    const seedDb = openDb(cfg);
    seedDb
      .prepare('INSERT INTO door_catalog_files (catalog_id, path, size) VALUES (?, ?, ?)')
      .run('id1', 'ACCED.DOC', 100);
    seedDb
      .prepare('INSERT INTO door_catalog_overrides (catalog_id, field, value) VALUES (?, ?, ?)')
      .run('id1', 'name', 'Override Name');
    seedDb.prepare('INSERT INTO door_hidden (catalog_id, reason) VALUES (?, ?)').run('id1', 'test');
    seedDb.prepare('INSERT INTO door_tags (catalog_id, tag) VALUES (?, ?)').run('id1', 'keep-me');
    seedDb.prepare('INSERT INTO door_votes (catalog_id, voter_id, vote) VALUES (?, ?, ?)').run('id1', 'voter1', 1);
    seedDb
      .prepare('INSERT INTO door_not_junk (archive_name, file_path) VALUES (?, ?)')
      .run('ACC-V103.LHA', 'ACCED.DOC');
    seedDb.close();

    // A real file at the resolved archive path, so fs.unlinkSync is
    // actually exercised rather than being dead code that never throws.
    const archiveAbsPath = path.join(dir, 'AmiExpress', 'ACC-V103.LHA');
    fs.mkdirSync(path.dirname(archiveAbsPath), { recursive: true });
    fs.writeFileSync(archiveAbsPath, 'not a real archive, just needs to exist');
    expect(fs.existsSync(archiveAbsPath)).toBe(true);

    const res = await request(app())
      .post(admin('/doors/batch-delete'))
      .set(auth())
      .send({ archiveNames: ['ACC-V103.LHA', 'NOPE.LHA'], confirm: '2' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { archiveName: 'ACC-V103.LHA', ok: true },
      { archiveName: 'NOPE.LHA', ok: false, error: 'not found' },
    ]);

    const after = await request(app()).get('/api/door-repo/doors?q=ACC-V103').set(auth());
    expect(after.body.rows).toHaveLength(0);

    expect(fs.existsSync(archiveAbsPath)).toBe(false);

    const checkDb = openDb(cfg);
    expect(checkDb.prepare('SELECT * FROM door_catalog_files WHERE catalog_id = ?').all('id1')).toEqual([]);
    expect(checkDb.prepare('SELECT * FROM door_catalog_overrides WHERE catalog_id = ?').all('id1')).toEqual([]);
    expect(checkDb.prepare('SELECT * FROM door_hidden WHERE catalog_id = ?').all('id1')).toEqual([]);
    expect(checkDb.prepare('SELECT * FROM door_tags WHERE catalog_id = ?').all('id1')).toEqual([]);
    expect(checkDb.prepare('SELECT * FROM door_votes WHERE catalog_id = ?').all('id1')).toEqual([]);
    expect(
      checkDb.prepare('SELECT * FROM door_not_junk WHERE archive_name = ?').all('ACC-V103.LHA')
    ).toEqual([]);
    checkDb.close();
  });
});

describe('POST /admin/tidy-case', () => {
  it('normalises eLi7e casing to sentence case', async () => {
    const res = await request(app())
      .post(admin('/tidy-case'))
      .set(auth())
      .send({ text: 'tHE pHINX dOOR 4 dAYDREAM' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'The phinx door 4 daydream' });
  });

  it('de-shouts ALL-CAPS prose but keeps acronyms', async () => {
    const res = await request(app())
      .post(admin('/tidy-case'))
      .set(auth())
      .send({ text: 'THE QWK MAIL DOOR FOR EVERY BBS' });
    expect(res.body.text).toBe('The QWK mail door for every BBS');
  });

  it('leaves normal casing alone', async () => {
    const res = await request(app()).post(admin('/tidy-case')).set(auth()).send({ text: 'Normal text stays put' });
    expect(res.body.text).toBe('Normal text stays put');
  });

  it('refuses a body without a string to tidy', async () => {
    expect((await request(app()).post(admin('/tidy-case')).set(auth()).send({})).status).toBe(400);
    expect((await request(app()).post(admin('/tidy-case')).set(auth()).send({ text: 4 })).status).toBe(400);
  });
});
