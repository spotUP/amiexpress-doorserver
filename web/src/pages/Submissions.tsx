/** The queue: what strangers have sent in, and the two decisions. */
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { useApproveSubmission, useRejectSubmission, useSubmissions } from '../api/queries';
import { Button, Input, formatSize } from '../components/ui';

export function SubmissionsPanel({
  open,
  onOpenChange,
  enabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
}) {
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const { data } = useSubmissions(status, enabled && open);
  const approve = useApproveSubmission();
  const reject = useRejectSubmission();
  const busy = approve.isPending || reject.isPending;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(38rem,96vw)] flex-col border-l border-line bg-surface shadow-2xl">
          <div className="border-b border-line px-5 py-4">
            <Dialog.Title className="text-lg font-semibold">Submitted doors</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted">
              Nothing here is in the repository yet. Approving moves the archive in; rejecting deletes it.
            </Dialog.Description>
            <div className="mt-3 flex gap-1">
              {(['pending', 'approved', 'rejected'] as const).map((value) => (
                <Button
                  key={value}
                  variant={status === value ? 'primary' : 'ghost'}
                  onClick={() => setStatus(value)}
                >
                  {value}
                </Button>
              ))}
            </div>
          </div>

          <ul className="flex-1 divide-y divide-line overflow-y-auto text-sm">
            {(data?.rows ?? []).map((row) => (
              <li key={row.id} className="px-5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-[12px] text-accent">{row.archiveName}</span>
                  <span className="text-xs text-muted">{formatSize(row.size)}</span>
                </div>
                {row.derived && (
                  // What the archive says it is. A curator approves a door,
                  // not a filename.
                  <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-0.5 rounded-md border border-line bg-bg px-3 py-2 text-xs">
                    {[
                      ['Name', row.derived.name],
                      ['Version', row.derived.version],
                      ['Needs', row.derived.requiresBbs],
                      ['Author', row.derived.author],
                      ['Description', row.derived.description],
                      ['Files', `${row.derived.files.length}`],
                    ].map(([label, value]) => (
                      <div key={label} className="contents">
                        <dt className="text-muted">{label}</dt>
                        <dd className="truncate text-ink">{value || '-'}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {row.derived && !row.derived.fileIdDiz && !row.derived.submitterProvided && (
                  <p className="mt-1 text-xs text-warn">
                    No FILE_ID.DIZ could be read from this archive - the fields above are guesses from its name.
                  </p>
                )}
                {row.derived && !row.derived.fileIdDiz && row.derived.submitterProvided && (
                  <p className="mt-1 text-xs text-muted">
                    No FILE_ID.DIZ could be read from this archive - the fields above are what the submitter typed in.
                  </p>
                )}
                {row.note && <p className="mt-1 text-muted">{row.note}</p>}
                <p className="mt-1 font-mono text-[11px] text-muted">md5 {row.md5}</p>
                <p className="text-xs text-muted">
                  sent {new Date(row.createdAt * 1000).toLocaleString()}
                  {row.decidedBy && ` - ${row.status} by ${row.decidedBy}`}
                  {row.rejectReason && `: ${row.rejectReason}`}
                </p>
                {row.status === 'pending' && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      value={reasons[row.id] ?? ''}
                      onChange={(event) => setReasons((prev) => ({ ...prev, [row.id]: event.target.value }))}
                      placeholder="reason, if you turn it down"
                      className="max-w-[16rem]"
                    />
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => reject.mutate({ id: row.id, reason: reasons[row.id] ?? '' })}
                    >
                      <X size={13} /> Reject
                    </Button>
                    <Button variant="primary" disabled={busy} onClick={() => approve.mutate(row.id)}>
                      <Check size={13} /> Approve
                    </Button>
                  </div>
                )}
              </li>
            ))}
            {data?.rows.length === 0 && (
              <li className="px-5 py-8 text-center text-muted">Nothing {status}.</li>
            )}
          </ul>
          {(approve.isError || reject.isError) && (
            <p className="border-t border-line px-5 py-3 text-sm text-danger">
              {((approve.error ?? reject.error) as Error).message}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
