/** Release group abbreviation → full name editor. Admin only. */
import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useState } from 'react';
import { useReleaseGroups, useUpdateReleaseGroup } from '../api/queries';
import { Button } from '../components/ui';

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
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');

  const groups = data?.groups ?? [];
  const filtered = filter
    ? groups.filter(
        (g) =>
          g.abbreviation.toLowerCase().includes(filter.toLowerCase()) ||
          g.full_name.toLowerCase().includes(filter.toLowerCase()),
      )
    : groups;

  const handleChange = useCallback((abbr: string, value: string) => {
    setDraft((prev) => ({ ...prev, [abbr]: value }));
  }, []);

  const handleSave = useCallback(
    (abbr: string) => {
      const value = draft[abbr];
      if (value === undefined) return;
      update.mutate({ [abbr]: value || null }, {
        onSuccess: () => {
          setDraft((prev) => {
            const next = { ...prev };
            delete next[abbr];
            return next;
          });
        },
      });
    },
    [draft, update],
  );

  const handleSaveAll = useCallback(() => {
    const changes: Record<string, string | null> = {};
    for (const [abbr, value] of Object.entries(draft)) {
      changes[abbr] = value || null;
    }
    if (Object.keys(changes).length === 0) return;
    update.mutate(changes, {
      onSuccess: () => setDraft({}),
    });
  }, [draft, update]);

  const dirtyCount = Object.keys(draft).length;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(40rem,94vw)] flex-col border-l border-line bg-surface shadow-2xl">
          <Dialog.Title className="border-b border-line px-5 py-4 text-lg font-semibold">
            Release Groups
            <span className="ml-2 text-sm font-normal text-muted">{groups.length} groups</span>
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Map release group abbreviations to their full names.
          </Dialog.Description>

          <div className="flex items-center gap-2 border-b border-line px-5 py-2">
            <input
              type="text"
              placeholder="Filter groups..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="flex-1 rounded border border-line bg-bg px-3 py-1.5 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
            {dirtyCount > 0 && (
              <Button onClick={handleSaveAll} disabled={update.isPending}>
                Save {dirtyCount} change{dirtyCount !== 1 ? 's' : ''}
              </Button>
            )}
          </div>

          <ul className="flex-1 divide-y divide-line overflow-y-auto text-sm">
            {filtered.map((group) => {
              const isDirty = draft[group.abbreviation] !== undefined;
              const currentValue = isDirty ? draft[group.abbreviation] : group.full_name;
              return (
                <li key={group.abbreviation} className="flex items-center gap-3 px-5 py-2">
                  <span className="w-16 shrink-0 font-mono text-[12px] font-medium text-accent">
                    {group.abbreviation}
                  </span>
                  <input
                    type="text"
                    value={currentValue}
                    onChange={(e) => handleChange(group.abbreviation, e.target.value)}
                    className={`flex-1 rounded border bg-bg px-2 py-1 font-mono text-[12px] text-ink focus:border-accent focus:outline-none ${
                      isDirty ? 'border-accent' : 'border-line'
                    }`}
                  />
                  {isDirty && (
                    <Button
                      variant="ghost"
                      onClick={() => handleSave(group.abbreviation)}
                      disabled={update.isPending}
                    >
                      Save
                    </Button>
                  )}
                </li>
              );
            })}
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
