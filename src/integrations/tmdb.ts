/**
 * TMDB adapter (keyed: free api_key from themoviedb.org).
 *
 * Search: GET /3/search/movie?api_key=KEY&query=Q ->
 * {results:[{id,title,overview,release_date}]}.
 * Link target is the TMDB page (never an image path - chats get words).
 *
 * Dark until the panel holds a key. Success fixture is DOC-DERIVED
 * (shape per developer.themoviedb.org; recapture with a real key).
 */
import type { Adapter, AdapterContext, AnswerItem } from './types';
import { cleanText } from './types';

interface TmdbMovie {
  id?: number;
  title?: string;
  overview?: string;
  release_date?: string;
}

export const tmdbAdapter: Adapter = {
  id: 'tmdb',
  name: 'TMDB',
  needsKey: true,

  async search(q: string, ctx: AdapterContext): Promise<AnswerItem[]> {
    const key = ctx.getSecret('api_key');
    if (!key) return [];
    const json = (await ctx.fetchJson(
      `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(key)}` +
      `&query=${encodeURIComponent(q)}&include_adult=false&language=en-US&page=1`
    )) as { results?: TmdbMovie[] };
    return (json.results ?? []).slice(0, 5).map((m) => ({
      source: 'TMDB',
      title: cleanText(m.title ?? `movie ${m.id}`, 120),
      detail: cleanText(`${m.release_date ?? ''} ${m.overview ?? ''}`.trim(), 200),
      url: `https://www.themoviedb.org/movie/${m.id}`,
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
