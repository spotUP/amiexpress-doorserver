/**
 * Shared shapes for the external scene-API integrations.
 *
 * One adapter per source behind a common interface (see the plan:
 * thoughts/shared/plans/2026-09-10-external-apis-admin.md). Adapters
 * never touch the network directly: they take a FetchJson, so tests
 * run on recorded fixtures and `test:ci` makes no live HTTP calls.
 */
export type FetchJson = (url: string) => Promise<unknown>;
export type FetchText = (url: string) => Promise<string>;
/** HEAD status code for link checks. */
export type HeadStatus = (url: string) => Promise<number>;

/** One chat-ready hit. Plain text, Latin-1-safe, attributed — the BBS
 *  operator chat renders these verbatim, so no HTML, no ANSI, no bulk. */
export interface AnswerItem {
  source: string;
  title: string;
  detail: string;
  url: string;
}

export interface AdapterContext {
  fetchJson: FetchJson;
  /** Raw text for non-JSON sources (ModArchive XML, feeds). */
  fetchText?: FetchText;
  /** HEAD status for link checks. Defaults to a live HEAD in answer(). */
  head?: HeadStatus;
  /** Server-side secret lookup (keyed sources only). Never serialized. */
  getSecret: (keyName: string) => string | null;
  settings: Record<string, unknown>;
}

export interface AdapterHealth {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface Adapter {
  id: string;
  name: string;
  needsKey: boolean;
  /** Custom sources only: tightens the merged-answer cache row. */
  ttlSeconds?: number;
  search: (q: string, ctx: AdapterContext) => Promise<AnswerItem[]>;
  /** Absent when the source has no random endpoint. */
  random?: (ctx: AdapterContext) => Promise<AnswerItem[]>;
  /** Latest/new arrivals, where the source offers it. */
  latest?: (ctx: AdapterContext) => Promise<AnswerItem[]>;
  health: (ctx: AdapterContext) => Promise<AdapterHealth>;
}

/** Strip tags, decode the few entities APIs actually emit, collapse
 *  whitespace to one line. The chat path has no HTML renderer. */
export function cleanText(raw: unknown, maxLen = 300): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const s = String(raw)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}
