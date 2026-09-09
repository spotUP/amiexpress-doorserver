/**
 * Internet Archive adapter (no key for reads).
 *
 * advancedsearch.php + /metadata/<id>. Their one rule is caching, so
 * this adapter wants a generous TTL (see settings.ttlSeconds, default
 * 1 day) - answer.ts caps merged answers at 120s, the per-source TTL
 * below applies when this adapter is called directly.
 *
 * Shapes pinned by tests/integrations/fixtures/ia-*.json (probed live
 * 2026-09-10): search -> {response:{numFound,docs:[{identifier,title,
 * creator?}]}}, metadata -> {metadata:{title,creator?,description?},
 * files:[{name,format,size?}], dir}.
 */
import type { Adapter, AdapterContext, AnswerItem } from './types';
import { cleanText } from './types';

interface IaDoc {
  identifier?: string;
  title?: string;
  creator?: string;
}

export const archiveorgAdapter: Adapter = {
  id: 'archiveorg',
  name: 'Internet Archive',
  needsKey: false,

  async search(q: string, ctx: AdapterContext): Promise<AnswerItem[]> {
    const url =
      'https://archive.org/advancedsearch.php' +
      `?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&rows=5&output=json`;
    const json = (await ctx.fetchJson(url)) as { response?: { docs?: IaDoc[] } };
    return (json.response?.docs ?? []).slice(0, 5).map((d) => ({
      source: 'Internet Archive',
      title: cleanText(d.title ?? d.identifier ?? 'untitled', 120),
      detail: cleanText(d.creator ? `by ${d.creator}` : 'downloadable', 200),
      url: `https://archive.org/details/${encodeURIComponent(d.identifier ?? '')}`,
    }));
  },

  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const json = (await ctx.fetchJson(
        'https://archive.org/advancedsearch.php?q=test&fl[]=identifier&rows=1&output=json'
      )) as { response?: { numFound?: number } };
      const ok = typeof json.response?.numFound === 'number';
      return { ok, latencyMs: Date.now() - t0, detail: ok ? undefined : 'unexpected search shape' };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  },
};
