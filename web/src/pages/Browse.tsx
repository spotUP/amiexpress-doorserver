/**
 * The site: search, filter, sort, open a door, download it. No login is ever
 * asked for on this path - the corpus is public, and reading it is the point.
 */
import { useEffect, useMemo, useState } from 'react';
import { Inbox, LogIn, LogOut, Search, Shield, Trash2, Upload, Wand2 } from 'lucide-react';
import { useDoors, useFacets, useLiveRevision } from '../api/queries';
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
import { SubmitDialog } from '../components/SubmitDialog';
import { Button, Input, Select } from '../components/ui';

const PER_PAGE = 50;

export function Browse() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [system, setSystem] = useState('');
  const [type, setType] = useState('');
  const [requires, setRequires] = useState('');
  const [guessedOnly, setGuessedOnly] = useState(false);
  const [sortState, setSortState] = useState<SortState>({ sort: 'archive', dir: 'asc' });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);

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
      nameSource: guessedOnly ? 'archive' : undefined,
      sort: sortState.sort,
      dir: sortState.dir,
      page,
      perPage: PER_PAGE,
    }),
    [q, system, type, requires, guessedOnly, sortState, page]
  );
  const { data, isLoading } = useDoors(query);
  const { data: facets } = useFacets();

  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  function sortBy(key: string) {
    setSortState((prev) => ({ sort: key, dir: prev.sort === key && prev.dir === 'asc' ? 'desc' : 'asc' }));
    setPage(1);
  }

  function signOut() {
    setToken(null);
    setAdmin(null);
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[86rem] flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-4">
        {/* The scene logo the repository was given: ANSI art, so it only stays
            legible with nearest-neighbour scaling. */}
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
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setSubmitOpen(true)}>
              <Upload size={14} /> Send in a door
            </Button>
            {admin ? (
              <>
                <span className="text-xs text-muted">
                  signed in as <span className="text-ink">{admin.username}</span>
                </span>
                <Button variant="ghost" onClick={() => setQueueOpen(true)}>
                  <Inbox size={14} /> Submitted
                </Button>
                <Button variant="ghost" onClick={() => setHiddenOpen(true)}>
                  <Trash2 size={14} /> Removed
                </Button>
                <Button variant="ghost" onClick={() => setGroupsOpen(true)}>
                  Groups
                </Button>
                <Button variant="ghost" onClick={() => setAuditOpen(true)}>
                  <Shield size={14} /> Audit
                </Button>
                <Button variant="ghost" onClick={signOut}>
                  <LogOut size={14} /> Sign out
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setLoginOpen(true)}>
                <LogIn size={14} /> Curator sign-in
              </Button>
            )}
          </div>
        </div>
      </header>

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
        <Select
          ariaLabel="Filter by system"
          placeholder="Any system"
          value={system}
          onChange={(value) => {
            setSystem(value);
            setPage(1);
          }}
          options={(facets?.systems ?? []).map((f) => ({ value: f.value ?? '', label: `${f.value} (${f.n})` }))}
        />
        <Select
          ariaLabel="Filter by door type"
          placeholder="Any type"
          value={type}
          onChange={(value) => {
            setType(value);
            setPage(1);
          }}
          options={(facets?.types ?? []).map((f) => ({ value: f.value ?? '', label: `${f.value} (${f.n})` }))}
        />
        <Select
          ariaLabel="Filter by required BBS version"
          placeholder="Any BBS version"
          value={requires}
          onChange={(value) => {
            setRequires(value);
            setPage(1);
          }}
          options={(facets?.requires ?? []).map((f) => ({ value: f.value ?? '', label: `${f.value} (${f.n})` }))}
        />
        {admin && (
          // A curator's working view: the doors whose name had to be guessed
          // from the filename, which are the ones worth typing a real name
          // into.
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
      </div>

      <DoorTable
        rows={data?.rows ?? []}
        sortState={sortState}
        onSort={sortBy}
        onOpen={(door: Door) => setOpen(door.archiveName)}
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
      <SubmitDialog open={submitOpen} onOpenChange={setSubmitOpen} />
    </div>
  );
}
