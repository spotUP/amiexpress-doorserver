/**
 * Scene-radio now-playing adapter (opportunistic, usually keyless).
 *
 * Fully driven by stored settings - there is no default station, because
 * guessing a station URL is how dead integrations happen:
 *   settings.stationUrl = the station's status-json.xsl URL
 *   settings.mountName  = which mount to read (default: first with a title)
 *   settings.stationPage = link handed to callers (default: status page dir)
 * ERICADE's token API fits the same shape later (settings.apiToken).
 *
 * search() answers "what is playing" regardless of q; health reports
 * unconfigured instead of failing when the sysop never set a station.
 * Icecast fixture is DOC-DERIVED (canonical status-json shape).
 */
import type { Adapter, AdapterContext, AnswerItem } from './types';
import { cleanText } from './types';

interface IceSource {
  server_name?: string;
  title?: string;
  listeners?: number;
  listenurl?: string;
}

export const radioAdapter: Adapter = {
  id: 'radio',
  name: 'Scene radio',
  needsKey: false,

  async search(_q: string, ctx: AdapterContext): Promise<AnswerItem[]> {
    const stationUrl = String(ctx.settings.stationUrl ?? '');
    if (!stationUrl) return [];
    const json = (await ctx.fetchJson(stationUrl)) as { icestats?: { source?: IceSource | IceSource[] } };
    const raw = json.icestats?.source;
    const sources = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    const mount = String(ctx.settings.mountName ?? '');
    const hit =
      (mount && sources.find((s) => (s.listenurl ?? '').includes(mount))) ||
      sources.find((s) => (s.title ?? '').trim() !== '') ||
      sources[0];
    if (!hit) return [];
    const title = cleanText(hit.title ?? '', 200);
    if (!title) return [];
    const listeners =
      typeof hit.listeners === 'number' ? ` (${hit.listeners} listening)` : '';
    return [{
      source: 'Scene radio',
      title,
      detail: cleanText(`${hit.server_name ?? 'radio'}${listeners}`, 200),
      url: String(ctx.settings.stationPage ?? hit.listenurl ?? stationUrl),
    }];
  },

  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    if (!ctx.settings.stationUrl) {
      return { ok: false, latencyMs: Date.now() - t0, detail: 'no stationUrl configured' };
    }
    try {
      const items = await radioAdapter.search('', ctx);
      return {
        ok: true,
        latencyMs: Date.now() - t0,
        detail: items[0] ? `now playing: ${items[0].title}` : 'station up, nothing titled',
      };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  },
};
