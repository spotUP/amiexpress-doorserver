/**
 * The site: search, filter, sort, open a door, download it. No login is ever
 * asked for on this path - the corpus is public, and reading it is the point.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eraser, Inbox, LogIn, LogOut, RefreshCw, Search, Shield, Trash2, Upload, Wand2, BarChart3 } from 'lucide-react';
import {
  useBatchDelete,
  useBatchHide,
  useBatchPatch,
  useBatchReextract,
  useBatchRestore,
  useBatchStripApply,
  useBatchStripPreview,
  useBatchTags,
  useDoors,
  useFacets,
  useJobProgress,
  useLiveRevision,
  useMatchingArchiveNames,
  type StripPreviewResult,
} from '../api/queries';
import { getToken, setToken, setUnauthorizedHandler } from '../api/client';
import { api } from '../api/client';
import type { AdminUser, Door } from '../api/types';
import { DoorTable, type SortState } from '../components/DoorTable';
import { DoorDetailDialog } from '../components/DoorDetail';
import { LoginDialog } from '../components/LoginDialog';
import { AuditPanel } from './Audit';
import { HiddenPanel } from './Hidden';
import { SubmissionsPanel } from './Submissions';
import { ReleaseGroupsPanel } from './ReleaseGroups';
import { StatsPanel } from './Stats';
import { SubmitDialog } from '../components/SubmitDialog';
import { BatchToolbar } from '../components/BatchToolbar';
import { BatchStripReview } from '../components/BatchStripReview';
import { JobResultsDialog } from '../components/JobResultsDialog';
import { SavedSearches } from '../components/SavedSearches';
import { Button, Input, Select, ToastStack, type ToastMessage } from '../components/ui';

const PER_PAGE = 50;

let toastIdCounter = 0;

export function Browse() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [system, setSystem] = useState('');
  const [type, setType] = useState('');
  const [requires, setRequires] = useState('');
  const [guessedOnly, setGuessedOnly] = useState(false);
  const [unstrippedOnly, setUnstrippedOnly] = useState(false);
  const [latestOnly, setLatestOnly] = useState(false);
  const [sortState, setSortState] = useState<SortState>({ sort: 'indexed', dir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  // Snapshot of `selected` taken at the moment the anchor was set by a plain
  // click. Shift-clicks union range cells onto this base (not onto whatever
  // is currently selected), so repeated shift-clicks from the same anchor
  // are idempotent relative to the base and can both grow and shrink the
  // visible range.
  const [rangeBase, setRangeBase] = useState<Set<string> | null>(null);
  // True once the "select all N matching" fetch has replaced the page-only
  // selection with every archive name matching the current filters.
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  useLiveRevision();

  // Typing must not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  // A token in storage means a session that may still be good; ask who it is.
  useEffect(() => {
    setUnauthorizedHandler(() => setAdmin(null));
    if (!getToken()) return;
    api
      .get<{ user: AdminUser }>('/admin/me')
      .then((res) => setAdmin(res.user))
      .catch(() => setToken(null));
  }, []);

  const query = useMemo(
    () => ({
      q,
      system,
      type,
      requires,
      latest: latestOnly || undefined,
      nameSource: guessedOnly ? 'archive' : undefined,
      unstripped: unstrippedOnly || undefined,
      sort: sortState.sort,
      dir: sortState.dir,
      page,
      perPage: PER_PAGE,
    }),
    [q, system, type, requires, guessedOnly, unstrippedOnly, sortState, page]
  );
  const { data, isLoading } = useDoors(query);
  const { data: facets } = useFacets();

  // Transient feedback for the batch actions that have no other visible
  // result (no progress bar, no job) - they used to succeed or fail in
  // total silence.
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const pushToast = useCallback((text: string, variant: ToastMessage['variant'] = 'success') => {
    const id = toastIdCounter++;
    setToasts((prev) => [...prev, { id, text, variant }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const toastOnError = useCallback(
    (verb: string) => (err: unknown) => pushToast(`${verb} failed: ${err instanceof Error ? err.message : String(err)}`, 'error'),
    [pushToast]
  );

  const batchHide = useBatchHide();
  const batchRestore = useBatchRestore();
  const batchPatch = useBatchPatch();
  const batchTags = useBatchTags();
  const batchDelete = useBatchDelete();
  const batchReextract = useBatchReextract();
  const [reextractJobId, setReextractJobId] = useState<string | null>(null);
  const batchStripPreview = useBatchStripPreview();
  const batchStripApply = useBatchStripApply();
  const [stripPreviewJobId, setStripPreviewJobId] = useState<string | null>(null);
  const [stripApplyJobId, setStripApplyJobId] = useState<string | null>(null);
  const [stripCandidates, setStripCandidates] = useState<StripPreviewResult[] | null>(null);
  const stripPreviewProgress = useJobProgress(stripPreviewJobId);
  const stripApplyProgress = useJobProgress(stripApplyJobId);
  const matchingNames = useMatchingArchiveNames();
  // Once a strip-apply job finishes with failures, keep a summary visible
  // instead of reverting straight to the normal toolbar/review screen and
  // discarding failedCount. Reset whenever a new apply job starts.
  const [stripApplySummaryDismissed, setStripApplySummaryDismissed] = useState(false);
  useEffect(() => {
    setStripApplySummaryDismissed(false);
  }, [stripApplyJobId]);
  const [stripApplyResultsOpen, setStripApplyResultsOpen] = useState(false);

  // Once the preview job finishes, fetch its resultJson and hand the parsed
  // candidates to the review screen. stripPreviewJobId is cleared in the same
  // update so this effect doesn't refire once the fetch lands (useJobProgress
  // returns null once its jobId argument goes null, so the guard holds even
  // across the render where the clear takes effect). A 'failed' job (see
  // batch-jobs.ts's top-level backstop) has no review screen to show - drop
  // back to the toolbar rather than leaving the progress indicator spinning
  // on a status it never expects to move on from.
  useEffect(() => {
    if (!stripPreviewJobId || !stripPreviewProgress) return;
    if (stripPreviewProgress.status === 'done') {
      const jobId = stripPreviewJobId;
      // resultJson is a nullable TEXT column; setJobResult should always
      // have been called by the time a strip-preview job reaches 'done', but
      // guard the type-lie anyway rather than calling JSON.parse(null).
      api.get<{ resultJson: string | null }>(`/admin/jobs/${jobId}`).then((job) => {
        const candidates = job.resultJson ? (JSON.parse(job.resultJson) as StripPreviewResult[]) : [];
        setStripCandidates(candidates);
        setStripPreviewJobId(null);
      });
    } else if (stripPreviewProgress.status === 'failed') {
      setStripPreviewJobId(null);
    }
  }, [stripPreviewProgress, stripPreviewJobId]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  function sortBy(key: string) {
    setSortState((prev) => ({ sort: key, dir: prev.sort === key && prev.dir === 'asc' ? 'desc' : 'asc' }));
    setPage(1);
  }

  function signOut() {
    setToken(null);
    setAdmin(null);
  }

  const toggle = useCallback((name: string) => {
    setSelectAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleRange = useCallback((index: number, event: React.MouseEvent) => {
    setSelectAllMatching(false);
    const rows = data?.rows ?? [];
    const name = rows[index]?.archiveName;
    if (!name) return;
    if (event.shiftKey && anchorIndex !== null) {
      const [lo, hi] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
      const next = new Set(rangeBase ?? []);
      for (let i = lo; i <= hi; i++) {
        const n = rows[i]?.archiveName;
        if (n) next.add(n);
      }
      setSelected(next);
      // Anchor and rangeBase stay put on a shift-click, so repeated
      // shift-clicks against the same origin are idempotent relative to the
      // base snapshot and can both extend and shrink the range.
      return;
    }
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
    setRangeBase(next);
    setAnchorIndex(index);
  }, [data, anchorIndex, rangeBase, selected]);

  const toggleAll = useCallback(() => {
    setSelectAllMatching(false);
    setRangeBase(null);
    setSelected((prev) => {
      const rows = data?.rows ?? [];
      if (rows.every((d) => prev.has(d.archiveName))) return new Set();
      return new Set(rows.map((d) => d.archiveName));
    });
  }, [data]);

  const clearSelection = useCallback(() => {
    setSelectAllMatching(false);
    setSelected(new Set());
    setAnchorIndex(null);
    setRangeBase(null);
  }, []);

  const selectAllFiltered = useCallback(() => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (system) params.set('system', system);
    if (type) params.set('type', type);
    if (requires) params.set('requires', requires);
    if (latestOnly) params.set('latest', '1');
    if (guessedOnly) params.set('name_source', 'archive');
    if (unstrippedOnly) params.set('unstripped', '1');
    // NOTE: keep this param list in sync with toSearch() in api/queries.ts,
    // which is what useDoors() itself sends for the current filter state.
    matchingNames.mutate(params, {
      onSuccess: (res) => {
        setSelected(new Set(res.archiveNames));
        setSelectAllMatching(true);
      },
    });
  }, [q, system, type, requires, latestOnly, guessedOnly, unstrippedOnly, matchingNames]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[86rem] flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-4">
        <h1 className="m-0">
          <img
            src="/logo.png"
            alt="Up Rough Door Repository - doors.uprough.net"
            width={1248}
            height={396}
            className="mx-auto w-full max-w-[46rem] [image-rendering:pixelated]"
          />
        </h1>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-muted">
              {data ? `${data.total.toLocaleString()} AmiExpress doors` : 'Reading the catalog...'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => setSubmitOpen(true)}>
              <Upload size={14} /> <span className="hidden sm:inline">Send in a door</span><span className="sm:hidden">Send</span>
            </Button>
            <Button variant="ghost" onClick={() => setStatsOpen(true)}>
              <BarChart3 size={14} /> <span className="hidden sm:inline">Stats</span>
            </Button>
            {admin ? (
              <>
                <span className="hidden text-xs text-muted sm:inline">
                  signed in as <span className="text-ink">{admin.username}</span>
                </span>
                <Button variant="ghost" onClick={() => setQueueOpen(true)}>
                  <Inbox size={14} /> <span className="hidden sm:inline">Submitted</span>
                </Button>
                <Button variant="ghost" onClick={() => setHiddenOpen(true)}>
                  <Trash2 size={14} /> <span className="hidden sm:inline">Removed</span>
                </Button>
                <Button variant="ghost" onClick={() => setGroupsOpen(true)} className="hidden sm:inline-flex">
                  Groups
                </Button>
                <Button variant="ghost" onClick={() => setAuditOpen(true)} className="hidden sm:inline-flex">
                  <Shield size={14} /> Audit
                </Button>
                <Button variant="ghost" onClick={signOut} className="hidden sm:inline-flex">
                  <LogOut size={14} /> Sign out
                </Button>
                {/* Mobile overflow menu */}
                <details className="relative sm:hidden">
                  <summary className="cursor-pointer list-none rounded border border-line px-2 py-1 text-xs text-muted">More</summary>
                  <div className="absolute right-0 z-30 mt-1 w-40 rounded-lg border border-line bg-surface shadow-lg">
                    <button onClick={() => { setGroupsOpen(true); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-raised">Groups</button>
                    <button onClick={() => { setAuditOpen(true); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-raised">Audit</button>
                    <button onClick={signOut} className="block w-full px-3 py-2 text-left text-sm hover:bg-raised">Sign out</button>
                  </div>
                </details>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setLoginOpen(true)}>
                <LogIn size={14} /> <span className="hidden sm:inline">Curator sign-in</span><span className="sm:hidden">Sign in</span>
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search names, authors, groups, and the DIZ text"
              aria-label="Search doors"
              className="pl-9"
            />
          </div>
          <details className="relative md:hidden">
            <summary className="cursor-pointer list-none rounded border border-line px-3 py-1.5 text-xs text-muted hover:bg-raised">
              Filters{(system || type || requires) ? ' *' : ''}
            </summary>
            <div className="absolute right-0 z-30 mt-1 flex flex-wrap gap-2 rounded-lg border border-line bg-surface p-2 shadow-lg">
              <Select
                ariaLabel="Filter by collection"
                placeholder="Any collection"
                value={system}
                onChange={(v) => { setSystem(v); setPage(1); }}
                options={(facets?.systems ?? []).map((f) => ({ value: f.value ?? '', label: `${f.value} (${f.n})` }))}
              />
              <Select
                ariaLabel="Filter by door type"
                placeholder="Any type"
                value={type}
                onChange={(v) => { setType(v); setPage(1); }}
                options={(facets?.types ?? []).map((f) => ({ value: f.value ?? '', label: `${f.value} (${f.n})` }))}
              />
              <Select
                ariaLabel="Filter by required BBS version"
                placeholder="Any BBS version"
                value={requires}
                onChange={(v) => { setRequires(v); setPage(1); }}
                options={(facets?.requires ?? []).map((f) => ({ value: f.value ?? '', label: `${f.value} (${f.n})` }))}
              />
            </div>
          </details>
          <div className="hidden items-center gap-2 md:flex">
            <Select
              ariaLabel="Filter by collection"
              placeholder="Any collection"
              value={system}
              onChange={(value) => { setSystem(value); setPage(1); }}
              options={(facets?.systems ?? []).map((f) => ({ value: f.value ?? '', label: `${f.value} (${f.n})` }))}
            />
            <Select
              ariaLabel="Filter by door type"
              placeholder="Any type"
              value={type}
              onChange={(value) => { setType(value); setPage(1); }}
              options={(facets?.types ?? []).map((f) => ({ value: f.value ?? '', label: `${f.value} (${f.n})` }))}
            />
            <Select
              ariaLabel="Filter by required BBS version"
              placeholder="Any BBS version"
              value={requires}
              onChange={(value) => { setRequires(value); setPage(1); }}
              options={(facets?.requires ?? []).map((f) => ({ value: f.value ?? '', label: `${f.value} (${f.n})` }))}
            />
          </div>
        {admin && (
          <Button
            variant={guessedOnly ? 'primary' : 'ghost'}
            onClick={() => {
              setGuessedOnly((on) => !on);
              setPage(1);
            }}
            title="Doors whose name was guessed from the archive filename"
          >
            <Wand2 size={14} /> Needs a name
          </Button>
        )}
        {admin && (
          <Button
            variant={unstrippedOnly ? 'primary' : 'ghost'}
            onClick={() => {
              setUnstrippedOnly((on) => !on);
              setPage(1);
            }}
            title="Doors whose ads have not been reviewed/stripped yet"
          >
            <Eraser size={14} /> Needs ad review
          </Button>
        )}
        <Button
          variant={latestOnly ? 'primary' : 'ghost'}
          onClick={() => {
            setLatestOnly((on) => !on);
            setPage(1);
          }}
          title="Show only the newest version of each door"
        >
          Latest only
        </Button>
        <SavedSearches
          query={q}
          system={system}
          type={type}
          requires={requires}
          onApply={(s) => {
            setSearch(s.query);
            setQ(s.query);
            setSystem(s.system);
            setType(s.type);
            setRequires(s.requires);
            setPage(1);
          }}
        />
      </div>
      </div>

      {admin && stripApplyJobId && stripApplyProgress && stripApplyProgress.status === 'running' ? (
        <div className="flex items-center gap-3 rounded-lg border border-accent bg-accent/5 px-4 py-2 text-sm">
          <RefreshCw size={14} className="animate-spin text-accent" />
          <span>Stripping {stripApplyProgress.completed} / {stripApplyProgress.total}</span>
          {stripApplyProgress.failedCount > 0 && <span className="text-danger">{stripApplyProgress.failedCount} failed</span>}
        </div>
      ) : admin && stripApplyJobId && stripApplyProgress &&
          (stripApplyProgress.failedCount > 0 || stripApplyProgress.status === 'failed') &&
          !stripApplySummaryDismissed ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-accent bg-accent/5 px-4 py-2 text-sm">
          <span>
            {stripApplyProgress.status === 'failed' ? 'Strip stopped unexpectedly: ' : 'Strip finished: '}
            {stripApplyProgress.completed - stripApplyProgress.failedCount} succeeded,{' '}
            <span className="text-danger">{stripApplyProgress.failedCount} failed</span>
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setStripApplyResultsOpen(true)}>View results</Button>
            <Button variant="ghost" onClick={() => setStripApplySummaryDismissed(true)}>Dismiss</Button>
          </div>
        </div>
      ) : admin && (batchStripPreview.isPending || (stripPreviewJobId && (!stripPreviewProgress || stripPreviewProgress.status === 'running'))) ? (
        <div className="flex items-center gap-3 rounded-lg border border-accent bg-accent/5 px-4 py-2 text-sm">
          <RefreshCw size={14} className="animate-spin text-accent" />
          <span>
            {stripPreviewProgress
              ? `Previewing strip candidates ${stripPreviewProgress.completed} / ${stripPreviewProgress.total}`
              : 'Starting strip preview...'}
          </span>
        </div>
      ) : admin && stripCandidates ? (
        <BatchStripReview
          candidates={stripCandidates}
          onCancel={() => setStripCandidates(null)}
          onConfirm={(selections) => {
            setStripCandidates(null);
            batchStripApply.mutate(selections, { onSuccess: (res) => setStripApplyJobId(res.jobId) });
          }}
        />
      ) : admin && selected.size > 0 ? (
        <BatchToolbar
          count={selected.size}
          onHide={() => {
            const names = [...selected];
            batchHide.mutate(names.map((archiveName) => ({ archiveName, reason: 'batch hide' })), {
              onSuccess: () => { clearSelection(); pushToast(`Hid ${names.length} door${names.length === 1 ? '' : 's'}`); },
              onError: toastOnError('Hide'),
            });
          }}
          onRestore={() => {
            const names = [...selected];
            batchRestore.mutate(names, {
              onSuccess: () => { clearSelection(); pushToast(`Restored ${names.length} door${names.length === 1 ? '' : 's'}`); },
              onError: toastOnError('Restore'),
            });
          }}
          onSetField={(field, value) => {
            const names = [...selected];
            batchPatch.mutate(
              { archiveNames: names, fields: { [field]: value } },
              {
                onSuccess: () => { clearSelection(); pushToast(`Set ${field} on ${names.length} door${names.length === 1 ? '' : 's'}`); },
                onError: toastOnError('Field update'),
              },
            );
          }}
          onFixCasing={() => {
            const names = [...selected];
            batchPatch.mutate(
              { archiveNames: names, fields: { description: '__FIX_CASING__', name: '__FIX_TITLE_CASING__' } },
              {
                onSuccess: () => { clearSelection(); pushToast(`Fixed casing on ${names.length} door${names.length === 1 ? '' : 's'}`); },
                onError: toastOnError('Fix casing'),
              },
            );
          }}
          onTagsChange={(add, remove) => {
            const names = [...selected];
            batchTags.mutate(
              { archiveNames: names, add, remove },
              {
                onSuccess: () => pushToast(`Tags updated on ${names.length} door${names.length === 1 ? '' : 's'}`),
                onError: toastOnError('Tag update'),
              },
            );
          }}
          onDelete={(confirm) => {
            const names = [...selected];
            batchDelete.mutate(
              { archiveNames: names, confirm },
              {
                onSuccess: () => { clearSelection(); pushToast(`Deleted ${names.length} door${names.length === 1 ? '' : 's'}`); },
                onError: toastOnError('Delete'),
              },
            );
          }}
          onReextract={() => {
            batchReextract.mutate([...selected], { onSuccess: (res) => setReextractJobId(res.jobId) });
          }}
          reextractJobId={reextractJobId}
          onStripPreview={() => {
            batchStripPreview.mutate([...selected], { onSuccess: (res) => setStripPreviewJobId(res.jobId) });
          }}
          onClear={clearSelection}
          isPending={
            batchHide.isPending ||
            batchRestore.isPending ||
            batchPatch.isPending ||
            batchTags.isPending ||
            batchDelete.isPending ||
            batchReextract.isPending ||
            batchStripPreview.isPending
          }
        />
      ) : null}

      <DoorTable
        rows={data?.rows ?? []}
        sortState={sortState}
        onSort={sortBy}
        onOpen={(door: Door) => setOpen(door.archiveName)}
        selected={admin ? selected : undefined}
        onToggle={admin ? toggle : undefined}
        onToggleAll={admin ? toggleAll : undefined}
        onToggleRange={admin ? toggleRange : undefined}
        // "Needs a name" (guessedOnly) filters name_source in-process on the
        // main listing, so data.total IS correctly filtered by it - but
        // GET /doors?fields=archiveName (what "select all N matching" fetches)
        // does NOT apply name_source (see src/public-routes.ts). Showing the
        // count here while hiding it from the button's actual query would let
        // "Select all N matching" report a number it doesn't select. Hide the
        // button under this filter rather than show a lying count; page-only
        // multi-select still works fine.
        totalMatching={guessedOnly ? undefined : data?.total}
        onSelectAllMatching={selectAllFiltered}
        selectAllMatchingActive={selectAllMatching}
      />

      <footer className="flex items-center justify-between gap-4 text-sm text-muted">
        <span>
          {isLoading ? 'Loading...' : data ? `Page ${data.page} of ${pages}` : ''}
        </span>
        <div className="flex items-center gap-2">
          <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            Previous
          </Button>
          <Select
            value={String(page)}
            onChange={(v) => setPage(Number(v))}
            options={Array.from({ length: pages }, (_, i) => ({ value: String(i + 1), label: `Page ${i + 1}` }))}
            placeholder="Page"
            ariaLabel="Jump to page"
            required
          />
          <input
            type="number"
            min={1}
            max={pages}
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const n = Number.parseInt(pageInput, 10);
              if (Number.isFinite(n)) setPage(Math.min(Math.max(n, 1), pages));
              setPageInput('');
            }}
            placeholder="Go to..."
            className="w-20 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            aria-label="Type a page number and press Enter"
          />
          <Button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>
            Next
          </Button>
        </div>
      </footer>

      <DoorDetailDialog archiveName={open} admin={admin} onClose={() => setOpen(null)} />
      <JobResultsDialog
        jobId={stripApplyJobId}
        open={stripApplyResultsOpen}
        onOpenChange={setStripApplyResultsOpen}
        onOpenDoor={(archiveName) => setOpen(archiveName)}
      />
      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} onSignedIn={setAdmin} />
      <AuditPanel open={auditOpen} onOpenChange={setAuditOpen} enabled={Boolean(admin)} />
      <HiddenPanel open={hiddenOpen} onOpenChange={setHiddenOpen} enabled={Boolean(admin)} />
      <SubmissionsPanel open={queueOpen} onOpenChange={setQueueOpen} enabled={Boolean(admin)} />
      <ReleaseGroupsPanel open={groupsOpen} onOpenChange={setGroupsOpen} enabled={Boolean(admin)} />
      <StatsPanel open={statsOpen} onOpenChange={setStatsOpen} />
      <SubmitDialog open={submitOpen} onOpenChange={setSubmitOpen} />
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
