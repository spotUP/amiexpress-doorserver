/** Per-archive detail for a finished background job (batch-reextract,
 *  batch-strip, ...) - the "N succeeded, M failed" summary only shows a
 *  count; this shows exactly which archives failed and why, so an admin
 *  can check the ones they're unsure about instead of guessing from the
 *  count alone. */
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useJobDetail } from '../api/queries';

export function JobResultsDialog({
  jobId,
  open,
  onOpenChange,
}: {
  jobId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
          <Dialog.Description className="sr-only">Per-archive outcome for this batch job.</Dialog.Description>
          {isLoading ? (
            <p className="px-5 py-8 text-center text-sm text-muted">Loading...</p>
          ) : !job ? (
            <p className="px-5 py-8 text-center text-sm text-muted">Job not found.</p>
          ) : (
            <ul className="flex-1 divide-y divide-line overflow-y-auto text-sm">
              {failed.map((item) => (
                <li key={item.archiveName} className="flex items-start gap-2 px-5 py-3">
                  <XCircle size={16} className="mt-0.5 shrink-0 text-danger" />
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-ink">{item.archiveName}</p>
                    <p className="mt-0.5 text-xs text-danger">{item.error}</p>
                  </div>
                </li>
              ))}
              {ok.map((item) => (
                <li key={item.archiveName} className="flex items-center gap-2 px-5 py-3">
                  <CheckCircle2 size={16} className="shrink-0 text-muted" />
                  <p className="truncate font-mono text-xs text-muted">{item.archiveName}</p>
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
