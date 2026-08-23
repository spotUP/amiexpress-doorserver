import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { openDb, applySchema } from '../src/db';
import { createApp } from '../src/app';
import { DOOR_REPO_ALLOWED_REQUEST_HEADERS, DOOR_REPO_EXPOSED_HEADERS } from '../src/cors';
import type { ServerConfig } from '../src/config';

let dir: string;
let cfg: ServerConfig;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-cors-'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: dir, port: 3010, adminKeys: [] };
  const db = openDb(cfg);
  applySchema(db);
  db.close();
  app = createApp(cfg);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('door-repo CORS', () => {
  it('sends Access-Control-Allow-Origin: * and the exposed headers list on a normal GET', async () => {
    const res = await request(app).get('/api/door-repo/health');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-expose-headers']).toBe(DOOR_REPO_EXPOSED_HEADERS.join(', '));
  });

  it('never sends Access-Control-Allow-Credentials (invalid with a wildcard origin)', async () => {
    const res = await request(app).get('/api/door-repo/health');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  // Load-bearing, not decorative: without this a browser page running
  // under Cross-Origin-Embedder-Policy cannot load this catalog (or an
  // archive download) as a subresource. The BBS-hosted API sends this via
  // helmet; this server has no helmet, so cors.ts must set it explicitly.
  it('sends Cross-Origin-Resource-Policy: cross-origin on a normal GET', async () => {
    const res = await request(app).get('/api/door-repo/health');
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  // Deliberately absent: COOP governs top-level browsing-context isolation
  // and does nothing for a JSON/text API response. Sending it would be
  // cargo-culting a header with no effect here.
  it('never sends Cross-Origin-Opener-Policy', async () => {
    const res = await request(app).get('/api/door-repo/health');
    expect(res.headers['cross-origin-opener-policy']).toBeUndefined();
  });

  it('answers an OPTIONS preflight with 204, an empty body, and the documented headers', async () => {
    const res = await request(app).options('/api/door-repo/health');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe(DOOR_REPO_ALLOWED_REQUEST_HEADERS.join(', '));
    expect(res.headers['access-control-max-age']).toBe('86400');
  });

  it('answers the preflight itself rather than falling through to the router, even for an unknown archive', async () => {
    const res = await request(app).options('/api/door-repo/archive/NOPE.LHA');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });
});
