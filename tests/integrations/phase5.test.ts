// tests/integrations/phase5.test.ts
//
// Phase 5: custom JSON-REST sources. Validation is pure and pinned;
// mapping runs against a canned source (no live HTTP); fan-out
// inclusion, TTL tightening, and dark-on-invalid are pinned through
// answer() with a temp DB.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import {
  validateCustomSource, getPath, buildCustomAdapter, customSourceId,
  loadCustomAdapters, type CustomSourceConfig,
} from '../../src/integrations/custom';
import { setConfig } from '../../src/integrations/store';
import { answer } from '../../src/integrations/answer';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-cus-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  const db = openDb({ dbPath } as never);
  applySchema(db);
  runMigrations(db);
  return { dir, db };
}

const GOOD: CustomSourceConfig = {
  name: 'films',
  displayName: 'Film DB',
  baseUrl: 'https://films.example.org',
  authMode: 'none',
  endpoints: {
    search: {
      path: '/search',
      params: { q: '{q}' },
      items: 'results',
      title: 'title',
      id: 'id',
      detail: 'overview',
      url: 'link',
    },
  },
  ttlSeconds: 300,
};

const CANNED = {
  results: [
    { id: 1, title: 'Chip Story', overview: 'A film about chips.', link: '/m/1' },
    { id: 2, title: 'No Link Film', overview: 'x' },
  ],
};

function cannedCtx() {
  return {
    fetchJson: async () => ({}),
    fetchText: async () => JSON.stringify(CANNED),
    getSecret: () => null,
    settings: {},
  };
}

describe('validateCustomSource', () => {
  it('accepts a good config', () => {
    expect(validateCustomSource(GOOD)).toEqual([]);
  });

  it('rejects names, urls, auth gaps, bad paths and bad TTLs', () => {
    expect(validateCustomSource({ ...GOOD, name: 'Has Space!' })[0]).toMatch(/name/);
    expect(validateCustomSource({ ...GOOD, name: 'pouet' })[0]).toMatch(/collides/);
    expect(validateCustomSource({ ...GOOD, baseUrl: 'http://x' })[0]).toMatch(/https/);
    expect(validateCustomSource({ ...GOOD, authMode: 'query' })[0]).toMatch(/queryParam/);
    expect(validateCustomSource({ ...GOOD, authMode: 'header' })[0]).toMatch(/headerName/);
    expect(validateCustomSource({
      ...GOOD, endpoints: { search: { ...GOOD.endpoints.search, path: 'no-slash' } },
    })[0]).toMatch(/must start with \//);
    expect(validateCustomSource({
      ...GOOD, endpoints: { search: { ...GOOD.endpoints.search, title: 'a;b' } },
    })[0]).toMatch(/dot-path/);
    expect(validateCustomSource({ ...GOOD, ttlSeconds: 5 })[0]).toMatch(/ttlSeconds/);
    expect(validateCustomSource(null)[0]).toMatch(/must be an object/);
  });
});

describe('getPath', () => {
  it('reads dotted paths with indices, undefined on anything missing', () => {
    const root = { a: { b: [{ c: 1 }] } };
    expect(getPath(root, 'a.b.0.c')).toBe(1);
    expect(getPath(root, 'a.b.5.c')).toBeUndefined();
    expect(getPath(root, 'a.x.c')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });
});

describe('custom adapter mapping', () => {
  it('maps rows, resolves relative urls, skips untitled rows', async () => {
    const adapter = buildCustomAdapter('Film DB', GOOD);
    expect(adapter.id).toBe(customSourceId('films'));
    expect(adapter.needsKey).toBe(false);
    const items = await adapter.search('chip', cannedCtx());
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      source: 'Film DB',
      title: 'Chip Story',
      detail: 'A film about chips.',
      url: 'https://films.example.org/m/1',
    });
    // No link and no id: falls back to the base, never empty.
    expect(items[1].url).toBe('https://films.example.org');
  });

  it('stays dark without its secret', async () => {
    const keyed = buildCustomAdapter('K', { ...GOOD, name: 'k', authMode: 'bearer' });
    expect(keyed.needsKey).toBe(true);
    await expect(keyed.search('x', cannedCtx())).resolves.toEqual([]);
  });

  it('sends the secret the configured way', async () => {
    let seen = '';
    const ctx = {
      ...cannedCtx(),
      fetchText: async (url: string) => { seen = url; return JSON.stringify(CANNED); },
      getSecret: () => 'SEKRET',
    };
    const adapter = buildCustomAdapter('K', { ...GOOD, name: 'k2', authMode: 'query', queryParam: 'key' });
    await adapter.search('chip', ctx);
    expect(seen).toContain('key=SEKRET');
  });
});

describe('custom sources in fan-out', () => {
  const quietJson = async () => ({ response: { docs: [] } });
  const quietText = async () => JSON.stringify({ results: [] });

  it('an enabled valid source answers with attribution', async () => {
    const { dir, db } = tmpDb();
    setConfig(db, customSourceId('films'), { settings: GOOD as unknown as Record<string, unknown> });
    const out = await answer(db, quietJson, 'chip', 'search', { fetchText: cannedCtx().fetchText });
    expect(out.results.map((r) => r.source)).toContain('Film DB');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an invalid source stays dark', async () => {
    const { dir, db } = tmpDb();
    setConfig(db, customSourceId('films'), {
      settings: { ...GOOD, baseUrl: 'http://insecure', name: 'films' } as unknown as Record<string, unknown>,
    });
    const out = await answer(db, quietJson, 'chip', 'search', { fetchText: quietText });
    expect(out.results.map((r) => r.source)).not.toContain('Film DB');
    expect(out.sources.find((s) => s.id === customSourceId('films'))).toBeUndefined();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a disabled source stays dark', async () => {
    const { dir, db } = tmpDb();
    setConfig(db, customSourceId('films'), {
      enabled: false,
      settings: GOOD as unknown as Record<string, unknown>,
    });
    const out = await answer(db, quietJson, 'chip', 'search', { fetchText: quietText });
    expect(out.sources.find((s) => s.id === customSourceId('films'))).toBeUndefined();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the custom TTL tightens the merged cache row', async () => {
    const { dir, db } = tmpDb();
    setConfig(db, customSourceId('films'), {
      settings: { ...GOOD, ttlSeconds: 60 } as unknown as Record<string, unknown>,
    });
    await answer(db, quietJson, 'chip', 'search', { fetchText: cannedCtx().fetchText });
    const row = db.prepare('SELECT ttl_seconds FROM integration_cache').get() as { ttl_seconds: number };
    expect(row.ttl_seconds).toBe(60);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loadCustomAdapters never throws on junk rows', async () => {
    const { dir, db } = tmpDb();
    setConfig(db, customSourceId('junk'), { settings: { nonsense: true } as unknown as Record<string, unknown> });
    expect(loadCustomAdapters(db)).toEqual([]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
