/** Duplicate door detection panel. Admin only. */
import * as Dialog from '@radix-ui/react-dialog';
import { useDuplicates, type DuplicateGroup } from '../api/queries';

function DuplicateTable({
  title,
  groups,
  getKey,
}: {
  title: string;
  groups: DuplicateGroup[];
  getKey: (g: DuplicateGroup) => string;
}) {
  if (groups.length === 0) return null;
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-ink">{title} ({groups.length} groups)</h3>
      <div className="space-y-2">
        {groups.slice(0, 20).map((g) => (
          <div key={getKey(g)} className="rounded border border-line bg-bg px-3 py-2 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-ink">{g.n} copies</span>
              <span className="font-mono text-muted truncate">{getKey(g)}</span>
            </div>
            <p className="mt-1 text-muted">{g.archives}</p>
          </div>
        ))}
        {groups.length > 20 && (
          <p className="text-xs text-muted">...and {groups.length - 20} more groups</p>
        )}
      </div>
    </section>
  );
}

export function DuplicatesPanel({
  open,
  onOpenChange,
  enabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
}) {
  const { data, isLoading } = useDuplicates(enabled && open);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(40rem,94vw)] flex-col border-l border-line bg-surface shadow-2xl">
          <Dialog.Title className="border-b border-line px-5 py-4 text-lg font-semibold">
            Duplicates
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Doors with duplicate content detected by hash or name matching.
          </Dialog.Description>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {isLoading && <p className="text-sm text-muted">Scanning for duplicates...</p>}
            {data && (
              <div className="space-y-6">
                {data.byMd5.length === 0 && data.bySha256.length === 0 && data.byContent.length === 0 && (
                  <p className="text-sm text-muted">No duplicates found.</p>
                )}
                <DuplicateTable
                  title="By MD5 hash"
                  groups={data.byMd5}
                  getKey={(g) => String(g.md5)}
                />
                <DuplicateTable
                  title="By SHA-256 hash"
                  groups={data.bySha256}
                  getKey={(g) => String(g.sha256)}
                />
                <DuplicateTable
                  title="By name + author"
                  groups={data.byContent}
                  getKey={(g) => `${g.name} - ${g.author}`}
                />
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
