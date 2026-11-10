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
        (dir_no, file_no, filename, flag, size_bytes, size_note, date_iso, dl_count, uploader, description, version, author, release_group, release_group_full, raw_desc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run(1, 1, 'BETTER.WRP', 'N', 324864, null, '1988-12-12', null, 'AMON', 'Dead than Alien! Kool game.', null, null, null, null, 'Better Dead than Alien! Kool game!');
    ins.run(2, 1, 'SCAPEMAK.DMS', 'D', null, '>NUKED<', '1992-03-28', null, null, 'Scape Maker.', '1.3', null, null, null, 'Scape Maker v1.3');
    ins.run(61, 2, 'STORM-TR.LHA', 'P', 420431, null, '2020-01-03', 5, 'AMON', 'Storm tracker.', null, null, 'STORM', 'Storm', 'Storm tracker.');
    ins.run(61, 3, 'PRISM2V2.LHA', 'P', 420431, null, '2020-01-03', 5, 'SiDeSaLaD', 'Prism2v2.Device for WiFi!', null, null, null, null, 'Prism2v2.Device for WiFi!');
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
    expect(res.body).toEqual({ status: 'ok', contractVersion: '1', revision: 'r4-t4', files: 4 });
    expect(res.headers['x-releases-contract']).toBe('1');
    expect(res.headers['x-releases-revision']).toBe('r4-t4');
  });

  it('lists with filters and pagination', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const all = await request(app).get('/releases/v1/list');
    expect(all.body.total).toBe(4);
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

  it('sorts by a named column in both directions', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const asc = await request(app).get('/releases/v1/list?sort=filename&order=asc');
    expect(asc.body.rows.map((r: { filename: string }) => r.filename)).toEqual([
      'BETTER.WRP',
      'PRISM2V2.LHA',
      'SCAPEMAK.DMS',
      'STORM-TR.LHA',
    ]);
    const dateDesc = await request(app).get('/releases/v1/list?sort=date&order=desc');
    expect(dateDesc.body.rows[0].dateIso).toBe('2020-01-03');
    expect(dateDesc.body.rows[dateDesc.body.rows.length - 1].dateIso).toBe('1988-12-12');
    // Unknown sort keys fall back to id order rather than 500ing.
    const bogus = await request(app).get('/releases/v1/list?sort=nope');
    expect(bogus.status).toBe(200);
    expect(bogus.body.rows.map((r: { id: number }) => r.id)).toEqual([1, 2, 3, 4]);
  });

  it('filters by entry-date range with from/to', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const res = await request(app).get('/releases/v1/list?from=1990-01-01&to=2021-12-31');
    expect(res.body.total).toBe(3);
    // A month UI sends whole-month bounds; March 1992 alone is the nuked row.
    const month = await request(app).get('/releases/v1/list?from=1992-03-01&to=1992-03-31');
    expect(month.body.total).toBe(1);
    expect(month.body.rows[0].filename).toBe('SCAPEMAK.DMS');
  });

  it('serves one file and 404s unknown ids', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const one = await request(app).get('/releases/v1/files/1');
    expect(one.status).toBe(200);
    expect(one.body.filename).toBe('BETTER.WRP');
    expect(one.body.rawDesc).toContain('Better Dead than Alien');
    expect((await request(app).get('/releases/v1/files/999')).status).toBe(404);
    expect((await request(app).get('/releases/v1/files/nope')).status).toBe(404);
  });

  it('pages deltas with ?since= in ascending id order', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const res = await request(app).get('/releases/v1/list?since=1');
    expect(res.body.total).toBe(3);
    expect(res.body.rows.map((r: { id: number }) => r.id)).toEqual([2, 3, 4]);
    // since forces asc even when desc is asked for
    const forced = await request(app).get('/releases/v1/list?since=1&order=desc');
    expect(forced.body.rows.map((r: { id: number }) => r.id)).toEqual([2, 3, 4]);
  });

  it('selects columns with ?fields= and always keeps id', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const res = await request(app).get('/releases/v1/list?fields=filename,flag&limit=1');
    expect(res.body.rows[0]).toEqual({ id: 1, filename: 'BETTER.WRP', flag: 'N' });
    const junk = await request(app).get('/releases/v1/list?fields=filename,nope&limit=1');
    expect(junk.body.rows[0]).toEqual({ id: 1, filename: 'BETTER.WRP' });
  });

  it('dumps NDJSON slim by default and resumes from ?since=', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const full = await request(app).get('/releases/v1/dump');
    expect(full.headers['content-type']).toContain('x-ndjson');
    const lines = full.text.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0]).filename).toBe('BETTER.WRP');
    expect('rawDesc' in JSON.parse(lines[0])).toBe(false);
    const resumed = await request(app).get('/releases/v1/dump?since=2');
    expect(resumed.text.trim().split('\n')).toHaveLength(2);
    const art = await request(app).get('/releases/v1/dump?fields=filename,rawDesc&limit=1');
    expect('rawDesc' in JSON.parse(art.text.trim())).toBe(true);
  });

  it('filters by group and lists groups with counts', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const app = createApp(cfg);
    const g = await request(app).get('/releases/v1/groups');
    expect(g.body.groups).toEqual([{ abbreviation: 'STORM', fullName: 'Storm', files: 1 }]);
    const f = await request(app).get('/releases/v1/list?group=storm');
    expect(f.body.total).toBe(1);
    expect(f.body.rows[0].releaseGroup).toBe('STORM');
  });

  it('answers stats with flag, group and uploader breakdowns', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const res = await request(createApp(cfg)).get('/releases/v1/stats');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.withUploader).toBe(3);
    expect(res.body.withDlCount).toBe(2);
    expect(res.body.byUploader[0]).toEqual({ value: 'AMON', n: 2 });
    expect(res.body.byFlag).toContainEqual({ value: 'P', n: 2 });
    expect(res.body.byGroup).toEqual([{ value: 'STORM', n: 1 }]);
    expect(res.body.sizeDistribution).toContainEqual({ value: 'No size (nuked)', n: 1 });
    expect(res.body.overTime[0]).toEqual({ value: '1988-12', n: 1 });
    expect(res.headers['x-releases-contract']).toBe('1');
  });

  it('answers facts with headline records', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    // One art-bearing description so firstDiz has a winner (base seed is prose),
    // plus an EARLIER art row with a conflicting twin date (same file, two
    // dates = BBS typo): it must not win "first".
    const db = new Database(cfg.releases!.dbPath);
    try {
      const ins = db.prepare(
        `INSERT INTO release_files
           (dir_no, file_no, filename, flag, size_bytes, size_note, date_iso, dl_count, uploader, description, version, author, release_group, release_group_full, raw_desc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      ins.run(7, 1, 'ARTDIZ.LHA', 'P', 100, null, '1990-06-01', null, null, 'An art diz.', null, null, null, null, '____\n| art |\n| art |\n____');
      ins.run(7, 2, 'TYPO.LHA', 'P', 50, null, '1989-01-01', null, null, 'Typo date.', null, null, null, null, '____\n| art |\n| art |\n____');
      ins.run(8, 1, 'TYPO.LHA', 'P', 50, null, '1999-01-01', null, null, 'Typo date.', null, null, null, null, '____\n| art |\n| art |\n____');
    } finally {
      db.close();
    }
    const res = await request(createApp(cfg)).get('/releases/v1/facts');
    expect(res.status).toBe(200);
    expect(res.body.span.firstDate).toBe('1988-12-12');
    expect(res.body.span.lastDate).toBe('2020-01-03');
    expect(res.body.span.firstFile.filename).toBe('BETTER.WRP');
    expect(res.body.firstDiz.filename).toBe('ARTDIZ.LHA');
    expect(res.body.firstDiz.lines).toBe(4);
    expect(res.body.peakYear).toEqual({ year: '2020', n: 2 });
    expect(res.body.peakMonth).toEqual({ month: '2020-01', n: 2 });
    expect(res.body.topExt[0]).toEqual({ ext: '.LHA', n: 5 });
    expect(res.body.extCrossover).toBeNull();
    expect(res.body.weekday.day).toBe('Friday');
    expect(res.body.biggest.sizeBytes).toBe(420431);
    expect(res.body.longestDesc.filename).toBe('BETTER.WRP');
    expect(res.body.mostDownloaded.dlCount).toBe(5);
    expect(res.body.medianSize).toBe(100);
    expect(res.body.futureCount).toBe(0);
  });

  it('serves a random release with the full row', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const names = ['BETTER.WRP', 'SCAPEMAK.DMS', 'STORM-TR.LHA', 'PRISM2V2.LHA'];
    for (let i = 0; i < 5; i++) {
      const res = await request(createApp(cfg)).get('/releases/v1/random');
      expect(res.status).toBe(200);
      expect(names).toContain(res.body.filename);
      expect(res.body).toHaveProperty('rawDesc');
      expect(res.body).toHaveProperty('dateIso');
    }
  });

  it('serves list.txt in the house format', async () => {
    const cfg = makeCfg();
    seedReleases(cfg);
    const res = await request(createApp(cfg)).get('/releases/v1/list.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('ISO-8859-1');
    const lines = res.text.split('\r\n').filter((l: string) => l.length > 0);
    expect(lines[0]).toMatch(/^RELEASE\|1\|r4-t4\|4$/);
    expect(lines).toHaveLength(5);
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
