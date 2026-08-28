import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { openDb, applySchema } from '../src/db';
import { createApp } from '../src/app';
import { candidateArchiveNames } from '../src/routes';
import { _clearListCacheForTests } from '../src/manifest';
import type { ServerConfig } from '../src/config';

let dir: string;
let cfg: ServerConfig;
let app: ReturnType<typeof createApp>;

const ARCHIVE_BYTES = Buffer.from([0x4c, 0x5a, 0x00, 0xa1, 0xff]);

beforeEach(() => {
  _clearListCacheForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-rt-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  fs.writeFileSync(path.join(dir, 'Archives', 'ACC-V103.LHA'), ARCHIVE_BYTES);
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: path.join(dir, 'Archives'), port: 3010, adminKeys: [], jwtSecret: null, learnKey: null };
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
    expect(res.text.endsWith('\r\n')).toBe(true);
    expect(res.text).not.toMatch(/[^\r]\n/);
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
    const res = await request(app)
      .get('/api/door-repo/archive/ACC-V103.LHA')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (d: Buffer) => chunks.push(d));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(ARCHIVE_BYTES.length));
    expect(res.headers['x-archive-md5']).toMatch(/^[0-9a-f]{32}$/);
    expect(res.headers['x-archive-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.compare(res.body as Buffer, ARCHIVE_BYTES)).toBe(0);
  });

  it('404s an unknown archive with the plain-text body clients parse', async () => {
    const res = await request(app).get('/api/door-repo/archive/NOPE.LHA');
    expect(res.status).toBe(404);
    expect(res.text).toBe('NOT FOUND: NOPE.LHA\r\n');
  });

  it('404s a traversal payload instead of reaching the filesystem', async () => {
    const res = await request(app).get('/api/door-repo/archive/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(404);
    expect(res.text).toBe('NOT FOUND: ../../etc/passwd\r\n');
  });

  it('serves health without hashing the corpus', async () => {
    const res = await request(app).get('/api/door-repo/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', revision: 'c1-t1700000000', doors: 1 });
  });

  // The catch-all bails on any method that is not GET, so HEAD 404s on a
  // path GET serves happily. That asymmetry is pre-existing and the parity
  // fixtures capture it deliberately - pin it so a later "fix" cannot land
  // silently.
  it('does not answer HEAD on a per-archive path, though GET succeeds', async () => {
    expect((await request(app).head('/api/door-repo/files/ACC-V103.LHA')).status).toBe(404);
    expect((await request(app).get('/api/door-repo/files/ACC-V103.LHA')).status).toBe(200);
  });

  // A 304 must never pay for building - and transitively checksumming - a
  // manifest it is about to throw away.
  it('does not build the manifest when the client already has the revision', async () => {
    const manifest = require('../src/manifest') as typeof import('../src/manifest');
    const spy = jest.spyOn(manifest, 'buildManifest');
    const res = await request(app)
      .get('/api/door-repo/manifest')
      .set('If-None-Match', '"c1-t1700000000"');
    expect(res.status).toBe(304);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // 404 (not an empty 200) when the entry EXISTS but carries no art or doc,
  // so a client can tell "no art for this door" from "art that is empty".
  it('404s an entry that exists but carries no diz and no doc', async () => {
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id2', 'BARE.LHA', 'BARE.LHA', 'Bare', 'XIM', 1700000000)`
    ).run();
    db.close();
    expect((await request(app).get('/api/door-repo/diz/BARE.LHA')).status).toBe(404);
    expect((await request(app).get('/api/door-repo/doc/BARE.LHA')).status).toBe(404);
  });
});

describe('index.tsv', () => {
  it('serves the TSV index with the revision header and LF endings', async () => {
    const res = await request(app).get('/api/door-repo/index.tsv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('ISO-8859-1');
    expect(res.headers['x-door-repo-revision']).toBe('c1-t1700000000');
    expect(res.text.split('\n')[0]).toBe('Filename\tPath\tSize\tDescription');
    expect(res.text).not.toContain('\r');
  });

  it('carries a row for the seeded archive with a description derived from its DIZ', async () => {
    const res = await request(app).get('/api/door-repo/index.tsv');
    const row = res.text.split('\n').find((l: string) => l.startsWith('ACC-V103.LHA'));
    expect(row).toBe('ACC-V103.LHA\tUnsorted\t5B\tDIZ line');
  });

  it('honours ?type=', async () => {
    const res = await request(app).get('/api/door-repo/index.tsv?type=DD');
    expect(res.text.split('\n').filter((l: string) => l.startsWith('ACC-V103.LHA'))).toHaveLength(0);
  });
});

describe('recent.tsv', () => {
  it('serves the same header, encoding and revision header as index.tsv', async () => {
    const res = await request(app).get('/api/door-repo/recent.tsv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('ISO-8859-1');
    expect(res.headers['x-door-repo-revision']).toBe('c1-t1700000000');
    expect(res.text.split('\n')[0]).toBe('Filename\tPath\tSize\tDescription');
    expect(res.text).not.toContain('\r');
  });

  it('carries the catalog rows, newest first', async () => {
    const res = await request(app).get('/api/door-repo/recent.tsv');
    expect(res.text.split('\n').find((l: string) => l.startsWith('ACC-V103.LHA'))).toBeDefined();
  });

  it('honours ?n=', async () => {
    const res = await request(app).get('/api/door-repo/recent.tsv?n=1');
    expect(res.text.trimEnd().split('\n')).toHaveLength(2);
  });

  it('ignores an ?n= that is not a number rather than failing', async () => {
    const res = await request(app).get('/api/door-repo/recent.tsv?n=lots');
    expect(res.status).toBe(200);
    expect(res.text.split('\n')[0]).toBe('Filename\tPath\tSize\tDescription');
  });
});

describe('archive route: system segment and .diz basename (uhcsearch compatibility)', () => {
  it('resolves /archive/<system>/<filename> to the same bytes as /archive/<filename>', async () => {
    const direct = await request(app).get('/api/door-repo/archive/ACC-V103.LHA');
    const viaSystem = await request(app).get('/api/door-repo/archive/AmiExpress/ACC-V103.LHA');
    expect(viaSystem.status).toBe(200);
    expect(viaSystem.headers['x-archive-md5']).toBe(direct.headers['x-archive-md5']);
  });

  it('serves /archive/<basename>.diz as the FILE_ID.DIZ text', async () => {
    const res = await request(app).get('/api/door-repo/archive/ACC-V103.diz');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('ISO-8859-1');
    expect(res.text).toBe('DIZ line');
  });

  it('serves /archive/<system>/<basename>.diz the same way', async () => {
    const res = await request(app).get('/api/door-repo/archive/AmiExpress/ACC-V103.diz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('DIZ line');
  });

  it('404s a .diz request for an unknown basename', async () => {
    const res = await request(app).get('/api/door-repo/archive/NOPE.diz');
    expect(res.status).toBe(404);
    expect(res.text).toBe('NOT FOUND: NOPE.diz\r\n');
  });

  it('resolves an exact full-name match before the basename search', async () => {
    // Requesting the FULL name (extension included) plus ".diz" hits the
    // exact-match branch, not the basename search.
    const res = await request(app).get('/api/door-repo/archive/ACC-V103.LHA.diz');
    expect(res.status).toBe(200);
    expect(res.text).toBe('DIZ line');
  });

  it('404s rather than guessing when two archives share a basename', async () => {
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, file_id_diz, indexed_at)
       VALUES ('id2', 'ACC-V103.LZX', 'ACC-V103.LZX', 'Account Editor (LZX)', 'XIM', 'other diz', 1700000000)`
    ).run();
    db.close();
    const res = await request(app).get('/api/door-repo/archive/ACC-V103.diz');
    expect(res.status).toBe(404);
  });
});

describe('candidateArchiveNames', () => {
  it('decodes a normal UTF-8 percent-encoding', () => {
    expect(candidateArchiveNames('ACC%2DV103.LHA')).toContain('ACC-V103.LHA');
  });

  // %DF alone is not valid UTF-8, but it is sharp-s in ISO-8859-1. A real
  // catalog name ($CP-BU<sharp-s>1.LZX) is encoded exactly this way by an
  // Amiga client, and decodeURIComponent throws on it - which used to be a
  // 500 rather than a download.
  it('falls back to Latin-1 for an escape that is not valid UTF-8', () => {
    expect(candidateArchiveNames('%24CP-BU%DF1.LZX')).toContain('$CP-BUß1.LZX');
  });

  it('offers the UTF-8 reading first when both readings are valid', () => {
    const out = candidateArchiveNames('%C3%9F.LHA');
    expect(out[0]).toBe('ß.LHA');
    expect(out).toHaveLength(2);
  });
});
