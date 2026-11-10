/**
 * OMDb adapter (keyed: free api_key from omdbapi.com) - IMDb ratings
 * without IMDb scraping (there is no IMDb API).
 *
 * Search: GET ?apikey=KEY&s=Q&type=movie -> {Response:'True',
 * Search:[{Title,Year,imdbID}]}. Detail per hit would cost a request
 * each; the chat gets title/year/rating-link instead - the detail call
 * is reserved for a future `detail` mode.
 *
 * Dark until the panel holds a key. Success fixture is DOC-DERIVED
 * (shape per omdbapi.com; recapture with a real key).
 */
import type { Adapter, AdapterContext, AnswerItem } from './types';
import { cleanText } from './types';

interface OmdbHit {
  Title?: string;
  Year?: string;
  imdbID?: string;
  Type?: string;
}

export const omdbAdapter: Adapter = {
  id: 'omdb',
  name: 'OMDb',
  needsKey: true,

  async search(q: string, ctx: AdapterContext): Promise<AnswerItem[]> {
    const key = ctx.getSecret('api_key');
    if (!key) return [];
    const json = (await ctx.fetchJson(
      `https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}` +
      `&s=${encodeURIComponent(q)}&type=movie`
    )) as { Response?: string; Search?: OmdbHit[]; Error?: string };
    if (json.Response !== 'True') return [];
    return (json.Search ?? []).slice(0, 5).map((h) => ({
      source: 'OMDb',
      title: cleanText(h.Title ?? h.imdbID ?? 'untitled', 120),
      detail: cleanText(`${h.Year ?? ''} ${h.Type ?? ''}`.trim(), 100),
      url: `https://www.imdb.com/title/${h.imdbID}/`,
    }));
  },

  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    if (!ctx.getSecret('api_key')) {
      return { ok: false, latencyMs: Date.now() - t0, detail: 'no api_key stored' };
    }
    return { ok: true, latencyMs: Date.now() - t0, detail: 'key stored (live check on first query)' };
  },
};
