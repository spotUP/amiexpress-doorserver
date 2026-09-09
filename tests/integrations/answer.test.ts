// tests/integrations/answer.test.ts
//
// Fan-out, cache-first, and degrade behavior with faked sources.
// No fixtures here: the adapters' own parsing is pinned in
// adapters.test.ts; this file pins the orchestration.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import { answer, ADAPTERS } from '../../src/integrations/answer';
import { setConfig } from '../../src/integrations/store';
import type { FetchJson } from '../../src/integrations/types';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-ans-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  const db = openDb({ dbPath } as never);
  applySchema(db);
  runMigrations(db);
  return { dir, db };
}

// Routes every adapter URL to canned JSON shaped like the real thing.
function canned(responder: (url: string) => unknown): FetchJson {
  return async (url: string) => responder(url);
}

const OK_FETCH: FetchJson = canned((url) => {
  if (url.includes('pouet.net')) {
    if (url.includes('search')) {
      return { success: true, results: { 1: { id: '1', name: 'Pouet Hit', type: 'demo', addedUser: { nickname: 'someone' } } } };
    }
    return { success: true, prod: { id: '2', name: 'Pouet Random', type: 'intro' } };
  }
  if (url.includes('demozoo.org')) {
    return { count: 1, results: [{ id: 3, title: 'Demozoo Hit', demozoo_url: 'https://demozoo.org/productions/3/', author_nicks: [{ name: 'a' }] }] };
  }
  if (url.includes('asciiarena.se')) {
    if (url.includes('search')) {
      return { data: { logos: [{ id: 4, label: 'Arena Hit', filename: 'x.txt', html_url: '/release/x.txt#logo-1' }], collys: [] } };
    }
    return { data: { service: 'asciiarena' } };
  }
  throw new Error(`unexpected ${url}`);
});

describe('/answer fan-out', () => {
  it('merges attributed hits from every enabled source', async () => {
    const { dir, db } = tmpDb();
    const out = await answer(db, OK_FETCH, 'logic');
    expect(out.results.length).toBeGreaterThanOrEqual(3);
    expect(new Set(out.results.map((r) => r.source))).toEqual(new Set(['Pouët', 'Demozoo', 'AsciiArena']));
    expect(out.sources.filter((s) => s.ok)).toHaveLength(ADAPTERS.length);
    expect(out.stale).toBe(false);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the second identical query from cache without fetching', async () => {
    const { dir, db } = tmpDb();
    await answer(db, OK_FETCH, 'cached-q');
    let calls = 0;
    const counting: FetchJson = async (url) => { calls++; return OK_FETCH(url); };
    const out = await answer(db, counting, 'cached-q');
    expect(calls).toBe(0);
    expect(out.results.length).toBeGreaterThan(0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips a disabled source and says which sources answered', async () => {
    const { dir, db } = tmpDb();
    setConfig(db, 'pouet', { enabled: false });
    const out = await answer(db, OK_FETCH, 'logic');
    expect(out.results.every((r) => r.source !== 'Pouët')).toBe(true);
    expect(out.sources.find((s) => s.id === 'pouet')).toBeUndefined();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('degrades per-source: one down, the rest still answer', async () => {
    const { dir, db } = tmpDb();
    const flaky: FetchJson = async (url) => {
      if (url.includes('pouet.net')) throw new Error('pouet down');
      return OK_FETCH(url);
    };
    const out = await answer(db, flaky, 'logic');
    expect(out.results.length).toBeGreaterThan(0);
    const pouet = out.sources.find((s) => s.id === 'pouet');
    expect(pouet?.ok).toBe(false);
    expect(pouet?.detail).toContain('pouet down');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves stale cache marked stale when everything fails', async () => {
    const { dir, db } = tmpDb();
    await answer(db, OK_FETCH, 'doomed');
    const dead: FetchJson = async () => { throw new Error('net gone'); };
    // Bust the fresh cache by disabling... no: expire it by writing the
    // merged row old. Simplest honest expiry: answer again after the TTL.
    const { getStaleCache } = await import('../../src/integrations/store');
    expect(getStaleCache(db, 'answer:search:doomed')).toBeTruthy();
    // Fresh cache still holds, so force the all-failed path by clearing it:
    db.prepare("DELETE FROM integration_cache WHERE cache_key = 'answer:search:doomed'").run();
    // Re-seed as stale: cache the merged answer, then age it past TTL.
    const first = await answer(db, OK_FETCH, 'doomed');
    expect(first.stale).toBe(false);
    db.prepare("UPDATE integration_cache SET fetched_at = fetched_at - 10000 WHERE cache_key = 'answer:search:doomed'").run();
    const out = await answer(db, dead, 'doomed');
    expect(out.stale).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('random mode uses only sources that offer it', async () => {
    const { dir, db } = tmpDb();
    const out = await answer(db, OK_FETCH, 'anything', 'random');
    expect(out.results.every((r) => r.source === 'Pouët')).toBe(true);
    expect(out.sources.find((s) => s.id === 'demozoo')?.detail).toBe('no random');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
