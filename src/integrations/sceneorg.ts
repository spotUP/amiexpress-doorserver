/**
 * scene.org link checker (no key, no index).
 *
 * There is no scene.org search API, so this adapter has no search: it
 * answers one question - "does this download URL resolve?" - with a
 * HEAD request before the chat hands a URL to a caller. The BBS-side
 * tool calls it through /answer's `check` mode (see router.ts), not
 * through the fan-out.
 */
import type { AdapterContext, AnswerItem } from './types';
import { createHeadStatus } from './fetch';

export interface LinkCheck {
  url: string;
  ok: boolean;
  status: number;
}

export async function checkLink(url: string, ctx: AdapterContext): Promise<LinkCheck> {
  const head = ctx.head ?? createHeadStatus();
  try {
    const status = await head(url);
    return { url, ok: status >= 200 && status < 400, status };
  } catch {
    return { url, ok: false, status: 0 };
  }
}

/** A pseudo-adapter so /status lists scene.org health. Never in fan-out. */
export const sceneorgAdapter = {
  id: 'sceneorg',
  name: 'scene.org',
  needsKey: false,
  async search(_q: string, _ctx: AdapterContext): Promise<AnswerItem[]> {
    return [];
  },
  async health(ctx: AdapterContext): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    // A stable mirror root that answers HEAD; the check is reachability,
    // not content.
    const checked = await checkLink('https://files.scene.org/', ctx);
    return {
      ok: checked.ok,
      latencyMs: Date.now() - t0,
      detail: checked.ok ? undefined : `HEAD status ${checked.status}`,
    };
  },
};
