import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { openDb, applySchema } from '../src/db';
import { createApp } from '../src/app';
import type { ServerConfig } from '../src/config';

let dir: string;
let cfg: ServerConfig;
let app: ReturnType<typeof createApp>;

const ARCHIVE_BYTES = Buffer.from([0x4c, 0x5a, 0x00, 0xa1, 0xff]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-rt-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  fs.writeFileSync(path.join(dir, 'Archives', 'ACC-V103.LHA'), ARCHIVE_BYTES);
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: path.join(dir, 'Archives'), port: 3010, adminKeys: [] };
  const db = openDb(cfg);
  applySchema(db);
  db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, name, door_type, file_id_diz, doc_raw,
        doc_filename, archive_size, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'ACC-V103.LHA', 'Account Editor', 'XIM',
             'DIZ line', 'doc bytes', 'AccEd.Doc', 5, 1700000000)`
  ).run();
  db.prepare(
    `INSERT INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason)
     VALUES ('id1', 'Account/AccEd.Rexx', 25552, 0, NULL)`
  ).run();
  db.close();
  app = createApp(cfg);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('read API', () => {
  it('serves the manifest with the revision as ETag', async () => {
    const res = await request(app).get('/api/door-repo/manifest');
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"c1-t1700000000"');
    expect(res.headers['x-door-repo-revision']).toBe('c1-t1700000000');
    expect(res.body.doors).toHaveLength(1);
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const res = await request(app)
      .get('/api/door-repo/manifest')
      .set('If-None-Match', '"c1-t1700000000"');
    expect(res.status).toBe(304);
  });

  it('serves list.txt as ISO-8859-1 with CRLF', async () => {
    const res = await request(app).get('/api/door-repo/list.txt');
    expect(res.headers['content-type']).toContain('ISO-8859-1');
    expect(res.text).toContain('DOORREPO|1|c1-t1700000000|1');
    expect(res.text).toContain('\r\n');
  });

  it('serves the files listing in the FILES| format', async () => {
    const res = await request(app).get('/api/door-repo/files/ACC-V103.LHA');
    expect(res.text.split('\r\n')[0]).toBe('FILES|1|0');
    expect(res.text).toContain('25552|0|Account/AccEd.Rexx');
  });

  it('serves the diz and 404s when there is none', async () => {
    expect((await request(app).get('/api/door-repo/diz/ACC-V103.LHA')).text).toBe('DIZ line');
    expect((await request(app).get('/api/door-repo/diz/NOPE.LHA')).status).toBe(404);
  });

  it('serves the doc with a sanitised filename header', async () => {
    const res = await request(app).get('/api/door-repo/doc/ACC-V103.LHA');
    expect(res.headers['x-doc-filename']).toBe('AccEd.Doc');
    expect(res.text).toBe('doc bytes');
  });

  it('streams the archive with checksum headers and an exact length', async () => {
    const res = await request(app).get('/api/door-repo/archive/ACC-V103.LHA').buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(ARCHIVE_BYTES.length));
    expect(res.headers['x-archive-md5']).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers['x-archive-sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('404s an unknown archive with the plain-text body clients parse', async () => {
    const res = await request(app).get('/api/door-repo/archive/NOPE.LHA');
    expect(res.status).toBe(404);
    expect(res.text).toBe('NOT FOUND: NOPE.LHA\r\n');
  });

  it('404s a traversal payload instead of reaching the filesystem', async () => {
    const res = await request(app).get('/api/door-repo/archive/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(404);
  });

  it('serves health without hashing the corpus', async () => {
    const res = await request(app).get('/api/door-repo/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', revision: 'c1-t1700000000', doors: 1 });
  });
});
