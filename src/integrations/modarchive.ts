/**
 * ModArchive adapter (keyed: api_key from the ModArchive forum).
 *
 * XML API: https://api.modarchive.org/xml-tools.php?key=KEY&request=
 * search&query=Q&type=filename_or_songtitle -> <modarchive><module>
 * <id><songtitle><format>... Download: https://modarchive.org/index.php
 * ?request=view_by_moduleid&query=<id>
 *
 * Dark until the panel holds a key (needsKey + isEnabled). The success
 * fixture below is DOC-DERIVED (no key was available at build time -
 * see the recapture note in the test); the dark-default and every
 * degrade path run against live-captured behavior.
 */
import { XMLParser } from 'fast-xml-parser';
import type { Adapter, AdapterContext, AnswerItem } from './types';
import { cleanText } from './types';

const parser = new XMLParser({ ignoreAttributes: false });

interface MaModule {
  id?: string | number;
  songtitle?: string;
  format?: string;
}

function toItem(m: MaModule): AnswerItem {
  const id = String(m.id ?? '');
  return {
    source: 'ModArchive',
    title: cleanText(m.songtitle ?? `module ${id}`, 120),
    detail: cleanText(m.format ?? 'module', 60),
    url: `https://modarchive.org/index.php?request=view_by_moduleid&query=${encodeURIComponent(id)}`,
  };
}

function modulesOf(xml: string): MaModule[] {
  const doc = parser.parse(xml) as { modarchive?: { module?: MaModule | MaModule[] } };
  const mods = doc.modarchive?.module;
  if (!mods) return [];
  return (Array.isArray(mods) ? mods : [mods]).slice(0, 5);
}

export const modarchiveAdapter: Adapter = {
  id: 'modarchive',
  name: 'ModArchive',
  needsKey: true,

  async search(q: string, ctx: AdapterContext): Promise<AnswerItem[]> {
    const key = ctx.getSecret('api_key');
    if (!key) return [];
    const fetchText = ctx.fetchText ?? (async () => { throw new Error('no text fetcher'); });
    const xml = await fetchText(
      `https://api.modarchive.org/xml-tools.php?key=${encodeURIComponent(key)}` +
      `&request=search&query=${encodeURIComponent(q)}&type=filename_or_songtitle`
    );
    return modulesOf(xml).map(toItem);
  },

  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    const key = ctx.getSecret('api_key');
    if (!key) return { ok: false, latencyMs: Date.now() - t0, detail: 'no api_key stored' };
    return { ok: true, latencyMs: Date.now() - t0, detail: 'key stored (live check on first query)' };
  },
};
