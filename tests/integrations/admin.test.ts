// tests/integrations/admin.test.ts
//
// Admin management for the integrations: auth fence, toggles, secrets
// write-only, custom CRUD, validation, rate limits, prior-integration
// cards. The live Test button is pinned through the SSRF guard (a
// private-host URL fails fast with no network), never live HTTP.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { openDb, applySchema } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import { bootstrapAdmins } from '../../src/auth';
import { createApp } from '../../src/app';
import type { ServerConfig } from '../../src/config';

const SECRET = 'a-test-secret-that-is-long-enough-to-pass';
let dir: string;
let cfg: ServerConfig;
let token: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-intadm-'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = {
    dbPath,
    archivesRoot: dir,
    port: 3010,
    adminKeys: [{ label: 'spot', key: 'correct horse battery staple' }],
    jwtSecret: SECRET, learnKey: null,
    achievements: null, releases: null,
  } as ServerConfig;
  const db = openDb(cfg);
  applySchema(db);
  runMigrations(db);
  bootstrapAdmins(db, cfg);
  db.close();

  const res = await request(createApp(cfg))
    .post('/api/door-repo/admin/login')
    .send({ username: 'spot', password: 'correct horse battery staple' });
  token = res.body.token;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const app = () => createApp(cfg);
const authed = () => ({ Authorization: `Bearer ${token}` });
const base = '/api/door-repo/admin/integrations';

const CUSTOM = {
  name: 'films',
  displayName: 'Film DB',
  baseUrl: 'https://films.example.org',
  authMode: 'none',
  endpoints: {
    search: { path: '/search', params: { q: '{q}' }, items: 'results', title: 'title', detail: 'overview', url: 'link' },
  },
};

describe('integrations admin', () => {
  it('refuses without a token', async () => {
    expect((await request(app()).get(base)).status).toBe(401);
  });

  it('lists built-ins enabled by default, keyless on, keyed dark', async () => {
    const res = await request(app()).get(base).set(authed());
    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(11);
    const pouet = res.body.sources.find((s: { id: string }) => s.id === 'pouet');
    expect(pouet.enabled).toBe(true);
    const tmdb = res.body.sources.find((s: { id: string }) => s.id === 'tmdb');
    expect(tmdb.enabled).toBe(false);
    expect(tmdb.secretNames).toEqual([]);
  });

  it('toggles a source off and on', async () => {
    await request(app()).patch(`${base}/pouet`).set(authed()).send({ enabled: false });
    let res = await request(app()).get(base).set(authed());
    expect(res.body.sources.find((s: { id: string }) => s.id === 'pouet').enabled).toBe(false);
    await request(app()).patch(`${base}/pouet`).set(authed()).send({ enabled: true });
    res = await request(app()).get(base).set(authed());
    expect(res.body.sources.find((s: { id: string }) => s.id === 'pouet').enabled).toBe(true);
  });

  it('stores secrets write-only: names listed, values never returned', async () => {
    const put = await request(app()).post(`${base}/modarchive/secrets`).set(authed())
      .send({ secret: 'SUPER-SE-VALUE' });
    expect(put.status).toBe(200);
    const res = await request(app()).get(base).set(authed());
    const mod = res.body.sources.find((s: { id: string }) => s.id === 'modarchive');
    expect(mod.secretNames).toEqual(['api_key']);
    expect(JSON.stringify(res.body)).not.toContain('SUPER-SE-VALUE');
  });

  it('deletes secrets', async () => {
    await request(app()).post(`${base}/modarchive/secrets`).set(authed()).send({ secret: 'X' });
    await request(app()).delete(`${base}/modarchive/secrets/api_key`).set(authed());
    const res = await request(app()).get(base).set(authed());
    expect(res.body.sources.find((s: { id: string }) => s.id === 'modarchive').secretNames).toEqual([]);
  });

  it('creates, validates, and deletes custom sources; built-ins never delete', async () => {
    const bad = await request(app()).post(base).set(authed()).send({ name: 'pouet', baseUrl: 'https://x', authMode: 'none', endpoints: {} });
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0]).toMatch(/collides/);

    const created = await request(app()).post(base).set(authed()).send(CUSTOM);
    expect(created.status).toBe(201);
    expect(created.body.source.source).toBe('custom:films');

    const list = await request(app()).get(base).set(authed());
    const custom = list.body.sources.find((s: { id: string }) => s.id === 'custom:films');
    expect(custom.name).toBe('Film DB');
    expect(custom.builtin).toBe(false);

    expect((await request(app()).delete(`${base}/pouet`).set(authed())).status).toBe(400);
    expect((await request(app()).delete(`${base}/custom:films`).set(authed())).status).toBe(200);
  });

  it('rate-limits secret writes', async () => {
    for (let i = 0; i < 10; i++) {
      await request(app()).post(`${base}/radio/secrets`).set(authed()).send({ secret: `v${i}` });
    }
    const over = await request(app()).post(`${base}/radio/secrets`).set(authed()).send({ secret: 'over' });
    expect(over.status).toBe(429);
  });

  it('the test button fails closed on private hosts with no network', async () => {
    await request(app()).post(base).set(authed()).send({
      ...CUSTOM, name: 'local', baseUrl: 'https://127.0.0.1:1',
    });
    const res = await request(app()).post(`${base}/custom:local/test`).set(authed()).send({ q: 'x' });
    expect(res.body.error).toMatch(/private host/);
  });

  it('demozoo-import card reports counts and the re-run line', async () => {
    const res = await request(app()).get(`${base}/demozoo-import`).set(authed());
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(0);
    expect(res.body.rowsEnriched).toBe(0);
    expect(res.body.rerun).toContain('demozoo-import');
  });

  it('releases card 404s when the surface is unconfigured', async () => {
    const res = await request(app()).get(`${base}/releases`).set(authed());
    expect(res.status).toBe(404);
  });
});
