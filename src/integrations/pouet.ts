/**
 * Pouet 2.0 adapter (https://api.pouet.net/v1/, no key).
 *
 * Shapes pinned by tests/integrations/fixtures/pouet-*.json (probed
 * live 2026-09-10): search results are an OBJECT keyed by prod id,
 * front-page lists are {success, prods:[{rank, prod}]}.
 */
import type { Adapter, AdapterContext, AnswerItem } from './types';
import { cleanText } from './types';

const BASE = 'https://api.pouet.net/v1';

interface PouetProd {
  id?: string | number;
  name?: string;
  type?: string;
  addedDate?: string;
  addedUser?: { nickname?: string };
}

function toItem(p: PouetProd): AnswerItem {
  const id = String(p.id ?? '');
  const by = cleanText(p.addedUser?.nickname ?? 'unknown', 60);
  const type = cleanText(p.type ?? '', 60);
  return {
    source: 'Pouët',
    title: cleanText(p.name ?? `prod ${id}`, 120),
    detail: `${type} by ${by}`.trim(),
    url: `https://www.pouet.net/prod.php?which=${encodeURIComponent(id)}`,
  };
}

function isSuccess(json: unknown): json is Record<string, unknown> {
  return !!json && typeof json === 'object' && (json as { success?: boolean }).success === true;
}

export const pouetAdapter: Adapter = {
  id: 'pouet',
  name: 'Pouët.net',
  needsKey: false,

  async search(q: string, ctx: AdapterContext): Promise<AnswerItem[]> {
    const json = await ctx.fetchJson(`${BASE}/search/prod/?q=${encodeURIComponent(q)}`);
    if (!isSuccess(json)) return [];
    const results = (json as { results?: Record<string, PouetProd> }).results ?? {};
    return Object.values(results).slice(0, 5).map(toItem);
  },

  async random(ctx: AdapterContext): Promise<AnswerItem[]> {
    const json = await ctx.fetchJson(`${BASE}/prod/?random=true`);
    if (!isSuccess(json)) return [];
    const prod = (json as { prod?: PouetProd }).prod;
    return prod ? [toItem(prod)] : [];
  },

  async latest(ctx: AdapterContext): Promise<AnswerItem[]> {
    const json = await ctx.fetchJson(`${BASE}/front-page/latest-added/`);
    if (!isSuccess(json)) return [];
    // latest-added items are bare prods; top-of-the-month wraps them as
    // {rank, prod}. Accept both - probed live 2026-09-10.
    const prods = (json as { prods?: Array<{ prod?: PouetProd } & PouetProd> }).prods ?? [];
    return prods
      .map((r) => toItem(r.prod ?? r))
      .filter((x): x is AnswerItem => !!x)
      .slice(0, 5);
  },

  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const json = await ctx.fetchJson(`${BASE}/front-page/latest-added/`);
      const ok = isSuccess(json);
      return { ok, latencyMs: Date.now() - t0, detail: ok ? undefined : 'success != true' };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  },
};
