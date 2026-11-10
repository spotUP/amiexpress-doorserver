// tests/integrations/phase4.test.ts
//
// Phase 4: demoparty.net feed, 16colors artpacks, scene-radio probe.
// demoparty + artpacks fixtures are live-captured (artpacks tree as a
// marked 25-entry excerpt - the full 1.4 MB listing is verified by live
// smoke, not checked in); radio is doc-derived Icecast shape.
import * as fs from 'fs';
import * as path from 'path';
import { demopartyAdapter } from '../../src/integrations/demoparty';
import { artpacksAdapter, resetArtpacksCache, packPaths } from '../../src/integrations/artpacks';
import { radioAdapter } from '../../src/integrations/radio';
import { ResponseTooLarge } from '../../src/integrations/fetch';
import { ctxOf } from './helpers';

const fix = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');

function textCtx(file: string, settings: Record<string, unknown> = {}) {
  return {
    ...ctxOf(async () => { throw new Error('must not JSON-fetch'); }),
    fetchText: async () => fix(file),
    settings,
  };
}

beforeEach(() => { resetArtpacksCache(); });

describe('demoparty.net adapter', () => {
  it('finds a party by name with its date, country and site url', async () => {
    const items = await demopartyAdapter.search('mysdata', textCtx('demoparty-feed.xml'));
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].source).toBe('demoparty.net');
    expect(items[0].title).toBe('Mysdata 2026');
    expect(items[0].detail).toContain('September 2026');
    expect(items[0].detail).toContain('SE');
    expect(items[0].url).toContain('mysdata.org');
    expect(items[0].url).not.toContain('mtm_');
  });

  it('latest returns the next parties', async () => {
    const items = await demopartyAdapter.latest!(textCtx('demoparty-feed.xml'));
    expect(items).toHaveLength(5);
  });

  it('health pins a non-empty feed', async () => {
    await expect(demopartyAdapter.health(textCtx('demoparty-feed.xml')).then((h) => h.ok)).resolves.toBe(true);
  });
});

describe('artpacks adapter', () => {
  it('searches pack names and links raw zips', async () => {
    const items = await artpacksAdapter.search('acid', textCtx('artpacks-tree.json'));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.source === 'artpacks')).toBe(true);
    expect(items[0].url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/sixteencolors\//);
    expect(items[0].url).toMatch(/\.zip$/);
  });

  it('fetches the 1.4 MB tree once a day, not per query', async () => {
    let calls = 0;
    const ctx = { ...textCtx('artpacks-tree.json'), fetchText: async () => { calls++; return fix('artpacks-tree.json'); } };
    await artpacksAdapter.search('acid', ctx);
    await artpacksAdapter.search('1990', ctx);
    expect(calls).toBe(1);
  });

  it('retries with the 4 MB fetcher when the shared 1 MB cap hits', async () => {
    resetArtpacksCache();
    const small = async () => { throw new ResponseTooLarge(1024); };
    const big = async () => fix('artpacks-tree.json');
    const paths = await packPaths({ ...ctxOf(small), fetchText: small }, big);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths[0]).toMatch(/\.zip$/);
  });
});

describe('radio adapter', () => {
  const station = {
    ...ctxOf(async (url: string) => {
      if (url.includes('status-json')) return JSON.parse(fix('radio-status.json'));
      throw new Error(`no fixture for ${url}`);
    }),
    settings: { stationUrl: 'https://radio.example.org/status-json.xsl' },
  };

  it('answers what is playing', async () => {
    const items = await radioAdapter.search('what is playing', station);
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe('Scene radio');
    expect(items[0].title).toBe('Romeo Knight - Chip Tune');
    expect(items[0].detail).toContain('3 listening');
  });

  it('stays dark with no station configured', async () => {
    await expect(radioAdapter.search('x', ctxOf(async () => ({})))).resolves.toEqual([]);
    const h = await radioAdapter.health(ctxOf(async () => ({})));
    expect(h.ok).toBe(false);
    expect(h.detail).toBe('no stationUrl configured');
  });
});
