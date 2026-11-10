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
  releaseGroup: string | null;
  releaseGroupFull: string | null;
  rawDesc: string;
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
  group?: string;
  dir?: number;
  from?: string;
  to?: string;
  sort?: string;
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
  if (query.group) params.set('group', query.group);
  if (query.dir) params.set('dir', String(query.dir));
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.sort) params.set('sort', query.sort);
  if (query.order) params.set('order', query.order);
  if (query.page && query.page > 1) params.set('offset', String((query.page - 1) * (query.perPage ?? 50)));
  if (query.perPage) params.set('limit', String(query.perPage));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const releaseKeys = {
  all: ['releases'] as const,
  list: (query: ReleaseQuery) => ['releases', 'list', query] as const,
};

export interface ReleaseGroup {
  abbreviation: string;
  fullName: string;
  files: number;
}

export interface ReleaseStats {
  contractVersion: string;
  revision: string;
  total: number;
  withUploader: number;
  withDlCount: number;
  byFlag: { value: string | null; n: number }[];
  byGroup: { value: string | null; n: number }[];
  byUploader: { value: string | null; n: number }[];
  byAuthor: { value: string | null; n: number }[];
  sizeDistribution: { value: string | null; n: number }[];
  overTime: { value: string | null; n: number }[];
}

export interface FactsFile {
  filename: string;
  dirNo: number;
  fileNo: number;
  dateIso: string;
}

export interface ReleaseFacts {
  contractVersion: string;
  revision: string;
  span: { firstDate: string; lastDate: string; firstFile: FactsFile; lastFile: FactsFile };
  firstDiz: (FactsFile & { lines: number; rawDesc: string }) | null;
  peakYear: { year: string; n: number };
  peakMonth: { month: string; n: number };
  topExt: { ext: string; n: number }[];
  extCrossover: { year: string } | null;
  weekday: { day: string; counts: number[] };
  biggest: (FactsFile & { sizeBytes: number }) | null;
  longestDesc: (FactsFile & { chars: number; lines: number }) | null;
  mostDownloaded: (FactsFile & { dlCount: number }) | null;
  medianSize: number | null;
  futureCount: number;
}

export function useReleaseFacts(enabled = true) {
  return useQuery({
    queryKey: [...releaseKeys.all, 'facts'] as const,
    queryFn: () => get<ReleaseFacts>('/facts'),
    enabled,
  });
}

export function useReleaseStats(enabled = true) {
  return useQuery({
    queryKey: [...releaseKeys.all, 'stats'] as const,
    queryFn: () => get<ReleaseStats>('/stats'),
    enabled,
  });
}

export function useReleaseGroups(enabled = true) {
  return useQuery({
    queryKey: [...releaseKeys.all, 'groups'] as const,
    queryFn: () =>
      get<{ contractVersion: string; revision: string; groups: ReleaseGroup[] }>('/groups'),
    enabled,
  });
}

export function useReleases(query: ReleaseQuery, enabled = true) {
  return useQuery({
    queryKey: releaseKeys.list(query),
    queryFn: () => get<ReleasePage>(`/list${toReleaseSearch(query)}`),
    enabled,
    placeholderData: (previous) => previous,
  });
}
