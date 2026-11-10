/** Statistics dashboard over the BBS file listing. Mirrors Stats.tsx. */
import * as Dialog from '@radix-ui/react-dialog';
import { useReleaseStats } from '../api/releases';
import { BarChart, StatCard } from '../components/StatBits';

export function ReleaseStatsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading } = useReleaseStats(open);
  const uploaderPct =
    data && data.total > 0 ? ((data.withUploader / data.total) * 100).toFixed(1) : null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl sm:inset-y-8 sm:left-auto sm:right-8 sm:w-[min(48rem,94vw)]">
          <Dialog.Title className="border-b border-line px-5 py-4 text-lg font-semibold">
            BBS Files Statistics
          </Dialog.Title>
          <Dialog.Description className="sr-only">File listing overview and breakdowns.</Dialog.Description>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {isLoading && <p className="text-sm text-muted">Loading stats...</p>}
            {data && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="File entries" value={data.total} />
                  <StatCard label="Name an uploader" value={data.withUploader} />
                  <StatCard label="Have download counts" value={data.withDlCount} />
                  <StatCard label="Groups" value={data.byGroup.length} />
                </div>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">By Listing Flag</h3>
                  <BarChart data={data.byFlag} />
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">Top Groups</h3>
                  <BarChart data={data.byGroup} />
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">Top Uploaders</h3>
                  <p className="mb-2 text-xs text-muted">
                    Only {uploaderPct}% of entries name an uploader (Sent by / Uploaded by credits
                    and name trailers) — this chart covers that subset, not the whole listing.
                  </p>
                  <BarChart data={data.byUploader} />
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">Top Authors</h3>
                  <BarChart data={data.byAuthor} />
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">Size Distribution</h3>
                  <BarChart data={data.sizeDistribution} />
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">Entries Over Time</h3>
                  <BarChart data={data.overTime} maxItems={20} />
                </section>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
