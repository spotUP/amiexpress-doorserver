/**
 * The site: search, filter, sort, open a door, download it. No login is ever
 * asked for on this path - the corpus is public, and reading it is the point.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eraser, Inbox, LogIn, LogOut, Search, Shield, Trash2, Upload, Wand2, BarChart3 } from 'lucide-react';
import { useBatchHide, useBatchPatch, useBatchRestore, useDoors, useFacets, useLiveRevision } from '../api/queries';
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
import { SavedSearches } from '../components/SavedSearches';
import { Button, Input, Select } from '../components/ui';

const PER_PAGE = 50;

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

  const batchHide = useBatchHide();
  const batchRestore = useBatchRestore();
  const batchPatch = useBatchPatch();

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
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleRange = useCallback((index: number, event: React.MouseEvent) => {
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
    setRangeBase(null);
    setSelected((prev) => {
      const rows = data?.rows ?? [];
      if (rows.every((d) => prev.has(d.archiveName))) return new Set();
      return new Set(rows.map((d) => d.archiveName));
    });
  }, [data]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setAnchorIndex(null);
    setRangeBase(null);
  }, []);

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

      {admin && selected.size > 0 && (
        <BatchToolbar
          count={selected.size}
          onHide={() => {
            const names = [...selected];
            batchHide.mutate(names.map((archiveName) => ({ archiveName, reason: 'batch hide' })), {
              onSuccess: () => clearSelection(),
            });
          }}
          onRestore={() => {
            batchRestore.mutate([...selected], {
              onSuccess: () => clearSelection(),
            });
          }}
          onRecategorize={(category) => {
            batchPatch.mutate(
              { archiveNames: [...selected], fields: { category } },
              { onSuccess: () => clearSelection() },
            );
          }}
          onFixCasing={() => {
            batchPatch.mutate(
              { archiveNames: [...selected], fields: { description: '__FIX_CASING__', name: '__FIX_TITLE_CASING__' } },
              { onSuccess: () => clearSelection() },
            );
          }}
          onClear={clearSelection}
          isPending={batchHide.isPending || batchRestore.isPending || batchPatch.isPending}
        />
      )}

      <DoorTable
        rows={data?.rows ?? []}
        sortState={sortState}
        onSort={sortBy}
        onOpen={(door: Door) => setOpen(door.archiveName)}
        selected={admin ? selected : undefined}
        onToggle={admin ? toggle : undefined}
        onToggleAll={admin ? toggleAll : undefined}
        onToggleRange={admin ? toggleRange : undefined}
      />

      <footer className="flex items-center justify-between gap-4 text-sm text-muted">
        <span>
          {isLoading ? 'Loading...' : data ? `Page ${data.page} of ${pages}` : ''}
        </span>
        <div className="flex gap-2">
          <Button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            Previous
          </Button>
          <Button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}>
            Next
          </Button>
        </div>
      </footer>

      <DoorDetailDialog archiveName={open} admin={admin} onClose={() => setOpen(null)} />
      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} onSignedIn={setAdmin} />
      <AuditPanel open={auditOpen} onOpenChange={setAuditOpen} enabled={Boolean(admin)} />
      <HiddenPanel open={hiddenOpen} onOpenChange={setHiddenOpen} enabled={Boolean(admin)} />
      <SubmissionsPanel open={queueOpen} onOpenChange={setQueueOpen} enabled={Boolean(admin)} />
      <ReleaseGroupsPanel open={groupsOpen} onOpenChange={setGroupsOpen} enabled={Boolean(admin)} />
      <StatsPanel open={statsOpen} onOpenChange={setStatsOpen} />
      <SubmitDialog open={submitOpen} onOpenChange={setSubmitOpen} />
    </div>
  );
}
