/**
 * Taking a door out of the repository, from the door's own dialog.
 *
 * Worth being plain about what this does, because it is not a delete: the
 * archive stays on disk and the catalog row stays in the database. The door
 * disappears from every listing and stops downloading, and one button puts
 * it back. That is deliberate - door_catalog is rewritten by every corpus
 * scan, so a real delete would undo itself.
 */
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useHideDoor, useRestoreDoor } from '../api/queries';
import { Button, Input } from './ui';

export function RemoveDoor({ archiveName, hidden, onRemoved }: { archiveName: string; hidden: boolean; onRemoved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const hide = useHideDoor(archiveName);
  const restore = useRestoreDoor();

  if (hidden) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-warn/40 bg-raised px-3 py-2">
        <p className="flex-1 text-sm text-warn">
          This door is out of the repository. It is not listed and its archive does not download.
        </p>
        <Button onClick={() => restore.mutate(archiveName)} disabled={restore.isPending}>
          <RotateCcw size={13} /> Put it back
        </Button>
      </div>
    );
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger asChild>
        <Button variant="danger">
          <Trash2 size={13} /> Remove from the repository
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-[60] bg-black/70" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-[61] w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-2xl">
          <AlertDialog.Title className="text-lg font-semibold">Remove {archiveName}?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-muted">
            It stops appearing in the listing, in list.txt, in index.tsv and in the manifest, and its archive
            stops downloading. The file itself is kept, and you can put the door back at any time.
          </AlertDialog.Description>
          <label className="mt-4 grid gap-1 text-sm">
            <span className="text-muted">Reason (optional, kept in the audit trail)</span>
            <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="duplicate, broken, not a door..." />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant="danger"
                onClick={() => hide.mutate(reason, { onSuccess: () => onRemoved?.() })}
                disabled={hide.isPending}
              >
                <Trash2 size={13} /> Remove
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
