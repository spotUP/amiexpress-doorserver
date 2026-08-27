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
  StripPreview,
  StripResult,
  Submission,
} from './types';

export interface DoorQuery {
  q?: string;
  system?: string;
  type?: string;
  category?: string;
  requires?: string;
  /** 'archive' finds the doors whose name is a guess from the filename. */
  nameSource?: string;
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
  if (query.nameSource) params.set('name_source', query.nameSource);
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
    enabled: enabled && Boolean(archiveName),
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

// ─── batch operations ──────────────────────────────────────────────────

export interface BatchResult {
  archiveName: string;
  ok: boolean;
  error?: string;
  restored?: boolean;
}

export function useBatchHide() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (doors: { archiveName: string; reason?: string }[]) =>
      api.post<{ ok: boolean; results: BatchResult[] }>('/admin/doors/batch-hide', { doors }),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useBatchRestore() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (archiveNames: string[]) =>
      api.post<{ ok: boolean; results: BatchResult[] }>('/admin/doors/batch-restore', { archiveNames }),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useBatchPatch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (args: { archiveNames: string[]; fields: Record<string, string | null> }) =>
      api.post<{ ok: boolean; edited: number; fields: number; changes: number }>(
        '/admin/doors/batch-patch',
        args,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: doorKeys.all });
      void client.invalidateQueries({ queryKey: doorKeys.audit });
    },
  });
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
 * The server's casing normaliser, behind the editor's fix-casing button: it
 * is the same tidyCase() the classifier runs, so a tidied edit and a
 * re-derived field read the same way.
 */
export function useTidyCase() {
  return useMutation({
    mutationFn: (text: string) => api.post<{ text: string }>('/admin/tidy-case', { text }),
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

// ─── archive stripping ─────────────────────────────────────────────────

export function useStripPreview(archiveName: string) {
  return useMutation({
    mutationFn: () =>
      api.post<StripPreview>(`/admin/doors/${encodeURIComponent(archiveName)}/strip-preview`),
  });
}

export function useStripArchive(archiveName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (members: string[]) =>
      api.post<StripResult>(`/admin/doors/${encodeURIComponent(archiveName)}/strip`, { members }),
    onSuccess: () => invalidateEverything(client),
  });
}

// ─── release groups ─────────────────────────────────────────────────────

export interface ReleaseGroup {
  abbreviation: string;
  full_name: string;
  updated_at?: number;
}

const releaseGroupKeys = {
  all: ['release-groups'] as const,
};

export function useReleaseGroups(enabled: boolean) {
  return useQuery({
    queryKey: releaseGroupKeys.all,
    queryFn: () => api.get<{ groups: ReleaseGroup[] }>('/admin/release-groups'),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useUpdateReleaseGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (updates: Record<string, string | null>) =>
      api.patch<{ ok: boolean; groups: string[] }>('/admin/release-groups', updates),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: releaseGroupKeys.all });
    },
  });
}

// ─── duplicates ────────────────────────────────────────────────────────

export interface DuplicateGroup {
  n: number;
  archives: string;
  md5?: string;
  sha256?: string;
  name?: string;
  author?: string;
  version?: string | null;
}

export interface Duplicates {
  byMd5: DuplicateGroup[];
  bySha256: DuplicateGroup[];
  byContent: DuplicateGroup[];
}

export function useDuplicates(enabled: boolean) {
  return useQuery({
    queryKey: ['duplicates'],
    queryFn: () => api.get<Duplicates>('/admin/duplicates'),
    enabled,
    placeholderData: (previous) => previous,
  });
}

// ─── tags ──────────────────────────────────────────────────────────────

const tagKeys = {
  all: ['tags'] as const,
  door: (name: string) => ['tags', name] as const,
};

export function useAllTags(enabled: boolean) {
  return useQuery({
    queryKey: tagKeys.all,
    queryFn: () => api.get<{ tags: { tag: string; n: number }[] }>('/admin/tags'),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useDoorTags(archiveName: string | null, enabled: boolean) {
  return useQuery({
    queryKey: tagKeys.door(archiveName ?? ''),
    queryFn: () => api.get<{ tags: string[] }>(`/admin/doors/${encodeURIComponent(archiveName as string)}/tags`),
    enabled: enabled && Boolean(archiveName),
  });
}

export function useSetDoorTags(archiveName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (tags: string[]) =>
      api.patch<{ ok: boolean; tags: string[] }>(
        `/admin/doors/${encodeURIComponent(archiveName)}/tags`,
        { tags },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: tagKeys.all });
      void client.invalidateQueries({ queryKey: tagKeys.door(archiveName) });
    },
  });
}
