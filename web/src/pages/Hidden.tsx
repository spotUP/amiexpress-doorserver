/** What has been taken out of the repository, and the way back. */
import * as Dialog from '@radix-ui/react-dialog';
import { RotateCcw } from 'lucide-react';
import { useHiddenDoors, useRestoreDoor } from '../api/queries';
import { Button } from '../components/ui';

export function HiddenPanel({
  open,
  onOpenChange,
  enabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
}) {
  const { data } = useHiddenDoors(enabled && open);
  const restore = useRestoreDoor();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(34rem,94vw)] flex-col border-l border-line bg-surface shadow-2xl">
          <Dialog.Title className="border-b border-line px-5 py-4 text-lg font-semibold">
            Removed doors
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Doors taken out of the repository, with the reason and a way to put them back.
          </Dialog.Description>
          <ul className="flex-1 divide-y divide-line overflow-y-auto text-sm">
            {(data?.rows ?? []).map((entry) => (
              <li key={entry.archiveName} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[12px] text-accent">{entry.archiveName}</p>
                  <p className="truncate text-muted">{entry.reason || 'no reason given'}</p>
                  <p className="mt-1 text-xs text-muted">
                    removed by {entry.hiddenBy ?? 'a removed account'} on{' '}
                    {new Date(entry.hiddenAt * 1000).toLocaleDateString()}
                  </p>
                </div>
                <Button onClick={() => restore.mutate(entry.archiveName)} disabled={restore.isPending}>
                  <RotateCcw size={13} /> Restore
                </Button>
              </li>
            ))}
            {data?.rows.length === 0 && (
              <li className="px-5 py-8 text-center text-muted">Nothing has been removed.</li>
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
