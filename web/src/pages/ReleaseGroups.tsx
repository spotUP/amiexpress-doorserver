/** Release group abbreviation → full name editor. Admin only. */
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useReleaseGroups, useUpdateReleaseGroup } from '../api/queries';

export function ReleaseGroupsPanel({
  open,
  onOpenChange,
  enabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
}) {
  const { data } = useReleaseGroups(enabled && open);
  const update = useUpdateReleaseGroup();
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [newAbbr, setNewAbbr] = useState('');
  const [newName, setNewName] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const groups = data?.groups ?? [];
  const filtered = filter
    ? groups.filter(
        (g) =>
          g.abbreviation.toLowerCase().includes(filter.toLowerCase()) ||
          g.full_name.toLowerCase().includes(filter.toLowerCase()),
      )
    : groups;

  const scheduleSave = useCallback(
    (abbr: string, value: { fullName: string | null; newAbbreviation?: string }) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        update.mutate({ [abbr]: value });
      }, 600);
    },
    [update],
  );

  const handleDelete = useCallback(
    (abbr: string) => {
      update.mutate({ [abbr]: { fullName: null } });
    },
    [update],
  );

  const handleAdd = useCallback(() => {
    const abbr = newAbbr.trim().toUpperCase();
    const name = newName.trim();
    if (!abbr) {
      setAddError('abbreviation is required');
      return;
    }
    if (groups.some((g) => g.abbreviation.toUpperCase() === abbr)) {
      setAddError(`a group called "${abbr}" already exists`);
      return;
    }
    if (!name) {
      setAddError('full name is required');
      return;
    }
    update.mutate(
      { [abbr]: { fullName: name } },
      {
        onSuccess: () => {
          setAdding(false);
          setNewAbbr('');
          setNewName('');
          setAddError(null);
        },
        onError: (e: Error) => setAddError(e.message),
      },
    );
  }, [newAbbr, newName, groups, update]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(40rem,94vw)] flex-col border-l border-line bg-surface shadow-2xl">
          <Dialog.Title className="flex items-center justify-between border-b border-line px-5 py-4 text-lg font-semibold">
            <span>
              Release Groups
              <span className="ml-2 text-sm font-normal text-muted">{groups.length} groups</span>
            </span>
            <button
              type="button"
              onClick={() => {
                setAdding((a) => !a);
                setAddError(null);
              }}
              className="inline-flex items-center gap-1 rounded border border-line bg-bg px-2 py-1 text-xs font-medium text-ink hover:border-accent hover:text-accent"
              title="Add a new group"
            >
              <Plus size={14} /> Add
            </button>
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Map release group abbreviations to their full names.
          </Dialog.Description>

          {adding && (
            <div className="border-b border-line bg-bg/40 px-5 py-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="ABBR"
                  value={newAbbr}
                  onChange={(e) => setNewAbbr(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAdd();
                    if (e.key === 'Escape') {
                      setAdding(false);
                      setAddError(null);
                    }
                  }}
                  className="w-20 shrink-0 rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] font-medium text-accent focus:border-accent focus:outline-none"
                  maxLength={10}
                />
                <input
                  type="text"
                  placeholder="Full name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAdd();
                    if (e.key === 'Escape') {
                      setAdding(false);
                      setAddError(null);
                    }
                  }}
                  className="flex-1 rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={update.isPending}
                  className="rounded bg-accent px-3 py-1 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setNewAbbr('');
                    setNewName('');
                    setAddError(null);
                  }}
                  className="rounded p-1 text-muted hover:text-ink"
                  title="Cancel"
                >
                  ×
                </button>
              </div>
              {addError && (
                <div className="mt-2 text-xs text-red">{addError}</div>
              )}
            </div>
          )}

          <div className="border-b border-line px-5 py-2">
            <input
              type="text"
              placeholder="Filter groups..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full rounded border border-line bg-bg px-3 py-1.5 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>

          <ul className="flex-1 divide-y divide-line overflow-y-auto text-sm">
            {filtered.map((group) => (
              <li key={group.abbreviation} className="flex items-center gap-3 px-5 py-2">
                <input
                  type="text"
                  defaultValue={group.abbreviation}
                  onChange={(e) => {
                    const newAbbr = e.target.value.trim().toUpperCase();
                    if (!newAbbr || newAbbr === group.abbreviation) return;
                    scheduleSave(group.abbreviation, { fullName: group.full_name, newAbbreviation: newAbbr });
                  }}
                  className="w-16 shrink-0 rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] font-medium text-accent focus:border-accent focus:outline-none"
                />
                <input
                  type="text"
                  defaultValue={group.full_name}
                  onChange={(e) => scheduleSave(group.abbreviation, { fullName: e.target.value || null })}
                  className="flex-1 rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] text-ink focus:border-accent focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => handleDelete(group.abbreviation)}
                  className="rounded p-1 text-muted hover:bg-raised hover:text-red"
                  title="Remove this group"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-5 py-8 text-center text-muted">
                {filter ? 'No groups match that filter.' : 'No release groups in the database.'}
              </li>
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
