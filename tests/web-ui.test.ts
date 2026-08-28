/**
 * Serving the browser UI.
 *
 * The API and the site share one origin, so the two must not collide: every
 * /api path stays with its router, and everything else is the single-page
 * app - including a deep link, which has to survive a hard refresh.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { openDb, applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { createApp } from '../src/app';
import type { ServerConfig } from '../src/config';

let dir: string;
let cfg: ServerConfig;

const webRoot = path.join(__dirname, '..', 'dist', 'web');
const hasBuiltUi = fs.existsSync(path.join(webRoot, 'index.html'));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-web-'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: dir, port: 3010, adminKeys: [], jwtSecret: null, learnKey: null };
  const db = openDb(cfg);
  applySchema(db);
  runMigrations(db);
  db.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'AmiExpress/ACC-V103.LHA', 'Account Editor', 'XIM', 1700000000)`
  ).run();
  db.close();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// The UI is built by `npm --prefix web run build`; a server compiled without
// it simply has no dist/web and serves the API alone, which is exactly what
// the mount does. Skipping keeps a source-only checkout green.
const describeUi = hasBuiltUi ? describe : describe.skip;

describeUi('the built UI', () => {
  it('serves the app at the root', async () => {
    const res = await request(createApp(cfg)).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<div id="root">');
  });

  it('serves the same app for a deep link, so a hard refresh works', async () => {
    const res = await request(createApp(cfg)).get('/doors/ACC-V103.LHA');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it('never caches index.html, and caches hashed assets forever', async () => {
    const app = createApp(cfg);
    const index = await request(app).get('/');
    expect(index.headers['cache-control']).toBe('no-cache');

    const asset = /\/assets\/[^"]+\.js/.exec(index.text)?.[0];
    expect(asset).toBeDefined();
    const js = await request(app).get(asset as string);
    expect(js.status).toBe(200);
    expect(js.headers['cache-control']).toContain('immutable');
  });

  it('does not swallow the API', async () => {
    const app = createApp(cfg);
    expect((await request(app).get('/api/door-repo/health')).status).toBe(200);
    expect((await request(app).get('/api/door-repo/doors')).status).toBe(200);
    // index.tsv is served as Latin-1 plain text - the format uhcsearch
    // expects, and part of the byte-exact contract.
    expect((await request(app).get('/api/door-repo/index.tsv')).headers['content-type']).toContain(
      'charset=ISO-8859-1'
    );
    // An unknown API path is a 404 from the API, never the HTML shell.
    const missing = await request(app).get('/api/door-repo/nope');
    expect(missing.status).toBe(404);
    expect(missing.text).not.toContain('<div id="root">');
  });
});
