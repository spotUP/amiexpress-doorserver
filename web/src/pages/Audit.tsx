/** Who changed what. Read-only, and only visible to a signed-in curator. */
import * as Dialog from '@radix-ui/react-dialog';
import { useAudit } from '../api/queries';

export function AuditPanel({
  open,
  onOpenChange,
  enabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
}) {
  const { data } = useAudit(enabled && open);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(34rem,94vw)] flex-col border-l border-line bg-surface shadow-2xl">
          <Dialog.Title className="border-b border-line px-5 py-4 text-lg font-semibold">Audit trail</Dialog.Title>
          <Dialog.Description className="sr-only">Every change made through the admin console.</Dialog.Description>
          <ul className="flex-1 divide-y divide-line overflow-y-auto text-sm">
            {(data?.rows ?? []).map((entry) => (
              <li key={entry.id} className="px-5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-ink">{entry.action}</span>
                  <time className="text-xs text-muted">{new Date(entry.at * 1000).toLocaleString()}</time>
                </div>
                <p className="mt-1 font-mono text-[12px] text-muted">{entry.target}</p>
                {entry.detail !== null && (
                  <pre className="mt-1 overflow-x-auto font-mono text-[11px] text-muted">
                    {JSON.stringify(entry.detail)}
                  </pre>
                )}
                <p className="mt-1 text-xs text-muted">by {entry.by ?? 'a removed account'}</p>
              </li>
            ))}
            {data?.rows.length === 0 && <li className="px-5 py-8 text-center text-muted">Nothing has changed yet.</li>}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
