/**
 * One door in full: what it is, what it needs, what is inside the archive,
 * and its FILE_ID.DIZ verbatim. An admin gets the same dialog with an Edit
 * tab, so there is one place that describes a door rather than two.
 */
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { Download, Eye, GraduationCap, ThumbsUp, ThumbsDown, Trash2, X } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAdminDoor, useDoor, useDoorTags, useAllTags, useSetDoorTags, useLearnPattern, useRedescribe, useRevertField, useSaveField, useStripArchive, useStripPreview, useTidyCase, useVoteStatus, useVote, useDoorAudit } from '../api/queries';
import { api } from '../api/client';
import type { AdminUser, DoorFacts, DoorFile, StripPreview } from '../api/types';
import { DizView } from './DizView';
import { GuideView } from './GuideView';
import { FieldEditor } from './FieldEditor';
import { RemoveDoor } from './RemoveDoor';
import { Badge, Button, formatSize } from './ui';

const TEXT_EXTS = /\.(txt|me|guide|doc|diz|ans|asc|nfo|rip|info|readme)$/i;

function FileList({ archiveName, files }: { archiveName: string; files: DoorFile[] }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [learning, setLearning] = useState<Set<string>>(new Set());
  const [fileList, setFileList] = useState<DoorFile[]>(files);
  const learnPattern = useLearnPattern();

  async function loadFileContent(path: string) {
    setViewing(path);
    setContent(null);
    try {
      const text = await api.getText(`/admin/doors/${encodeURIComponent(archiveName)}/file?path=${encodeURIComponent(path)}`);
      setContent(text);
    } catch { setContent('[read error]'); }
  }

  async function deleteFile(path: string) {
    setConfirmDelete(null);
    setDeleteError(null);
    setDeleting((prev) => new Set(prev).add(path));
    try {
      const result = await api.post<{ removed: string[] }>(
        `/admin/doors/${encodeURIComponent(archiveName)}/delete-files`,
        { members: [path] }
      );
      if (result.removed.length > 0) {
        setFileList((prev) => prev.filter((f) => f.path !== path));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setDeleteError(msg || 'Failed');
    } finally {
      setDeleting((prev) => { const next = new Set(prev); next.delete(path); return next; });
    }
  }

  async function learnFile(path: string) {
    setLearning((prev) => new Set(prev).add(path));
    try {
      await learnPattern.mutateAsync({ pattern: path, archiveName, filePath: path });
      setFileList((prev) => prev.map((f) => f.path === path ? { ...f, isJunk: true, junkReason: 'learned' } : f));
    } finally {
      setLearning((prev) => { const next = new Set(prev); next.delete(path); return next; });
    }
  }

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line rounded-md border border-line">
        {fileList.map((file) => (
          <li key={file.path} className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span className="flex-1 truncate font-mono text-[12px]">{file.path}</span>
            {file.isJunk ? <Badge tone="warn">junk</Badge> : (
              <button
                onClick={() => learnFile(file.path)}
                disabled={learning.has(file.path)}
                className="rounded p-1 text-muted hover:bg-raised hover:text-accent"
                title="Learn as junk"
              >
                <GraduationCap size={13} />
              </button>
            )}
            <span className="font-mono text-[12px] text-muted">{formatSize(file.size)}</span>
            {TEXT_EXTS.test(file.path) && (
              <button onClick={() => loadFileContent(file.path)} className="rounded p-1 text-muted hover:bg-raised hover:text-accent" title="View contents">
                <Eye size={13} />
              </button>
            )}
            {confirmDelete === file.path ? (
              <span className="flex items-center gap-1 text-[11px]">
                <span className="text-danger">Delete?</span>
                <button
                  onClick={() => void deleteFile(file.path)}
                  disabled={deleting.has(file.path)}
                  className="rounded bg-danger/10 px-1.5 py-0.5 text-danger hover:bg-danger/20"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="rounded px-1.5 py-0.5 text-muted hover:bg-raised"
                >
                  No
                </button>
              </span>
            ) : (
              <button
                onClick={() => { setDeleteError(null); setConfirmDelete(file.path); }}
                disabled={deleting.has(file.path)}
                className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
                title="Delete from archive"
              >
                <Trash2 size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>

      {deleteError && (
        <p className="rounded border border-danger/30 bg-danger/5 px-3 py-1.5 text-xs text-danger">{deleteError}</p>
      )}

      {viewing && (
        <div className="rounded-md border border-line bg-bg p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-xs text-accent">{viewing}</span>
            <button onClick={() => setViewing(null)} className="text-muted hover:text-ink"><X size={14} /></button>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-ink">{content ?? 'Loading...'}</pre>
        </div>
      )}
    </div>
  );
}

function DoorHistory({ archiveName }: { archiveName: string }) {
  const { data, isLoading } = useDoorAudit(archiveName, true);
  const entries = data?.entries ?? [];

  if (isLoading) return <p className="text-sm text-muted">Loading history...</p>;
  if (entries.length === 0) return <p className="text-sm text-muted">No edits recorded yet.</p>;

  function timeAgo(ts: number): string {
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function formatEntry(e: { action: string; detail: unknown }): string | null {
    const d = e.detail;
    if (!d || typeof d !== 'object') return null;
    switch (e.action) {
      case 'edit': {
        const { field, from, to } = d as { field?: string; from?: unknown; to?: unknown };
        if (field && to !== undefined) {
          const label = field.replace(/_/g, ' ');
          if (from === undefined || from === null) return `${label} set to "${String(to).slice(0, 60)}"`;
          return `${label}: "${String(from).slice(0, 30)}" → "${String(to).slice(0, 30)}"`;
        }
        return null;
      }
      case 'revert': {
        const { field } = d as { field?: string };
        return field ? `reverted ${field.replace(/_/g, ' ')}` : null;
      }
      case 'strip': {
        const { removed } = d as { removed?: number };
        return removed ? `stripped ${removed} file${removed !== 1 ? 's' : ''}` : null;
      }
      case 'edit-tags': {
        const { tags } = d as { tags?: string[] };
        return tags?.length ? `tags: ${tags.join(', ')}` : 'tags cleared';
      }
      case 'delete-files': {
        const { members } = d as { members?: string[] };
        if (members?.length) {
          const names = members.map((m) => m.split('/').pop() ?? m).slice(0, 2);
          return `deleted ${names.join(', ')}${members.length > 2 ? ` (+${members.length - 2} more)` : ''}`;
        }
        return null;
      }
      default:
        return null;
    }
  }

  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li key={e.id} className="rounded border border-line px-3 py-2 text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium capitalize text-ink">{e.action.replace(/-/g, ' ')}</span>
            <span className="text-muted">{timeAgo(e.at)}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted">by {e.by}</p>
          {formatEntry(e) && (
            <p className="mt-1 text-xs text-ink">{formatEntry(e)}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function StripAds({
  archiveName,
  preview,
  setPreview,
  stripPreviewQuery,
}: {
  archiveName: string;
  preview: StripPreview | null;
  setPreview: React.Dispatch<React.SetStateAction<StripPreview | null>>;
  stripPreviewQuery: ReturnType<typeof import('../api/queries').useStripPreview>;
}) {
  const stripArchive = useStripArchive(archiveName);
  const learnPattern = useLearnPattern();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ removed: number; newJunkCount: number } | null>(null);

  async function loadPreview() {
    const p = await stripPreviewQuery.mutateAsync();
    setPreview(p);
    setSelected(new Set(p.stripped.map((f) => f.path)));
    setResult(null);
  }

  async function learnKeptFile(path: string) {
    await learnPattern.mutateAsync({ pattern: path, archiveName, filePath: path });
    const p = await stripPreviewQuery.mutateAsync();
    setPreview(p);
    setSelected(new Set(p.stripped.map((f) => f.path)));
  }

  async function viewKeptFile(path: string) {
    try {
      const res = await fetch(`/api/door-repo/admin/doors/${encodeURIComponent(archiveName)}/files/${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('doorrepo.admin.token') ?? ''}` },
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch {}
  }

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function selectAll() {
    if (preview) setSelected(new Set(preview.stripped.map((f) => f.path)));
  }

  function selectNone() {
    setSelected(new Set());
  }

  async function doStrip() {
    const members = [...selected];
    // Empty list is allowed: marks the door as reviewed (server sets
    // ads_stripped=1) when the stripper found 0 ads to strip.
    const res = await stripArchive.mutateAsync(members);
    if (res.ok && res.removed != null && res.newJunkCount != null) {
      setResult({ removed: res.removed, newJunkCount: res.newJunkCount });
      setPreview(null);
    }
  }

  const isLoading = stripPreviewQuery.isPending;

  if (result) {
    return (
      <div className="rounded-md border border-ok/30 bg-ok/5 px-3 py-2 text-sm text-ok">
        Stripped {result.removed} file{result.removed !== 1 ? 's' : ''} — {result.newJunkCount} junk remaining
      </div>
    );
  }

  if (preview) {
    return (
      <div className="space-y-2 rounded-md border border-line px-3 py-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-ink">
            {preview.stripped.length} ad file{preview.stripped.length !== 1 ? 's' : ''} found
          </span>
          <div className="flex gap-1">
            <Button variant="ghost" onClick={selectAll}>All</Button>
            <Button variant="ghost" onClick={selectNone}>None</Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={doStrip}
              disabled={stripArchive.isPending}
            >
              {selected.size > 0 ? `Strip ${selected.size}` : 'Mark reviewed'}
            </Button>
          </div>
        </div>
        <ul className="max-h-48 space-y-0.5 overflow-y-auto">
          {preview.stripped.map((f) => (
            <li key={f.path} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={selected.has(f.path)}
                onChange={() => toggle(f.path)}
                className="accent-accent"
              />
              <span className="flex-1 truncate font-mono">{f.path}</span>
              <button onClick={() => viewKeptFile(f.path)} className="p-1 text-muted hover:text-accent" title="View file"><Eye size={12}/></button>
              <span className="text-muted">{preview.reason[f.path]}</span>
            </li>
          ))}
        </ul>
        {preview.kept.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs text-muted">{preview.kept.length} file{preview.kept.length !== 1 ? 's' : ''} kept</p>
            <ul className="max-h-32 space-y-0.5 overflow-y-auto">
              {preview.kept.map((f) => (
                <li key={f.path} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate font-mono text-muted">{f.path}</span>
              <button onClick={() => viewKeptFile(f.path)} className="p-1 text-muted hover:text-accent" title="View file"><Eye size={12}/></button>
                  <button
                    onClick={() => learnKeptFile(f.path)}
                    className="rounded p-1 text-muted hover:bg-raised hover:text-accent"
                    title="Learn as junk"
                  >
                    <GraduationCap size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <Button onClick={loadPreview} disabled={isLoading}>
      {isLoading ? 'Analyzing...' : 'Strip Ads'}
    </Button>
  );
}

const MULTILINE_FIELDS = new Set(['description', 'suggested_tooltypes', 'file_id_diz']);
/** FILE_ID.DIZ is a fixed 45-column by 10-row Amiga scene format. */
const FIELD_ROWS: Record<string, number> = { file_id_diz: 10 };
/** Fields whose scene casing the server can normalise for the curator. */
const TIDY_FIELDS = new Set(['name', 'description']);
/** Known BBS systems for the requires_bbs dropdown. */
const BBS_OPTIONS = [
  { value: '', label: '(none)' },
  { value: '/X', label: '/X (AmiExpress)' },
  { value: 'S!X', label: 'S!X' },
  { value: 'FAME', label: 'FAME' },
  { value: 'DayDream', label: 'DayDream' },
  { value: 'Tempest', label: 'Tempest' },
];

export function DoorDetailDialog({
  archiveName,
  admin,
  onClose,
}: {
  archiveName: string | null;
  admin: AdminUser | null;
  onClose: () => void;
}) {
  const { data: door, isLoading } = useDoor(archiveName);
  const { data: adminDoor } = useAdminDoor(archiveName, Boolean(admin));
  const save = useSaveField(archiveName ?? '');
  const revert = useRevertField(archiveName ?? '');
  const redescribe = useRedescribe(archiveName ?? '');
  const tidy = useTidyCase();
  const { data: doorTags } = useDoorTags(archiveName ?? '', Boolean(admin));
  const { data: allTagData } = useAllTags(Boolean(admin));
  const setTags = useSetDoorTags(archiveName ?? '');
  const { data: voteData } = useVoteStatus(archiveName ?? '', Boolean(archiveName));
  const vote = useVote(archiveName ?? '');
  const stripPreviewQuery = useStripPreview(archiveName ?? '');
  const [newTag, setNewTag] = useState('');
  const tagInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<DoorFacts | null>(null);
  const [stripPreview, setStripPreview] = useState<StripPreview | null>(null);
  const currentTags = doorTags?.tags ?? [];

  const addTag = useCallback(() => {
    const t = newTag.trim().toLowerCase();
    if (!t || currentTags.includes(t)) { setNewTag(''); return; }
    setTags.mutateAsync([...currentTags, t]).then(() => setNewTag(''));
  }, [newTag, currentTags, setTags]);

  const removeTag = useCallback((tag: string) => {
    setTags.mutateAsync(currentTags.filter((t) => t !== tag));
  }, [currentTags, setTags]);

  const suggestions = (allTagData?.tags ?? [])
    .map((t) => t.tag)
    .filter((t) => !currentTags.includes(t))
    .slice(0, 8);

  // Reset previews when switching to a different archive.
  useEffect(() => {
    setPreview(null);
    setStripPreview(null);
  }, [archiveName]);

  // Auto-start the stripper when an admin opens a door that hasn't been stripped yet.
  useEffect(() => {
    if (!admin || !archiveName || !door || door.adsStripped) return;
    if (stripPreviewQuery.isPending || stripPreviewQuery.isSuccess) return; // already running or done
    stripPreviewQuery.mutateAsync().catch(() => {});
  }, [admin, archiveName, door, stripPreviewQuery]);

  return (
    <Dialog.Root open={Boolean(archiveName)} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[min(60rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-lg font-semibold text-ink">
                {door?.name ?? archiveName}
              </Dialog.Title>
              <Dialog.Description className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="font-mono text-accent">{archiveName}</span>
                {door && <span>{formatSize(door.size)}</span>}
                {door?.doorType && <Badge>{door.doorType}</Badge>}
                {door?.requiresBbs && <Badge tone="accent">needs {door.requiresBbs}</Badge>}
                {door?.system && <span>{door.system}</span>}
              </Dialog.Description>
            </div>
            <div className="flex items-center gap-2">
              {door && (
                <div className="flex items-center gap-1 rounded-md border border-line px-1">
                  <button
                    onClick={() => vote.mutate(voteData?.myVote === 1 ? 0 : 1)}
                    className={`rounded p-1.5 transition-colors ${voteData?.myVote === 1 ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-raised hover:text-ink'}`}
                    disabled={vote.isPending}
                    title="Upvote"
                  >
                    <ThumbsUp size={14} />
                  </button>
                  <span className="min-w-[2ch] text-center text-sm font-mono text-ink">
                    {voteData ? voteData.score : (door.votesUp - door.votesDown)}
                  </span>
                  <button
                    onClick={() => vote.mutate(voteData?.myVote === -1 ? 0 : -1)}
                    className={`rounded p-1.5 transition-colors ${voteData?.myVote === -1 ? 'bg-danger/20 text-danger' : 'text-muted hover:bg-raised hover:text-ink'}`}
                    disabled={vote.isPending}
                    title="Downvote"
                  >
                    <ThumbsDown size={14} />
                  </button>
                </div>
              )}
              {door && (
                // A real link, not a button that navigates: the browser then
                // offers "save as", and the URL is copyable.
                <a
                  href={door.downloadUrl}
                  className="inline-flex items-center gap-2 rounded-md border border-accent-dim bg-accent-dim px-3 py-1.5 text-sm font-medium text-ink hover:bg-accent hover:text-bg"
                >
                  <Download size={14} /> Download
                </a>
              )}
              <Dialog.Close asChild>
                <Button variant="ghost" aria-label="Close">
                  <X size={16} />
                </Button>
              </Dialog.Close>
            </div>
          </header>

          <Tabs.Root defaultValue="about" className="flex min-h-0 flex-1 flex-col">
            <Tabs.List className="flex gap-1 border-b border-line px-4">
              {[
                ['about', 'About'],
                ['diz', 'FILE_ID.DIZ'],
                ['files', `Files${door ? ` (${door.files.length})` : ''}`],
                ...(door?.doc
                  ? [['doc', door.docFormat === 'amigaguide' ? 'Guide' : 'Documentation'] as const]
                  : []),
                ...(admin ? [['edit', 'Edit'] as const] : []),
                ...(admin ? [['history', 'History'] as const] : []),
              ].map(([value, label]) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  className="border-b-2 border-transparent px-3 py-2 text-sm text-muted data-[state=active]:border-accent data-[state=active]:text-ink"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {isLoading && <p className="text-sm text-muted">Reading the catalog...</p>}

              <Tabs.Content value="about" className="space-y-4">
                <p className="text-sm text-ink">{door?.description}</p>
                <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                  {[
                    ['Version', door?.version],
                    ['Author', door?.author],
                    ['Group', door?.releaseGroupFullName ?? door?.releaseGroup],
                    ['Category', door?.category],
                    ['Needs', door?.requiresBbs],
                    ['Type', door?.doorType],
                    ['MD5', door?.md5],
                  ].map(([label, value]) => (
                    <div key={label as string}>
                      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
                      <dd className="truncate font-mono text-[12px] text-ink">{(value as string) || '-'}</dd>
                    </div>
                  ))}
                </dl>
              </Tabs.Content>

              <Tabs.Content value="diz">
                <DizView text={door?.fileIdDiz ?? ''} label="FILE_ID.DIZ" />
              </Tabs.Content>

              <Tabs.Content value="files">
                <FileList archiveName={archiveName ?? ''} files={door?.files ?? []} />
              </Tabs.Content>

              {door?.doc && (
                <Tabs.Content value="doc">
                  {door.guide ? (
                    <GuideView guide={door.guide} />
                  ) : (
                    <DizView text={door.doc} label={door.docFilename ?? 'documentation'} />
                  )}
                </Tabs.Content>
              )}

              {admin && (
                <Tabs.Content value="edit" className="space-y-3">
                  {archiveName && <RemoveDoor archiveName={archiveName} hidden={Boolean(adminDoor?.hidden)} onRemoved={onClose} />}
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={() => redescribe.mutateAsync().then(setPreview)}
                      disabled={redescribe.isPending}
                    >
                      Re-read from the DIZ
                    </Button>
                    {preview && (
                      <p className="text-xs text-muted">
                        classifier says: <span className="font-mono text-ink">{preview.description}</span>
                      </p>
                    )}
                  </div>
                  {archiveName && (
                    <StripAds archiveName={archiveName} preview={stripPreview} setPreview={setStripPreview} stripPreviewQuery={stripPreviewQuery} />
                  )}
                  {adminDoor &&
                    Object.entries(adminDoor.fields).map(([field, state]) => (
                      <FieldEditor
                        key={field}
                        field={field}
                        state={state}
                        multiline={MULTILINE_FIELDS.has(field)}
                        rows={FIELD_ROWS[field]}
                        selectOptions={field === 'requires_bbs' ? BBS_OPTIONS : undefined}
                        onTidy={
                          TIDY_FIELDS.has(field)
                            ? (text) => tidy.mutateAsync({ text, mode: field === 'name' ? 'title' : 'sentence' }).then((res) => res.text)
                            : undefined
                        }
                        reverting={revert.isPending}
                        onSave={(value) => save.mutateAsync({ [field]: value })}
                        onRevert={() => revert.mutate(field)}
                      />
                    ))}
                  <div className="border-t border-line pt-3">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Tags</p>
                    <div className="flex flex-wrap gap-1.5">
                      {currentTags.map((tag) => (
                        <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-line bg-raised px-2.5 py-0.5 text-xs text-ink">
                          {tag}
                          <button onClick={() => removeTag(tag)} className="ml-0.5 text-muted hover:text-ink"><X size={10} /></button>
                        </span>
                      ))}
                      <input
                        ref={tagInputRef}
                        value={newTag}
                        onChange={(e) => setNewTag(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                        placeholder={currentTags.length === 0 ? 'Add tags...' : '+'}
                        className="min-w-[6rem] flex-1 border-0 bg-transparent py-0.5 text-xs text-ink outline-none placeholder:text-muted"
                      />
                    </div>
                    {setTags.isPending && <p className="mt-1 text-[10px] text-muted">Saving...</p>}
                    {suggestions.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {suggestions.map((s) => (
                          <button
                            key={s}
                            onClick={() => setTags.mutateAsync([...currentTags, s])}
                            className="rounded-full border border-dashed border-line px-2 py-0.5 text-[10px] text-muted hover:border-accent hover:text-accent"
                          >
                            +{s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </Tabs.Content>
              )}

              {admin && (
                <Tabs.Content value="history" className="space-y-3">
                  <DoorHistory archiveName={archiveName ?? ''} />
                </Tabs.Content>
              )}
            </div>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
// trigger rebuild
