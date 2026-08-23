/**
 * Server state lives in TanStack Query, and only there. Nothing in this app
 * calls location.reload() - an eslint rule forbids it - because a page that
 * reloads to show new data loses the reader's place.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from './client';
import type {
  AdminDoor,
  AuditEntry,
  DoorDetail,
  DoorFacts,
  DoorPage,
  Facets,
  HiddenDoor,
  Submission,
} from './types';

export interface DoorQuery {
  q?: string;
  system?: string;
  type?: string;
  category?: string;
  requires?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
}

function toSearch(query: DoorQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.system) params.set('system', query.system);
  if (query.type) params.set('type', query.type);
  if (query.category) params.set('category', query.category);
  if (query.requires) params.set('requires', query.requires);
  if (query.sort) params.set('sort', query.sort);
  if (query.dir) params.set('dir', query.dir);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  if (query.perPage) params.set('per_page', String(query.perPage));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const doorKeys = {
  all: ['doors'] as const,
  list: (query: DoorQuery) => ['doors', 'list', query] as const,
  detail: (archive: string) => ['doors', 'detail', archive] as const,
  admin: (archive: string) => ['doors', 'admin', archive] as const,
  facets: ['facets'] as const,
  audit: ['audit'] as const,
  hidden: ['hidden'] as const,
  submissions: ['submissions'] as const,
};

export function useDoors(query: DoorQuery) {
  return useQuery({
    queryKey: doorKeys.list(query),
    queryFn: () => api.get<DoorPage>(`/doors${toSearch(query)}`),
    placeholderData: (previous) => previous,
  });
}

export function useDoor(archiveName: string | null) {
  return useQuery({
    queryKey: doorKeys.detail(archiveName ?? ''),
    queryFn: () => api.get<DoorDetail>(`/doors/${encodeURIComponent(archiveName as string)}`),
    enabled: Boolean(archiveName),
  });
}

export function useFacets() {
  return useQuery({ queryKey: doorKeys.facets, queryFn: () => api.get<Facets>('/facets') });
}

export function useAdminDoor(archiveName: string | null, enabled: boolean) {
  return useQuery({
    queryKey: doorKeys.admin(archiveName ?? ''),
    queryFn: () => api.get<AdminDoor>(`/admin/doors/${encodeURIComponent(archiveName as string)}`),
    enabled: Boolean(archiveName) && enabled,
  });
}

export function useAudit(enabled: boolean) {
  return useQuery({
    queryKey: doorKeys.audit,
    queryFn: () => api.get<{ rows: AuditEntry[] }>('/admin/audit?limit=100'),
    enabled,
  });
}

export function useHiddenDoors(enabled: boolean) {
  return useQuery({
    queryKey: doorKeys.hidden,
    queryFn: () => api.get<{ rows: HiddenDoor[] }>('/admin/hidden'),
    enabled,
  });
}

/**
 * Taking a door out of the repository, and putting it back. Both invalidate
 * every door query: the listing, the facet counts and the door's own page
 * all change at once.
 */
export function useHideDoor(archiveName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      api.del<{ ok: true }>(`/admin/doors/${encodeURIComponent(archiveName)}`, { reason }),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useRestoreDoor() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (archiveName: string) =>
      api.post<{ ok: true; restored: boolean }>(`/admin/doors/${encodeURIComponent(archiveName)}/restore`),
    onSuccess: () => invalidateEverything(client),
  });
}

function invalidateEverything(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: doorKeys.all });
  void client.invalidateQueries({ queryKey: doorKeys.facets });
  void client.invalidateQueries({ queryKey: doorKeys.hidden });
  void client.invalidateQueries({ queryKey: doorKeys.audit });
  void client.invalidateQueries({ queryKey: doorKeys.submissions });
}

export function useSubmissions(status: string, enabled: boolean) {
  return useQuery({
    queryKey: [...doorKeys.submissions, status],
    queryFn: () => api.get<{ rows: Submission[] }>(`/admin/submissions?status=${encodeURIComponent(status)}`),
    enabled,
  });
}

export function useApproveSubmission() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/admin/submissions/${encodeURIComponent(id)}/approve`),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useRejectSubmission() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<{ ok: true }>(`/admin/submissions/${encodeURIComponent(id)}/reject`, { reason }),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useSaveField(archiveName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, string | null>) =>
      api.patch<{ ok: true }>(`/admin/doors/${encodeURIComponent(archiveName)}`, patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: doorKeys.all });
      void client.invalidateQueries({ queryKey: doorKeys.audit });
    },
  });
}

export function useRevertField(archiveName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (field: string) =>
      api.del<{ ok: true; reverted: boolean }>(
        `/admin/doors/${encodeURIComponent(archiveName)}/overrides/${encodeURIComponent(field)}`
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: doorKeys.all });
      void client.invalidateQueries({ queryKey: doorKeys.audit });
    },
  });
}

export function useRedescribe(archiveName: string) {
  return useMutation({
    mutationFn: () => api.post<DoorFacts>(`/admin/doors/${encodeURIComponent(archiveName)}/redescribe`),
  });
}

/**
 * The catalog announces its own revision over SSE. When it changes - someone
 * else edited a door, a submission was approved, a re-scan landed - every
 * door query is invalidated and the open page refreshes itself in place.
 */
export function useLiveRevision(): void {
  const client = useQueryClient();
  useEffect(() => {
    let seen: string | null = null;
    const source = new EventSource('/api/door-repo/events');
    source.addEventListener('revision', (event) => {
      const { revision } = JSON.parse((event as MessageEvent<string>).data) as { revision: string };
      if (seen !== null && revision !== seen) {
        void client.invalidateQueries({ queryKey: doorKeys.all });
        void client.invalidateQueries({ queryKey: doorKeys.facets });
      }
      seen = revision;
    });
    // EventSource reconnects on its own; nothing to do on error but let it.
    return () => source.close();
  }, [client]);
}
