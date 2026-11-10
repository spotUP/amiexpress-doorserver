/**
 * AsciiArena adapter (https://asciiarena.se/api/v1, no key, 120 req/min/IP).
 *
 * Guide: /Users/spot/Desktop/asciiarena-bot-api-v1-chatbot-guide.md.
 * Shapes pinned by tests/integrations/fixtures/asciiarena-*.json (probed
 * live 2026-09-10). NOTE the search endpoint does NOT use the flat
 * {data:[],meta} envelope: it nests per-section arrays under data
 * ({data:{query,collys[],logos[]}}). Only hand-tagged (manual:true)
 * logo bounds are exact; the chat links to the viewer, never pastes art.
 */
import type { Adapter, AdapterContext, AnswerItem } from './types';
import { cleanText } from './types';

const BASE = 'https://asciiarena.se';

interface ArenaLogo {
  id?: number;
  label?: string;
  filename?: string;
  html_url?: string;
  manual?: boolean;
}

interface ArenaColly {
  filename?: string;
  name?: string;
}

function absUrl(rel: string | undefined): string {
  if (!rel) return `${BASE}/`;
  return rel.startsWith('http') ? rel : `${BASE}${rel.startsWith('/') ? '' : '/'}${rel}`;
}

function logoToItem(l: ArenaLogo): AnswerItem {
  return {
    source: 'AsciiArena',
    title: cleanText(l.label ?? `logo ${l.id}`, 120),
    detail: cleanText(`${l.filename ?? ''}${l.manual === false ? ' (auto-detected bounds)' : ''}`, 200),
    url: absUrl(l.html_url),
  };
}

export const asciiarenaAdapter: Adapter = {
  id: 'asciiarena',
  name: 'AsciiArena',
  needsKey: false,

  async search(q: string, ctx: AdapterContext): Promise<AnswerItem[]> {
    const json = (await ctx.fetchJson(`${BASE}/api/v1/search?q=${encodeURIComponent(q)}`)) as {
      data?: { logos?: ArenaLogo[]; collys?: ArenaColly[] };
    };
    const data = json.data ?? {};
    const items = (data.logos ?? []).slice(0, 4).map(logoToItem);
    const colly = (data.collys ?? [])[0];
    if (colly && items.length < 5) {
      items.push({
        source: 'AsciiArena',
        title: cleanText(colly.name ?? colly.filename ?? 'collection', 120),
        detail: cleanText(colly.filename ?? '', 200),
        url: absUrl(colly.filename ? `/release/${colly.filename}` : undefined),
      });
    }
    return items;
  },

  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const json = (await ctx.fetchJson(`${BASE}/api/v1/status`)) as {
        data?: { service?: string };
      };
      const ok = json.data?.service === 'asciiarena';
      return { ok, latencyMs: Date.now() - t0, detail: ok ? undefined : 'unexpected status shape' };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  },
};
