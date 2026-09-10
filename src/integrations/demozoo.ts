/**
 * Demozoo live adapter (https://demozoo.org/api/v1/, no key).
 *
 * TRAP: api.demozoo.org is NXDOMAIN - the base is demozoo.org/api/v1/.
 * Shapes pinned by tests/integrations/fixtures/demozoo-*.json (probed
 * live 2026-09-10): DRF {count,next,results[]} lists, detail rows with
 * author_nicks[]/platforms[]/types[] and demozoo_url.
 */
import type { Adapter, AdapterContext, AnswerItem } from './types';
import { cleanText } from './types';

const BASE = 'https://demozoo.org/api/v1';

interface DemozooProd {
  id?: number;
  title?: string;
  demozoo_url?: string;
  author_nicks?: Array<{ name?: string }>;
  platforms?: Array<{ name?: string }>;
  types?: Array<{ name?: string }>;
  release_date?: string;
}

function toItem(p: DemozooProd): AnswerItem {
  const by = (p.author_nicks ?? []).map((a) => a.name).filter(Boolean).join(', ') || 'unknown';
  const plats = (p.platforms ?? []).map((x) => x.name).filter(Boolean).join('/');
  const types = (p.types ?? []).map((x) => x.name).filter(Boolean);
  // Demozoo holds genuinely untitled uploads (title "?" - usually
  // tag/comment matches, not title matches). Rank them last and say
  // what they are instead of quoting a question mark (2026-09-10 -
  // the chat read "?" rows out loud).
  const rawTitle = (p.title ?? '').trim();
  const titled = rawTitle !== '' && !/^[?]+$/.test(rawTitle);
  const title = titled ? rawTitle : `[untitled ${types[0] ?? 'production'}]`;
  const detail = [plats, p.release_date].filter(Boolean).join(' ');
  return {
    source: 'Demozoo',
    title: cleanText(title, 120),
    detail: cleanText(`by ${by}${detail ? ` (${detail})` : ''}`, 200),
    url: p.demozoo_url ?? `https://demozoo.org/productions/${p.id}/`,
  };
}

function rank(rows: DemozooProd[]): DemozooProd[] {
  const titled = (p: DemozooProd) => {
    const t = (p.title ?? '').trim();
    return t !== '' && !/^[?]+$/.test(t);
  };
  return [...rows].sort((a, b) => Number(titled(b)) - Number(titled(a)));
}

export const demozooAdapter: Adapter = {
  id: 'demozoo',
  name: 'Demozoo',
  needsKey: false,

  async search(q: string, ctx: AdapterContext): Promise<AnswerItem[]> {
    const json = (await ctx.fetchJson(
      `${BASE}/productions/?q=${encodeURIComponent(q)}`
    )) as { results?: DemozooProd[] };
    return rank(json.results ?? []).slice(0, 5).map(toItem);
  },

  async latest(_ctx: AdapterContext): Promise<AnswerItem[]> {
    // No latest endpoint; latest is Pouet's job. Present-but-empty keeps
    // the answer fan-out honest about who contributed what.
    return [];
  },

  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const json = (await ctx.fetchJson(`${BASE}/productions/1/`)) as { id?: number };
      const ok = json.id === 1;
      return { ok, latencyMs: Date.now() - t0, detail: ok ? undefined : 'unexpected detail shape' };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  },
};
