/**
 * /answer fan-out: one query in, attributed hits from every enabled
 * keyless source, degraded honesty when a source is down.
 *
 * Cache-first (merged answer, 120s TTL) so a chat burst costs one live
 * round; when every source fails and a stale merged answer exists, it
 * is served with stale:true rather than an empty shrug.
 */
import type Database from 'better-sqlite3';
import type { Adapter, AdapterContext, AnswerItem, FetchJson } from './types';
import { pouetAdapter } from './pouet';
import { demozooAdapter } from './demozoo';
import { asciiarenaAdapter } from './asciiarena';
import { getConfig, getSecretForAdapter, getCache, getStaleCache, setCache } from './store';

export const ANSWER_CACHE_TTL_SECONDS = 120;
export const ADAPTER_TIMEOUT_MS = 8000;
export type AnswerMode = 'search' | 'random' | 'latest';

export interface SourceResult {
  id: string;
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface Answer {
  query: string;
  mode: AnswerMode;
  results: AnswerItem[];
  sources: SourceResult[];
  stale: boolean;
}

/** Adapter registry. Keyed adapters join here in Phase 3; they stay
 *  dark until configured (isEnabled). */
export const ADAPTERS: Adapter[] = [pouetAdapter, demozooAdapter, asciiarenaAdapter];

function isEnabled(db: Database.Database, a: Adapter): boolean {
  const row = getConfig(db, a.id);
  if (row) return row.enabled;
  // No row yet: keyless sources are on, keyed ones wait for a secret.
  if (!a.needsKey) return true;
  return getSecretForAdapter(db, a.id, 'api_key') !== null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer!)), timeout]) as Promise<T>;
}

export async function answer(
  db: Database.Database,
  fetchJson: FetchJson,
  query: string,
  mode: AnswerMode = 'search'
): Promise<Answer> {
  const q = query.trim().slice(0, 120);
  const cacheKey = `answer:${mode}:${q.toLowerCase()}`;
  const hit = getCache(db, cacheKey);
  if (hit) return { ...(JSON.parse(hit.body) as Answer), stale: false };

  const enabled = ADAPTERS.filter((a) => isEnabled(db, a));
  const sources: SourceResult[] = [];
  const results: AnswerItem[] = [];

  await Promise.all(
    enabled.map(async (a) => {
      const t0 = Date.now();
      const ctx: AdapterContext = {
        fetchJson,
        getSecret: (keyName) => getSecretForAdapter(db, a.id, keyName),
        settings: getConfig(db, a.id)?.settings ?? {},
      };
      try {
        const fn =
          mode === 'random' ? a.random ?? null : mode === 'latest' ? a.latest ?? null : a.search;
        if (!fn) {
          sources.push({ id: a.id, name: a.name, ok: true, ms: Date.now() - t0, detail: `no ${mode}` });
          return;
        }
        const items = await withTimeout(
          mode === 'search' ? (fn as (q: string, c: AdapterContext) => Promise<AnswerItem[]>)(q, ctx) : (fn as (c: AdapterContext) => Promise<AnswerItem[]>)(ctx),
          ADAPTER_TIMEOUT_MS,
          a.id
        );
        results.push(...items);
        sources.push({ id: a.id, name: a.name, ok: true, ms: Date.now() - t0 });
      } catch (e) {
        sources.push({
          id: a.id, name: a.name, ok: false, ms: Date.now() - t0, detail: (e as Error).message,
        });
      }
    })
  );

  const merged: Answer = { query: q, mode, results: results.slice(0, 12), sources, stale: false };
  const allFailed = sources.length > 0 && sources.every((s) => !s.ok);
  if (allFailed) {
    const stale = getStaleCache(db, cacheKey);
    if (stale) return { ...(JSON.parse(stale.body) as Answer), stale: true };
  } else {
    setCache(db, cacheKey, JSON.stringify(merged), ANSWER_CACHE_TTL_SECONDS);
  }
  return merged;
}
