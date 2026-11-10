/**
 * /answer fan-out: one query in, attributed hits from every enabled
 * keyless source, degraded honesty when a source is down.
 *
 * Cache-first (merged answer, 120s TTL) so a chat burst costs one live
 * round; when every source fails and a stale merged answer exists, it
 * is served with stale:true rather than an empty shrug.
 */
import type Database from 'better-sqlite3';
import type { Adapter, AdapterContext, AnswerItem, FetchJson, FetchText, HeadStatus } from './types';
import { createFetchText, createHeadStatus } from './fetch';
import { pouetAdapter } from './pouet';
import { demozooAdapter } from './demozoo';
import { asciiarenaAdapter } from './asciiarena';
import { archiveorgAdapter } from './archiveorg';
import { sceneorgAdapter } from './sceneorg';
import { modarchiveAdapter } from './modarchive';
import { tmdbAdapter } from './tmdb';
import { omdbAdapter } from './omdb';
import { demopartyAdapter } from './demoparty';
import { artpacksAdapter } from './artpacks';
import { radioAdapter } from './radio';
import { loadCustomAdapters } from './custom';
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
export const ADAPTERS: Adapter[] = [
  pouetAdapter, demozooAdapter, asciiarenaAdapter, archiveorgAdapter,
  modarchiveAdapter, tmdbAdapter, omdbAdapter,
  demopartyAdapter, artpacksAdapter, radioAdapter,
];

/** Everything /status reports: the fan-out plus sources with no search
 *  side (scene.org link checks). */
export const STATUS_ADAPTERS: Adapter[] = [...ADAPTERS, sceneorgAdapter as Adapter];

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

/** Round-robin across sources, capped: every contributing source stays
 *  visible instead of the tail being sliced off (2026-09-10 - a global
 *  slice(0,12) silently dropped Internet Archive behind Pouet+Demozoo). */
export const ANSWER_MAX_RESULTS = 12;
export function interleave(lists: AnswerItem[][], max = ANSWER_MAX_RESULTS): AnswerItem[] {
  const out: AnswerItem[] = [];
  for (let i = 0; out.length < max; i++) {
    let took = false;
    for (const list of lists) {
      if (i < list.length && out.length < max) {
        out.push(list[i]);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}

export async function answer(
  db: Database.Database,
  fetchJson: FetchJson,
  query: string,
  mode: AnswerMode = 'search',
  opts?: { fetchText?: FetchText; head?: HeadStatus }
): Promise<Answer> {
  const q = query.trim().slice(0, 120);
  const cacheKey = `answer:${mode}:${q.toLowerCase()}`;
  const hit = getCache(db, cacheKey);
  if (hit) return { ...(JSON.parse(hit.body) as Answer), stale: false };

  const enabled = ADAPTERS.filter((a) => isEnabled(db, a));
  // Custom sources are data, not code: enabled + valid ones join the
  // same fan-out with the same attribution. Invalid/disabled stay dark.
  const customs = loadCustomAdapters(db);
  enabled.push(...customs);
  const sources: SourceResult[] = [];
  const perSource: AnswerItem[][] = [];

  await Promise.all(
    enabled.map(async (a) => {
      const t0 = Date.now();
      const ctx: AdapterContext = {
        fetchJson,
        fetchText: opts?.fetchText ?? createFetchText(),
        head: opts?.head ?? createHeadStatus(),
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
        perSource.push(items.slice(0, 5));
        sources.push({ id: a.id, name: a.name, ok: true, ms: Date.now() - t0 });
      } catch (e) {
        sources.push({
          id: a.id, name: a.name, ok: false, ms: Date.now() - t0, detail: (e as Error).message,
        });
      }
    })
  );

  const merged: Answer = { query: q, mode, results: interleave(perSource), sources, stale: false };
  // Empty now but non-empty before: serve the stale merged answer marked
  // stale rather than an empty shrug (2026-09-10 - an all-failed check
  // alone misfires when a benign source like unconfigured radio reports
  // ok with zero items).
  if (merged.results.length === 0) {
    const stale = getStaleCache(db, cacheKey);
    if (stale) {
      const staleAnswer = JSON.parse(stale.body) as Answer;
      if (staleAnswer.results.length > 0) return { ...staleAnswer, stale: true };
    }
  } else {
    // A custom source's own TTL tightens the merged row it rides in.
    const customTtls = customs
      .map((a) => a.ttlSeconds)
      .filter((t): t is number => typeof t === 'number');
    const ttl = customTtls.length ? Math.min(ANSWER_CACHE_TTL_SECONDS, ...customTtls) : ANSWER_CACHE_TTL_SECONDS;
    setCache(db, cacheKey, JSON.stringify(merged), ttl);
  }
  return merged;
}
