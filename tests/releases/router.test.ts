/**
 * The releases surface, driven through the real app like every other router
 * suite (never a router in isolation). Uses a small scratch releases.db.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createApp } from '../../src/app';
import { applyReleasesSchema } from '../../src/releases/db';
import type { ServerConfig } from '../../src/config';

let dir: string;

function makeCfg(): ServerConfig {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-relapi-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  const doorsDb = path.join(dir, 'doors.db');
  fs.writeFileSync(doorsDb, '');
  const { openDb, applySchema } = require('../../src/db') as typeof import('../../src/db');
  const { runMigrations } = require('../../src/migrations') as typeof import('../../src/migrations');
  const db = openDb({ dbPath: doorsDb } as ServerConfig);
  applySchema(db);
  runMigrations(db);
  db.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'ACC-V103.LHA', 'Account Editor', 'XIM', 1700000000)`
  ).run();
  db.close();
  return {
    dbPath: doorsDb,
    archivesRoot: path.join(dir, 'Archives'),
    port: 3010,
    adminKeys: [],
    jwtSecret: null,
    learnKey: null,
    achievements: null,
    releases: { dbPath: path.join(dir, 'releases.db') },
  };
}

function seedReleases(cfg: ServerConfig): void {
  const db = new Database(cfg.releases!.dbPath);
  try {
    applyReleasesSchema(db);
    const ins = db.prepare(
      `INSERT INTO release_files
        (dir_no, file_no, filename, flag, size_bytes, size_note, date_iso, dl_count, uploader, description, version, author, raw_desc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run(1, 1, 'BETTER.WRP', 'N', 324864, null, '1988-12-12', null, null, 'Dead than Alien! Kool game.', null, null, 'Better Dead than Alien! Kool game!');
    ins.run(2, 1, 'SCAPEMAK.DMS', 'D', null, '>NUKED<', '1992-03-28', null, null, 'Scape Maker.', '1.3', null, 'Scape Maker v1.3');
    ins.run(61, 2, 'PRISM2V2.LHA', 'P', 420431, null, '2020-01-03', 5, null, 'Prism2v2.Device for WiFi!', null, null, 'Prism2v2.Device for WiFi!');
  } finally {
    db.close();
  }
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('releases surface', () => {
  it('answers health with contract, revision and file count', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const res = await request(createApp(cfg)).get('/releases/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', contractVersion: '1', revision: 'r3-t3', files: 3 });
    expect(res.headers['x-releases-contract']).toBe('1');
    expect(res.headers['x-releases-revision']).toBe('r3-t3');
  });

  it('lists with filters and pagination', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const all = await request(app).get('/releases/v1/list');
    expect(all.body.total).toBe(3);
    const nuked = await request(app).get('/releases/v1/list?flag=D');
    expect(nuked.body.total).toBe(1);
    expect(nuked.body.rows[0].filename).toBe('SCAPEMAK.DMS');
    const q = await request(app).get('/releases/v1/list?q=prism');
    expect(q.body.total).toBe(1);
    const page = await request(app).get('/releases/v1/list?limit=1&offset=1');
    expect(page.body.rows).toHaveLength(1);
    expect(page.body.limit).toBe(1);
    expect(page.body.offset).toBe(1);
  });

  it('serves one file and 404s unknown ids', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const one = await request(app).get('/releases/v1/files/1');
    expect(one.status).toBe(200);
    expect(one.body.filename).toBe('BETTER.WRP');
    expect((await request(app).get('/releases/v1/files/999')).status).toBe(404);
    expect((await request(app).get('/releases/v1/files/nope')).status).toBe(404);
  });

  it('serves list.txt in the house format', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const res = await request(createApp(cfg)).get('/releases/v1/list.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('ISO-8859-1');
    const lines = res.text.split('\r\n').filter((l: string) => l.length > 0);
    expect(lines[0]).toMatch(/^RELEASE\|1\|r3-t3\|3$/);
    expect(lines).toHaveLength(4);
  });

  it('is absent without RELEASES_DB and answers CORS openly when present', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const pre = await request(app).options('/releases/v1/list');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    // With RELEASES_DB unset nothing is mounted: in this repo the built SPA
    // catch-all answers 200+index.html, so assert it is NOT the releases API.
    const off = createApp({ ...cfg, releases: null });
    const gone = await request(off).get('/releases/v1/health');
    expect(gone.body.files).toBeUndefined();
    expect(gone.headers['x-releases-contract']).toBeUndefined();
  });
});
