/**
 * 16colors artpacks adapter (no key).
 *
 * No GitHub file mirror exists (16colo-rs/16c is the site repo; mirrors
 * are FTP/RSYNC only), so the searchable index is the sixteencolors
 * artpack archive's git tree (per-year pack ZIPs, ~1.4 MB listing).
 * Search filters pack paths by name; hits link the raw ZIP.
 *
 * Bandwidth manners: the tree is fetched at most once a day (module
 * cache, 24h TTL - the GitHub API allows 60 unauthenticated calls/hour
 * and the listing barely moves). Bytes served are links only, never
 * transcoded, so CP437 art is never mangled server-side.
 */
import type { Adapter, AdapterContext, AnswerItem } from './types';
import { cleanText } from './types';
import { createFetchText, ResponseTooLarge } from './fetch';

const TREE_URL =
  'https://api.github.com/repos/sixteencolors/sixteencolors-archive/git/trees/master?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/sixteencolors/sixteencolors-archive/master';
const TREE_TTL_MS = 24 * 3600 * 1000;
const TREE_MAX_BYTES = 4 * 1024 * 1024;

let treeCache: { at: number; paths: string[] } | null = null;
/** Test seam. */
export function resetArtpacksCache(): void {
  treeCache = null;
}

/** Exported as a test seam (the retry takes an injectable big fetcher). */
export async function packPaths(
  ctx: AdapterContext,
  bigFetchText: (url: string) => Promise<string> = createFetchText({ maxBytes: TREE_MAX_BYTES })
): Promise<string[]> {
  if (treeCache && Date.now() - treeCache.at < TREE_TTL_MS) return treeCache.paths;
  // The shared fetcher caps at 1 MB; the tree is 1.4 MB. A cap hit from
  // the shared fetcher retries with this adapter's own 4 MB fetcher -
  // any other error propagates.
  const fetchText = ctx.fetchText ?? bigFetchText;
  let raw: string;
  try {
    raw = await fetchText(TREE_URL);
  } catch (e) {
    if (e instanceof ResponseTooLarge && ctx.fetchText) {
      raw = await bigFetchText(TREE_URL);
    } else {
      throw e;
    }
  }
  const doc = JSON.parse(raw) as {
    tree?: Array<{ path?: string; type?: string }>;
  };
  const paths = (doc.tree ?? [])
    .filter((e) => e.type === 'blob' && (e.path ?? '').toLowerCase().endsWith('.zip'))
    .map((e) => e.path as string);
  treeCache = { at: Date.now(), paths };
  return paths;
}

export const artpacksAdapter: Adapter = {
  id: 'artpacks',
  name: '16colors artpacks',
  needsKey: false,

  async search(q: string, ctx: AdapterContext): Promise<AnswerItem[]> {
    const needle = q.toLowerCase();
    const hits = (await packPaths(ctx)).filter((p) => p.toLowerCase().includes(needle)).slice(0, 5);
    return hits.map((p) => {
      const file = p.split('/').pop() ?? p;
      const year = p.split('/')[0] ?? '';
      return {
        source: 'artpacks',
        title: cleanText(file, 120),
        detail: cleanText(`artpack ${year}`, 60),
        url: `${RAW_BASE}/${p.split('/').map(encodeURIComponent).join('/')}`,
      };
    });
  },

  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const n = (await packPaths(ctx)).length;
      return { ok: n > 0, latencyMs: Date.now() - t0, detail: n > 0 ? `${n} packs indexed` : 'empty tree' };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  },
};
