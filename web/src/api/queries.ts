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
  latest?: boolean;
  /** 'archive' finds the doors whose name is a guess from the filename. */
  nameSource?: string;
  /** Doors whose ads have not yet been reviewed/stripped. */
  unstripped?: boolean;
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
  if (query.latest) params.set('latest', '1');
  if (query.nameSource) params.set('name_source', query.nameSource);
  if (query.unstripped) params.set('unstripped', '1');
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
  doorHistory: (archive: string) => ['doors', 'history', archive] as const,
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

export function useDoorAudit(archiveName: string | null, enabled: boolean) {
  return useQuery({
    queryKey: doorKeys.doorHistory(archiveName ?? ''),
    queryFn: () =>
      api.get<{ entries: AuditEntry[] }>(`/admin/doors/${encodeURIComponent(archiveName as string)}/audit`),
    enabled: enabled && Boolean(archiveName),
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

export function useBatchTags() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (args: { archiveNames: string[]; add: string[]; remove: string[] }) =>
      api.post<{ ok: boolean; results: BatchResult[] }>('/admin/doors/batch-tags', args),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useBatchDelete() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (args: { archiveNames: string[]; confirm: string }) =>
      api.post<{ ok: boolean; results: BatchResult[] }>('/admin/doors/batch-delete', args),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useBatchReextract() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (archiveNames: string[]) => api.post<{ jobId: string }>('/admin/doors/batch-reextract', { archiveNames }),
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
    mutationFn: ({ text, mode }: { text: string; mode?: 'sentence' | 'title' }) =>
      api.post<{ text: string }>('/admin/tidy-case', { text, mode }),
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

export interface StripCandidate { path: string; reason: string }
export interface StripPreviewResult { archiveName: string; stripped: StripCandidate[] }

/** Kicks off the batch-strip-preview job (phase 1 of batch strip); the
 *  caller polls /admin/jobs/:id and JSON.parses resultJson into
 *  StripPreviewResult[] once the job is done. */
export function useBatchStripPreview() {
  return useMutation({
    mutationFn: (archiveNames: string[]) => api.post<{ jobId: string }>('/admin/doors/batch-strip-preview', { archiveNames }),
  });
}

export function useFileInfo(archiveName: string) {
  return (path: string) =>
    api.get<{ path: string; size: number; isText: boolean }>(
      `/admin/doors/${encodeURIComponent(archiveName)}/file-info?path=${encodeURIComponent(path)}`,
    );
}

export function useStripArchive(archiveName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (members: string[]) =>
      api.post<StripResult>(`/admin/doors/${encodeURIComponent(archiveName)}/strip`, { members }),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useLearnPattern() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (data: { pattern: string; archiveName?: string; filePath?: string }) =>
      api.post<{ ok: boolean; id: number; duplicate?: boolean }>('/admin/learn', data),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useUnlearnByPath() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (data: { archiveName: string; filePath: string }) =>
      api.del<{ ok: boolean; removed: number }>(
        `/admin/learned/by-path?archiveName=${encodeURIComponent(data.archiveName)}&filePath=${encodeURIComponent(data.filePath)}`,
      ),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useMarkNotJunk() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (data: { archiveName: string; path: string; reason?: string }) =>
      api.post<{ ok: boolean }>(`/admin/doors/${encodeURIComponent(data.archiveName)}/not-junk`, {
        path: data.path,
        reason: data.reason,
      }),
    onSuccess: () => invalidateEverything(client),
  });
}

export function useUnmarkNotJunk() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (data: { archiveName: string; path: string }) =>
      api.del<{ ok: boolean; removed: number }>(
        `/admin/doors/${encodeURIComponent(data.archiveName)}/not-junk?path=${encodeURIComponent(data.path)}`,
      ),
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

export interface ReleaseGroupUpdate {
  fullName: string | null;
  newAbbreviation?: string;
}

export function useUpdateReleaseGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (updates: Record<string, string | null | ReleaseGroupUpdate>) =>
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

// ─── authors (multi-value) ──────────────────────────────────────────────

export function useDoorAuthors(archiveName: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...doorKeys.detail(archiveName ?? ''), 'authors'],
    queryFn: () => api.get<{ authors: string[] }>(`/admin/doors/${encodeURIComponent(archiveName as string)}/authors`),
    enabled: enabled && Boolean(archiveName),
  });
}

export function useSetDoorAuthors(archiveName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (authors: string[]) =>
      api.patch<{ ok: boolean; authors: string[] }>(
        `/admin/doors/${encodeURIComponent(archiveName)}/authors`,
        { authors },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: doorKeys.detail(archiveName) });
    },
  });
}

// ─── votes ────────────────────────────────────────────────────────────

export interface VoteStatus {
  up: number;
  down: number;
  score: number;
  myVote: number;
}

export function useVoteStatus(archiveName: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...doorKeys.detail(archiveName ?? ''), 'vote'],
    queryFn: () => api.get<VoteStatus>(`/doors/${encodeURIComponent(archiveName as string)}/votes`),
    enabled: enabled && Boolean(archiveName),
  });
}

export function useVote(archiveName: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vote: 1 | -1 | 0) =>
      api.post<VoteStatus>(`/doors/${encodeURIComponent(archiveName)}/vote`, { vote }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: doorKeys.detail(archiveName) });
      void client.invalidateQueries({ queryKey: doorKeys.all });
    },
    onError: (e: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[vote] failed:', e);
    },
  });
}
