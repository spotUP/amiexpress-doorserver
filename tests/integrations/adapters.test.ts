// tests/integrations/adapters.test.ts
//
// Contract tests: recorded live fixtures in ./fixtures (captured
// 2026-09-10, never hand-written), no live HTTP in test:ci. If an
// upstream shape changes, these fail and the fixture gets recaptured.
import { pouetAdapter } from '../../src/integrations/pouet';
import { demozooAdapter } from '../../src/integrations/demozoo';
import { asciiarenaAdapter } from '../../src/integrations/asciiarena';
import { cleanText } from '../../src/integrations/types';
import { fixtureFetcher, ctxOf } from './helpers';

describe('pouet adapter', () => {
  const fetchJson = fixtureFetcher({
    'search/prod/': 'pouet-search.json',
    'random=true': 'pouet-random.json',
    'latest-added': 'pouet-latest.json',
  });

  it('searches the id-keyed results object', async () => {
    const items = await pouetAdapter.search('logic', ctxOf(fetchJson));
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);
    expect(items[0].source).toBe('Pouët');
    expect(items[0].url).toMatch(/^https:\/\/www\.pouet\.net\/prod\.php\?which=\d+$/);
    expect(items[0].title.length).toBeGreaterThan(0);
  });

  it('returns one random prod (title varies per call - pin the shape)', async () => {
    const items = await pouetAdapter.random!(ctxOf(fetchJson));
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('Pouët');
    expect(items[0].title.length).toBeGreaterThan(0);
    expect(items[0].url).toMatch(/^https:\/\/www\.pouet\.net\/prod\.php\?which=\d+$/);
  });

  it('lists latest-added with rank ignored, prod kept', async () => {
    const items = await pouetAdapter.latest!(ctxOf(fetchJson));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.source === 'Pouët')).toBe(true);
  });

  it('reports healthy on a good front page', async () => {
    const h = await pouetAdapter.health(ctxOf(fetchJson));
    expect(h.ok).toBe(true);
  });

  it('reports down, never throws, on net failure', async () => {
    const dead = async (_: string): Promise<unknown> => { throw new Error('boom'); };
    const h = await pouetAdapter.health(ctxOf(dead));
    expect(h.ok).toBe(false);
    expect(h.detail).toBe('boom');
  });
});

describe('demozoo adapter', () => {
  const fetchJson = fixtureFetcher({
    'productions/?q=': 'demozoo-search.json',
    'productions/1/': 'demozoo-prod-1.json',
  });

  it('searches the DRF results array', async () => {
    const items = await demozooAdapter.search('logic', ctxOf(fetchJson));
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);
    expect(items[0].source).toBe('Demozoo');
    expect(items[0].url).toContain('demozoo.org');
  });

  it('ranks titled rows first and names untitled ones', async () => {
    const items = await demozooAdapter.search('logic', ctxOf(fetchJson));
    expect(items.every((i) => i.title !== '?' && i.title !== '???')).toBe(true);
    const untitled = items.find((i) => i.title.startsWith('[untitled'));
    expect(untitled?.title).toBe('[untitled Video]');
    expect(untitled?.detail).toContain('Cong');
  });

  it('a real title outranks question marks', async () => {
    const fake = ctxOf(async () => ({
      results: [
        { id: 1, title: '???', demozoo_url: 'https://demozoo.org/productions/1/', author_nicks: [] },
        { id: 2, title: 'Logic Bomb', demozoo_url: 'https://demozoo.org/productions/2/', author_nicks: [{ name: 'a' }] },
      ],
    }));
    const items = await demozooAdapter.search('logic', fake);
    expect(items[0].title).toBe('Logic Bomb');
    expect(items[1].title).toBe('[untitled production]');
  });

  it('pins prod 1 as the health check', async () => {
    const h = await demozooAdapter.health(ctxOf(fetchJson));
    expect(h.ok).toBe(true);
  });
});

describe('asciiarena adapter', () => {
  const fetchJson = fixtureFetcher({
    '/api/v1/search': 'asciiarena-search.json',
    '/api/v1/status': 'asciiarena-status.json',
  });

  it('reads the nested search envelope, not the flat list one', async () => {
    const items = await asciiarenaAdapter.search('spot', ctxOf(fetchJson));
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].source).toBe('AsciiArena');
    expect(items[0].url).toMatch(/^https:\/\/asciiarena\.se\//);
  });

  it('pins the service name as the health check', async () => {
    const h = await asciiarenaAdapter.health(ctxOf(fetchJson));
    expect(h.ok).toBe(true);
  });
});

describe('cleanText', () => {
  it('strips tags and collapses whitespace to one line', () => {
    expect(cleanText('<b>Hello</b>  world\nnewline')).toBe('Hello world newline');
    expect(cleanText('Fish &amp; Chips')).toBe('Fish & Chips');
    expect(cleanText(null)).toBe('');
  });
});
