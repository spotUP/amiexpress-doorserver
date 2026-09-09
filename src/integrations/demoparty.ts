/**
 * demoparty.net feed adapter (iCal/RSS, no key).
 *
 * Party-calendar fallback behind Pouet/Demozoo party data. The feed is
 * upcoming-sorted RSS with demopartynet: namespaced fields (startDate,
 * endDate, country, url) - parsed with fast-xml-parser, same as
 * ModArchive's XML. Shape pinned by
 * tests/integrations/fixtures/demoparty-feed.xml (captured live
 * 2026-09-10).
 */
import { XMLParser } from 'fast-xml-parser';
import type { Adapter, AdapterContext, AnswerItem } from './types';
import { cleanText } from './types';

const FEED_URL = 'https://www.demoparty.net/demoparties.xml';

const parser = new XMLParser({ ignoreAttributes: false });

interface FeedItem {
  title?: string;
  link?: string;
  'demopartynet:date'?: string;
  'demopartynet:startDate'?: string;
  'demopartynet:endDate'?: string;
  'demopartynet:country'?: string;
  'demopartynet:url'?: string;
}

function itemsOf(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: FeedItem | FeedItem[] } } };
  const items = doc.rss?.channel?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

/** Tracking params (mtm_*) are the feed's, not the party's. */
function cleanLink(link: string | undefined): string {
  if (!link) return 'https://www.demoparty.net/';
  try {
    const u = new URL(link);
    for (const k of [...u.searchParams.keys()]) {
      if (k.startsWith('mtm_')) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return link;
  }
}

function toItem(p: FeedItem): AnswerItem {
  const country = cleanText(p['demopartynet:country'] ?? '', 10).toUpperCase();
  const date = cleanText(p['demopartynet:date'] ?? '', 80);
  return {
    source: 'demoparty.net',
    title: cleanText(p.title ?? 'party', 120),
    detail: cleanText(`${date}${country ? ` (${country})` : ''}`, 200),
    url: cleanText(p['demopartynet:url'] ?? cleanLink(p.link), 300),
  };
}

export const demopartyAdapter: Adapter = {
  id: 'demoparty',
  name: 'demoparty.net',
  needsKey: false,

  async search(q: string, ctx: AdapterContext): Promise<AnswerItem[]> {
    const fetchText = ctx.fetchText ?? (async () => { throw new Error('no text fetcher'); });
    const items = itemsOf(await fetchText(FEED_URL));
    const needle = q.toLowerCase();
    return items
      .filter((p) =>
        (p.title ?? '').toLowerCase().includes(needle) ||
        (p['demopartynet:country'] ?? '').toLowerCase() === needle
      )
      .slice(0, 5)
      .map(toItem);
  },

  async latest(ctx: AdapterContext): Promise<AnswerItem[]> {
    const fetchText = ctx.fetchText ?? (async () => { throw new Error('no text fetcher'); });
    return itemsOf(await fetchText(FEED_URL)).slice(0, 5).map(toItem);
  },

  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const fetchText = ctx.fetchText ?? (async () => { throw new Error('no text fetcher'); });
      const ok = itemsOf(await fetchText(FEED_URL)).length > 0;
      return { ok, latencyMs: Date.now() - t0, detail: ok ? undefined : 'empty feed' };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  },
};
