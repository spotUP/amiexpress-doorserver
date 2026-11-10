/**
 * Custom (user-defined) JSON-REST integrations.
 *
 * A curator adds a source entirely through stored config - no deploy.
 * Constraints keep it safe and small (see the plan):
 * GET only, https only, 10s timeout, 1 MB cap, redirects followed only
 * while every hop stays https on a public host (assertPublicUrl), auth
 * via stored secret (never in a read response), response mapping by
 * dot-paths (no scripting - anything fancier graduates to a real
 * adapter). Stored as integration_config rows with source
 * `custom:<name>`; listed in /answer fan-out like a built-in.
 */
import type { Adapter, AdapterContext, AnswerItem, FetchText } from './types';
import { cleanText } from './types';
import { fetchRaw, assertPublicUrl } from './fetch';
import type Database from 'better-sqlite3';
import { listConfigs } from './store';

export const CUSTOM_PREFIX = 'custom:';
const MAX_REDIRECTS = 3;

export type CustomAuthMode = 'none' | 'query' | 'bearer' | 'header';

export interface CustomEndpoint {
  /** Path under baseUrl; may contain {q} for the search term. */
  path: string;
  /** Static query params; values may contain {q}. */
  params?: Record<string, string>;
  /** Dot-path to the item array. */
  items: string;
  title: string;
  id?: string;
  detail?: string;
  url?: string;
}

export interface CustomSourceConfig {
  name: string;
  /** Shown in the panel and in attribution (default: name). */
  displayName?: string;
  baseUrl: string;
  authMode: CustomAuthMode;
  /** Secret name in integration_secrets (default api_key). */
  keyName?: string;
  /** For authMode query/header. */
  queryParam?: string;
  headerName?: string;
  endpoints: { search: CustomEndpoint; random?: CustomEndpoint };
  ttlSeconds?: number;
  healthQuery?: string;
}

const NAME_RE = /^[a-z0-9-]{1,32}$/;
const PATH_SEG_RE = /^[A-Za-z0-9_]+$/;
export const BUILTIN_IDS = [
  'pouet', 'demozoo', 'asciiarena', 'archiveorg', 'sceneorg',
  'modarchive', 'tmdb', 'omdb', 'demoparty', 'artpacks', 'radio',
];

/** Config errors as strings; empty means valid. Pure, panel-tested. */
export function validateCustomSource(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') return ['config must be an object'];
  const c = raw as Record<string, unknown>;

  if (typeof c.name !== 'string' || !NAME_RE.test(c.name)) {
    errors.push('name must be 1-32 chars of a-z, 0-9, -');
  } else if (BUILTIN_IDS.includes(c.name)) {
    errors.push(`name collides with a built-in source (${c.name})`);
  }
  if (typeof c.baseUrl !== 'string') {
    errors.push('baseUrl is required');
  } else {
    try {
      const u = new URL(c.baseUrl);
      if (u.protocol !== 'https:') errors.push('baseUrl must be https');
      if (u.username || u.password) errors.push('baseUrl must not carry credentials');
    } catch {
      errors.push('baseUrl is not a URL');
    }
  }
  const authMode = c.authMode as CustomAuthMode;
  if (!['none', 'query', 'bearer', 'header'].includes(authMode)) {
    errors.push('authMode must be none, query, bearer or header');
  }
  if (authMode === 'query' && typeof c.queryParam !== 'string') {
    errors.push('query mode needs queryParam');
  }
  if (authMode === 'header' && typeof c.headerName !== 'string') {
    errors.push('header mode needs headerName');
  }
  if (typeof c.keyName !== 'undefined' && typeof c.keyName !== 'string') {
    errors.push('keyName must be a string');
  }
  const eps = c.endpoints as Record<string, CustomEndpoint> | undefined;
  if (!eps || typeof eps !== 'object') {
    errors.push('endpoints.search is required');
  } else {
    for (const slot of ['search', 'random'] as const) {
      const ep = eps[slot];
      if (slot === 'search' && !ep) {
        errors.push('endpoints.search is required');
        continue;
      }
      if (!ep) continue;
      if (typeof ep.path !== 'string' || !ep.path.startsWith('/')) {
        errors.push(`endpoints.${slot}.path must start with /`);
      }
      for (const field of ['items', 'title', 'id', 'detail', 'url'] as const) {
        const v = ep[field];
        if (typeof v === 'undefined') continue;
        if (typeof v !== 'string' || v.length === 0 || !v.split('.').every((s) => PATH_SEG_RE.test(s))) {
          errors.push(`endpoints.${slot}.${field} must be a dot-path of names/indices`);
        }
      }
      if (typeof ep.items !== 'string' || ep.items.length === 0) {
        errors.push(`endpoints.${slot}.items is required`);
      }
      if (typeof ep.title !== 'string' || ep.title.length === 0) {
        errors.push(`endpoints.${slot}.title is required`);
      }
    }
  }
  if (typeof c.ttlSeconds !== 'undefined') {
    if (typeof c.ttlSeconds !== 'number' || c.ttlSeconds < 60 || c.ttlSeconds > 86400) {
      errors.push('ttlSeconds must be 60..86400');
    }
  }
  return errors;
}

/** Dot-path reader: "results.0.title". Missing anything -> undefined. */
export function getPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur === 'undefined') return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** GET with validated redirect-following. Every hop re-passes the SSRF
 *  guard; anything else (http, private host, >3 hops) throws. */
export async function getValidated(
  startUrl: string,
  fetchText: FetchText | undefined,
  headers: Record<string, string>
): Promise<string> {
  // Injected fetchers (tests) bypass hop validation - they never touch
  // the network, so there is nothing to guard.
  if (fetchText) return fetchText(startUrl);
  let url = startUrl;
  await assertPublicUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchRaw(url, { headers });
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop === MAX_REDIRECTS) throw new Error('too many redirects');
      url = new URL(res.location, url).toString();
      await assertPublicUrl(url);
      continue;
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return res.body.toString('utf-8');
  }
  throw new Error('too many redirects');
}

function buildUrl(cfg: CustomSourceConfig, ep: CustomEndpoint, q: string, secret: string | null): { url: string; viaHeader: Record<string, string> } {
  const path = ep.path.replaceAll('{q}', encodeURIComponent(q));
  const url = new URL(path.startsWith('http') ? path : cfg.baseUrl.replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(ep.params ?? {})) {
    url.searchParams.set(k, v.replaceAll('{q}', q));
  }
  const viaHeader: Record<string, string> = {};
  if (cfg.authMode === 'query' && secret) {
    url.searchParams.set(cfg.queryParam ?? 'api_key', secret);
  } else if (cfg.authMode === 'bearer' && secret) {
    viaHeader.Authorization = `Bearer ${secret}`;
  } else if (cfg.authMode === 'header' && secret) {
    viaHeader[cfg.headerName ?? 'X-API-Key'] = secret;
  }
  return { url: url.toString(), viaHeader };
}

function toItems(sourceName: string, ep: CustomEndpoint, json: unknown, baseUrl: string): AnswerItem[] {
  const raw = getPath(json, ep.items);
  const list = Array.isArray(raw) ? raw : [];
  const out: AnswerItem[] = [];
  for (const row of list.slice(0, 5)) {
    const title = getPath(row, ep.title);
    if (typeof title !== 'string' && typeof title !== 'number') continue;
    const id = getPath(row, ep.id ?? '');
    const detail = ep.detail ? getPath(row, ep.detail) : undefined;
    let link = ep.url ? getPath(row, ep.url) : undefined;
    let url = typeof link === 'string' && link ? link : baseUrl;
    if (typeof link === 'string' && link && !link.startsWith('http')) {
      try {
        url = new URL(link, baseUrl).toString();
      } catch {
        url = baseUrl;
      }
    } else if (typeof id !== 'undefined') {
      url = baseUrl;
    }
    out.push({
      source: sourceName,
      title: cleanText(title, 120),
      detail: cleanText(typeof detail === 'string' || typeof detail === 'number' ? detail : '', 200),
      url,
    });
  }
  return out;
}

export function customSourceId(name: string): string {
  return `${CUSTOM_PREFIX}${name}`;
}

export function buildCustomAdapter(displayName: string, cfg: CustomSourceConfig): Adapter {
  const run = async (
    ep: CustomEndpoint | undefined,
    q: string,
    ctx: AdapterContext
  ): Promise<AnswerItem[]> => {
    if (!ep) return [];
    const secret =
      cfg.authMode === 'none' ? null : ctx.getSecret(cfg.keyName ?? 'api_key');
    if (cfg.authMode !== 'none' && !secret) return [];
    const { url, viaHeader } = buildUrl(cfg, ep, q, secret);
    const body = await getValidated(url, ctx.fetchText, viaHeader);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error('source did not return JSON');
    }
    return toItems(displayName, ep, json, cfg.baseUrl);
  };

  return {
    id: customSourceId(cfg.name),
    name: displayName,
    needsKey: cfg.authMode !== 'none',
    ttlSeconds: cfg.ttlSeconds,
    search: (q, ctx) => run(cfg.endpoints.search, q, ctx),
    random: cfg.endpoints.random ? (ctx) => run(cfg.endpoints.random as CustomEndpoint, '', ctx) : undefined,
    health: async (ctx) => {
      const t0 = Date.now();
      try {
        const probe = String(ctx.settings.healthQuery ?? cfg.healthQuery ?? 'test');
        await run(cfg.endpoints.search, probe, ctx);
        return { ok: true, latencyMs: Date.now() - t0 };
      } catch (e) {
        return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
      }
    },
  };
}

/** Raw JSON beside the mapped preview for the panel's Test button. */
export async function previewCustomSource(
  cfg: CustomSourceConfig,
  q: string,
  ctx: AdapterContext
): Promise<{ raw: unknown; mapped: AnswerItem[] }> {
  const secret = cfg.authMode === 'none' ? null : ctx.getSecret(cfg.keyName ?? 'api_key');
  const { url, viaHeader } = buildUrl(cfg, cfg.endpoints.search, q, secret);
  const body = await getValidated(url, ctx.fetchText, viaHeader);
  const raw = JSON.parse(body) as unknown;
  return { raw, mapped: toItems(cfg.displayName ?? cfg.name, cfg.endpoints.search, raw, cfg.baseUrl) };
}

/** Enabled, valid custom sources as adapters. Invalid ones stay dark
 *  (the panel surfaces validateCustomSource errors); disabled ones stay
 *  off. Runs inside answer() fan-out, so it must never throw. */
export function loadCustomAdapters(db: Database.Database): Adapter[] {
  const out: Adapter[] = [];
  try {
    for (const row of listConfigs(db)) {
      if (!row.source.startsWith(CUSTOM_PREFIX) || !row.enabled) continue;
      const cfg = row.settings as unknown as CustomSourceConfig;
      if (!cfg || typeof cfg !== 'object') continue;
      if (validateCustomSource(cfg).length > 0) continue;
      out.push(buildCustomAdapter(cfg.displayName ?? cfg.name, cfg));
    }
  } catch {
    return out;
  }
  return out;
}
