// tests/integrations/phase3.test.ts
//
// Phase 3: Internet Archive, scene.org link checks, and the keyed
// adapters (ModArchive/TMDB/OMDb) dark-until-configured. IA fixtures
// are live-captured; keyed success fixtures are DOC-DERIVED (no keys
// existed at build time - each file says so and must be recaptured
// with a real key before trusting a parse failure).
import * as fs from 'fs';
import * as path from 'path';
import { archiveorgAdapter } from '../../src/integrations/archiveorg';
import { sceneorgAdapter, checkLink } from '../../src/integrations/sceneorg';
import { modarchiveAdapter } from '../../src/integrations/modarchive';
import { tmdbAdapter } from '../../src/integrations/tmdb';
import { omdbAdapter } from '../../src/integrations/omdb';
import { assertPublicUrl } from '../../src/integrations/fetch';
import { fixtureFetcher, ctxOf } from './helpers';

const fix = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');

describe('archive.org adapter', () => {
  const fetchJson = fixtureFetcher({ advancedsearch: 'ia-search.json' });

  it('searches with identifier/title/creator fields', async () => {
    const items = await archiveorgAdapter.search('chip music', ctxOf(fetchJson));
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);
    expect(items[0].source).toBe('Internet Archive');
    expect(items[0].url).toContain('archive.org/details/');
  });

  it('health pins numFound', async () => {
    await expect(archiveorgAdapter.health(ctxOf(fetchJson)).then((h) => h.ok)).resolves.toBe(true);
  });
});

describe('scene.org link checks', () => {
  it('ok on 2xx/3xx, broken otherwise, never throws', async () => {
    const two = { fetchJson: async () => ({}), getSecret: () => null, settings: {}, head: async () => 200 };
    const miss = { ...two, head: async () => 404 };
    const dead = { ...two, head: async () => { throw new Error('nope'); } };
    expect(await checkLink('https://files.scene.org/x', two)).toEqual({ url: 'https://files.scene.org/x', ok: true, status: 200 });
    expect((await checkLink('https://files.scene.org/x', miss)).ok).toBe(false);
    expect(await checkLink('https://files.scene.org/x', dead)).toEqual({ url: 'https://files.scene.org/x', ok: false, status: 0 });
  });

  it('has no search side (never in fan-out)', async () => {
    await expect(sceneorgAdapter.search('x', ctxOf(async () => ({})))).resolves.toEqual([]);
  });
});

describe('keyed adapters stay dark without a key', () => {
  const noKey = ctxOf(async () => { throw new Error('must not fetch without a key'); });

  it.each([
    ['modarchive', modarchiveAdapter],
    ['tmdb', tmdbAdapter],
    ['omdb', omdbAdapter],
  ])('%s searches nothing and reports missing key', async (_id, adapter) => {
    await expect(adapter.search('x', noKey)).resolves.toEqual([]);
    const h = await adapter.health(noKey);
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(/no api_key stored/);
  });
});

describe('keyed adapters parse (doc-derived fixtures)', () => {
  const withKey = (textMap: Record<string, string>) => ({
    fetchJson: async (url: string) => {
      for (const [match, file] of Object.entries(textMap)) {
        if (url.includes(match)) return JSON.parse(fix(file));
      }
      throw new Error(`no fixture for ${url}`);
    },
    fetchText: async (url: string) => {
      for (const [match, file] of Object.entries(textMap)) {
        if (url.includes(match)) return fix(file);
      }
      throw new Error(`no fixture for ${url}`);
    },
    getSecret: () => 'TEST-KEY',
    settings: {},
  });

  it('modarchive reads the xml-tools module rows', async () => {
    const items = await modarchiveAdapter.search('intro', withKey({ 'xml-tools.php': 'modarchive-search.xml' }));
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      source: 'ModArchive',
      title: 'intro.mod',
      detail: 'MOD',
      url: expect.stringContaining('modarchive.org'),
    });
  });

  it('tmdb reads results[]', async () => {
    const items = await tmdbAdapter.search('inception', withKey({ '/3/search/movie': 'tmdb-search.json' }));
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Inception');
    expect(items[0].url).toBe('https://www.themoviedb.org/movie/27205');
  });

  it('omdb reads Search[] and links IMDb', async () => {
    const items = await omdbAdapter.search('tron', withKey({ 'omdbapi.com': 'omdb-search.json' }));
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Tron');
    expect(items[0].url).toBe('https://www.imdb.com/title/tt0084827/');
  });

  it('omdb answers nothing on Response False', async () => {
    const ctx = withKey({});
    const empty = { ...ctx, fetchJson: async () => ({ Response: 'False', Error: 'Movie not found!' }) };
    await expect(omdbAdapter.search('zzz', empty)).resolves.toEqual([]);
  });
});

describe('assertPublicUrl SSRF guard', () => {
  it('rejects http, credentials, and loopback/private hosts without network', async () => {
    await expect(assertPublicUrl('http://example.com/x')).rejects.toThrow('https only');
    await expect(assertPublicUrl('https://user:pass@example.com/')).rejects.toThrow('credentials');
    await expect(assertPublicUrl('https://127.0.0.1/x')).rejects.toThrow('private host');
    await expect(assertPublicUrl('https://10.0.0.1/x')).rejects.toThrow('private host');
    await expect(assertPublicUrl('not a url')).rejects.toThrow('bad url');
  });
});
