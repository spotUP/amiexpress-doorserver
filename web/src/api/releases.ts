/**
 * The releases surface: the AquaScan BBS file listing (all release types),
 * read-only, no login. Separate base, separate types, separate query keys —
 * it shares nothing with the door catalog except the fetch/house style.
 */
import { useQuery } from '@tanstack/react-query';
import { ApiError } from './client';

const BASE = '/releases/v1';

export interface ReleaseFile {
  id: number;
  dirNo: number;
  fileNo: number;
  filename: string;
  /** N/P/D/F/O as listed (D = nuked/deleted); '' when the column was blank. */
  flag: string;
  sizeBytes: number | null;
  /** Raw size column when it is not bytes (`>NUKED<`, `DELETED`, …). */
  sizeNote: string | null;
  dateIso: string;
  dlCount: number | null;
  uploader: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
}

export interface ReleasePage {
  contractVersion: string;
  revision: string;
  total: number;
  offset: number;
  limit: number;
  rows: ReleaseFile[];
}

export interface ReleaseQuery {
  q?: string;
  flag?: string;
  dir?: number;
  order?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

export function toReleaseSearch(query: ReleaseQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.flag) params.set('flag', query.flag);
  if (query.dir) params.set('dir', String(query.dir));
  if (query.order === 'desc') params.set('order', 'desc');
  if (query.page && query.page > 1) params.set('offset', String((query.page - 1) * (query.perPage ?? 50)));
  if (query.perPage) params.set('limit', String(query.perPage));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const releaseKeys = {
  all: ['releases'] as const,
  list: (query: ReleaseQuery) => ['releases', 'list', query] as const,
};

export function useReleases(query: ReleaseQuery, enabled = true) {
  return useQuery({
    queryKey: releaseKeys.list(query),
    queryFn: () => get<ReleasePage>(`/list${toReleaseSearch(query)}`),
    enabled,
    placeholderData: (previous) => previous,
  });
}
