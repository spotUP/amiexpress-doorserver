/** Per-archive detail for a finished background job (batch-reextract,
 *  batch-strip, ...) - the "N succeeded, M failed" summary only shows a
 *  count; this shows exactly which archives failed and why, so an admin
 *  can check the ones they're unsure about instead of guessing from the
 *  count alone. Each row opens the existing single-door detail view (its
 *  own file browser/text preview already exists there - no need to
 *  rebuild one here) so an admin can look at what's actually inside an
 *  archive without leaving this list. */
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, Eye, XCircle } from 'lucide-react';
import { useJobDetail } from '../api/queries';

export function JobResultsDialog({
  jobId,
  open,
  onOpenChange,
  onOpenDoor,
}: {
  jobId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with an archive name when the admin wants to inspect its files -
   *  the caller is expected to open its existing single-door detail dialog. */
  onOpenDoor: (archiveName: string) => void;
}) {
  const { data: job, isLoading } = useJobDetail(open ? jobId : null);
  const failed = (job?.items ?? []).filter((i) => i.status === 'error');
  const ok = (job?.items ?? []).filter((i) => i.status === 'ok');

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(34rem,94vw)] flex-col border-l border-line bg-surface shadow-2xl">
          <Dialog.Title className="border-b border-line px-5 py-4 text-lg font-semibold">
            Job results
          </Dialog.Title>
          <Dialog.Description className="sr-only">Per-archive outcome for this batch job. Click an archive to view its files.</Dialog.Description>
          {isLoading ? (
            <p className="px-5 py-8 text-center text-sm text-muted">Loading...</p>
          ) : !job ? (
            <p className="px-5 py-8 text-center text-sm text-muted">Job not found.</p>
          ) : (
            <ul className="flex-1 divide-y divide-line overflow-y-auto text-sm">
              {failed.map((item) => (
                <li key={item.archiveName}>
                  <button
                    type="button"
                    onClick={() => onOpenDoor(item.archiveName)}
                    className="flex w-full items-start gap-2 px-5 py-3 text-left hover:bg-raised"
                  >
                    <XCircle size={16} className="mt-0.5 shrink-0 text-danger" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs text-ink">{item.archiveName}</p>
                      <p className="mt-0.5 text-xs text-danger">{item.error}</p>
                    </div>
                    <Eye size={14} className="mt-0.5 shrink-0 text-muted" />
                  </button>
                </li>
              ))}
              {ok.map((item) => (
                <li key={item.archiveName}>
                  <button
                    type="button"
                    onClick={() => onOpenDoor(item.archiveName)}
                    className="flex w-full items-center gap-2 px-5 py-3 text-left hover:bg-raised"
                  >
                    <CheckCircle2 size={16} className="shrink-0 text-muted" />
                    <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{item.archiveName}</p>
                    <Eye size={14} className="shrink-0 text-muted" />
                  </button>
                </li>
              ))}
              {job.items.length === 0 && (
                <li className="px-5 py-8 text-center text-muted">No items on this job.</li>
              )}
            </ul>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
