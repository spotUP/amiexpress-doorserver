/**
 * The JSON API the web browser reads. Public and read-only: no request here
 * carries a token, and every one of them must work without a login.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { openDb, applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { createApp } from '../src/app';
import { _closeEventStreamsForTests } from '../src/public-routes';
import type { ServerConfig } from '../src/config';

let dir: string;
let cfg: ServerConfig;

const DOORS: [string, string, string, string, string, number, string | null][] = [
  // id, archive, path, name, type, size, requires
  ['id1', 'ACC-V103.LHA', 'AmiExpress/ACC-V103.LHA', 'Account Editor', 'AIM', 4711, '/X 3.38+'],
  ['id2', 'CHATT101.LHA', 'FAME/CHATT101.LHA', 'Chat Time', 'FIM', 9000, null],
  ['id3', 'LOOSE.LHA', 'LOOSE.LHA', 'Loose Door', 'XIM', 2048, '/X 2.x'],
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-pub-'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: dir, port: 3010, adminKeys: [], jwtSecret: null, learnKey: null };
  const db = openDb(cfg);
  applySchema(db);
  runMigrations(db);
  const insert = db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, name, door_type, archive_size, requires_bbs,
        author, release_group, category, file_id_diz, doc_raw, md5, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'Wize/Access', 'ACS', 'utility',
             'Account Editor v1.0 - edits every field of a user account', 'the doc', 'aa', 1700000000)`
  );
  for (const d of DOORS) insert.run(...d);
  db.prepare(
    `INSERT INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason)
     VALUES ('id1', 'AccEd', 25552, 0, NULL), ('id1', 'TC.displayme', 1346, 1, 'ad')`
  ).run();
  db.close();
});

afterEach(() => {
  _closeEventStreamsForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (url: string) => request(createApp(cfg)).get(`/api/door-repo${url}`);

describe('GET /doors', () => {
  it('lists every door with no login', async () => {
    const res = await get('/doors');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.rows).toHaveLength(3);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('describes each door from its DIZ, and says where that came from', async () => {
    const res = await get('/doors?q=ACC');
    expect(res.body.rows[0].description).toContain('edits every field');
    expect(res.body.rows[0].descriptionSource).toBe('diz');
  });

  it('serves an edited description instead, marked as edited', async () => {
    const db = openDb(cfg);
    db.prepare(
      "INSERT INTO door_catalog_overrides (catalog_id, field, value, edited_at) VALUES ('id1', 'description', ?, 1700001000)"
    ).run('A human wrote this');
    db.close();
    const res = await get('/doors?q=ACC');
    expect(res.body.rows[0].description).toBe('A human wrote this');
    expect(res.body.rows[0].descriptionSource).toBe('edited');
  });

  it('pages, and reports the total rather than the page size', async () => {
    const res = await get('/doors?per_page=2&page=2');
    expect(res.body.total).toBe(3);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.page).toBe(2);
  });

  it('sorts by a named column in both directions', async () => {
    const asc = await get('/doors?sort=size&dir=asc');
    const desc = await get('/doors?sort=size&dir=desc');
    expect(asc.body.rows.map((r: { size: number }) => r.size)).toEqual([2048, 4711, 9000]);
    expect(desc.body.rows.map((r: { size: number }) => r.size)).toEqual([9000, 4711, 2048]);
  });

  it('ignores a sort key it does not know rather than trusting it', async () => {
    // `sort` arrives from a URL; an unknown key must not reach SQL.
    const res = await get('/doors?sort=archive_name;DROP TABLE door_catalog--');
    expect(res.status).toBe(200);
    expect(res.body.sort).toBe('archive_name;DROP TABLE door_catalog--');
    expect(res.body.rows.map((r: { archiveName: string }) => r.archiveName)).toEqual([
      'ACC-V103.LHA',
      'CHATT101.LHA',
      'LOOSE.LHA',
    ]);
    const db = openDb(cfg);
    expect(db.prepare('SELECT COUNT(*) n FROM door_catalog').get()).toEqual({ n: 3 });
    db.close();
  });

  it('filters by system, type and required BBS version', async () => {
    expect((await get('/doors?system=FAME')).body.rows.map((r: { archiveName: string }) => r.archiveName)).toEqual([
      'CHATT101.LHA',
    ]);
    expect((await get('/doors?type=AIM')).body.total).toBe(1);
    expect((await get('/doors?requires=/X 2.x')).body.rows[0].archiveName).toBe('LOOSE.LHA');
  });

  it('calls a door with no directory segment Unsorted, and can filter on that', async () => {
    const res = await get('/doors?system=Unsorted');
    expect(res.body.rows.map((r: { archiveName: string }) => r.archiveName)).toEqual(['LOOSE.LHA']);
    expect(res.body.rows[0].system).toBe('Unsorted');
  });

  it('searches names, authors, groups and the DIZ itself', async () => {
    expect((await get('/doors?q=Wize')).body.total).toBe(3);
    expect((await get('/doors?q=every field of a user')).body.total).toBe(3);
    expect((await get('/doors?q=nothing matches this')).body.total).toBe(0);
  });

  it('caps per_page so one request cannot ask for the whole corpus', async () => {
    expect((await get('/doors?per_page=99999')).body.perPage).toBe(200);
  });

  it('offers a download URL that actually downloads the archive', async () => {
    fs.mkdirSync(path.join(dir, 'AmiExpress'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'AmiExpress', 'ACC-V103.LHA'), 'archive bytes');
    const res = await get('/doors?q=ACC');
    const url = res.body.rows[0].downloadUrl;
    expect(url).toBe('/api/door-repo/archive/ACC-V103.LHA');
    // Walk it: a URL the UI shows must be one the server answers.
    const download = await request(createApp(cfg)).get(url);
    expect(download.status).toBe(200);
    expect(download.body.toString()).toBe('archive bytes');
  });
});

describe('finding the names that are guesses', () => {
  it('filters by where the name came from', async () => {
    // LOOSE.LHA's catalog name reads as a name; give one door art for a
    // name and no program, and its name can only come from the archive.
    const db = openDb(cfg);
    db.prepare("UPDATE door_catalog SET name = '____________________' WHERE id = 'id2'").run();
    db.close();

    const guesses = await get('/doors?name_source=archive');
    expect(guesses.body.rows.map((r: { archiveName: string }) => r.archiveName)).toEqual(['CHATT101.LHA']);
    expect(guesses.body.total).toBe(1);
    expect(guesses.body.rows[0].nameSource).toBe('archive');

    const real = await get('/doors?name_source=catalog');
    expect(real.body.total).toBe(2);
  });

  it('pages the filtered set, not the whole catalog', async () => {
    const res = await get('/doors?name_source=catalog&per_page=1&page=2');
    expect(res.body.total).toBe(3);
    expect(res.body.rows).toHaveLength(1);
  });

  it('an edited name counts as a real name, not a guess', async () => {
    const db = openDb(cfg);
    db.prepare("UPDATE door_catalog SET name = '____________________' WHERE id = 'id2'").run();
    db.prepare(
      "INSERT INTO door_catalog_overrides (catalog_id, field, value, edited_at) VALUES ('id2', 'name', 'Chat Time', 1700001000)"
    ).run();
    db.close();
    const guesses = await get('/doors?name_source=archive');
    expect(guesses.body.total).toBe(0);
  });
});

describe('GET /doors/:archiveName', () => {
  it('returns the full FILE_ID.DIZ, the doc and the file list', async () => {
    const res = await get('/doors/ACC-V103.LHA');
    expect(res.status).toBe(200);
    expect(res.body.fileIdDiz).toContain('Account Editor v1.0');
    expect(res.body.doc).toBe('the doc');
    expect(res.body.files).toEqual([
      { path: 'AccEd', size: 25552, isJunk: false, junkReason: null },
      { path: 'TC.displayme', size: 1346, isJunk: true, junkReason: 'ad' },
    ]);
  });

  it('404s for a door that does not exist', async () => {
    expect((await get('/doors/NOPE.LHA')).status).toBe(404);
  });

  it('does not shadow the byte-exact legacy routes', async () => {
    // /archive, /list.txt and /index.tsv live in routes.ts and must still
    // answer even though this router is mounted first.
    expect((await get('/list.txt')).status).toBe(200);
    expect((await get('/index.tsv')).status).toBe(200);
    expect((await get('/health')).status).toBe(200);
  });
});

describe('GET /facets', () => {
  it('reports what the filters can offer, with counts', async () => {
    const res = await get('/facets');
    expect(res.status).toBe(200);
    expect(res.body.systems).toEqual(
      expect.arrayContaining([
        { value: 'AmiExpress', n: 1 },
        { value: 'FAME', n: 1 },
        { value: 'Unsorted', n: 1 },
      ])
    );
    expect(res.body.types).toEqual(
      expect.arrayContaining([
        { value: 'AIM', n: 1 },
        { value: 'FIM', n: 1 },
        { value: 'XIM', n: 1 },
      ])
    );
    expect(res.body.requires).toEqual(
      expect.arrayContaining([
        { value: '/X 3.38+', n: 1 },
        { value: '/X 2.x', n: 1 },
      ])
    );
  });
});

describe('GET /events', () => {
  it('opens an event stream and states the current revision immediately', async () => {
    const res = await request(createApp(cfg))
      .get('/api/door-repo/events')
      .buffer(true)
      .parse((r, cb) => {
        // An SSE stream never ends on its own; read the first message and
        // close, which is exactly what a browser tab does on navigate-away.
        r.on('data', (chunk: Buffer) => {
          cb(null, chunk.toString('utf-8'));
          (r as unknown as { destroy: () => void }).destroy();
        });
        r.on('error', () => cb(null, ''));
      });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.body).toContain('event: revision');
    expect(res.body).toContain('c3-t1700000000');
  });
});
