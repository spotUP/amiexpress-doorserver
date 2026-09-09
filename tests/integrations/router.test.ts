// tests/integrations/router.test.ts
//
// The public surface: /answer and /status through supertest, sources
// faked with the recorded fixtures. Proves the HTTP contract without
// live HTTP.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import { openDb, applySchema } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import { createIntegrationsRouter } from '../../src/integrations/router';
import { fixtureFetcher, ANSWER_FIXTURES } from './helpers';

const fixtureFile = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');

function tmpApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-rtr-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  const setup = openDb({ dbPath } as never);
  applySchema(setup);
  runMigrations(setup);
  setup.close();
  const app = express();
  app.use('/api/integrations/v1', createIntegrationsRouter(
    { dbPath } as never,
    {
      fetchJson: fixtureFetcher(ANSWER_FIXTURES),
      fetchText: async (url: string) => {
        if (url.includes('demoparty.net')) return fixtureFile('demoparty-feed.xml');
        if (url.includes('sixteencolors')) return fixtureFile('artpacks-tree.json');
        throw new Error(`no fixture for ${url}`);
      },
      head: async () => 200,
    }));
  return { dir, app };
}

describe('integrations router', () => {
  it('answers with attributed hits from every source', async () => {
    const { dir, app } = tmpApp();
    const res = await request(app).get('/api/integrations/v1/answer?q=logic');
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('logic');
    expect(res.body.results.length).toBeGreaterThanOrEqual(4);
    expect(new Set(res.body.results.map((r: { source: string }) => r.source)))
      .toEqual(new Set(['Pouët', 'Demozoo', 'AsciiArena', 'Internet Archive']));
    expect(res.body.sources.filter((s: { ok: boolean }) => s.ok).length).toBeGreaterThanOrEqual(4);
    expect(res.body.stale).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('requires q', async () => {
    const { dir, app } = tmpApp();
    const res = await request(app).get('/api/integrations/v1/answer');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('q is required');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to search on an unknown mode', async () => {
    const { dir, app } = tmpApp();
    const res = await request(app).get('/api/integrations/v1/answer?q=logic&mode=bogus');
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('search');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports per-source health for the panel', async () => {
    const { dir, app } = tmpApp();
    const res = await request(app).get('/api/integrations/v1/status');
    expect(res.status).toBe(200);
    // 10 adapters + scene.org link checks.
    expect(res.body.sources).toHaveLength(11);
    // Keyless sources are healthy on fixtures; keyed ones report exactly
    // why they are dark (no secret stored) instead of pretending; radio
    // reports its missing station the same honest way.
    for (const s of res.body.sources as Array<{ id: string; ok: boolean; needsKey: boolean; detail?: string }>) {
      if (s.needsKey) {
        expect(s.ok).toBe(false);
        expect(s.detail).toMatch(/no api_key stored/);
      } else if (s.id === 'radio') {
        expect(s.ok).toBe(false);
        expect(s.detail).toBe('no stationUrl configured');
      } else {
        expect(s.ok).toBe(true);
      }
    }
    expect(res.body.sources[0]).toEqual(expect.objectContaining({
      id: expect.any(String), name: expect.any(String),
      needsKey: expect.any(Boolean), latencyMs: expect.any(Number),
    }));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
