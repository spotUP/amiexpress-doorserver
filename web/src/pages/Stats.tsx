/** Statistics dashboard: charts and breakdowns of the catalog. */
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { BarChart, StatCard } from '../components/StatBits';

interface Stats {
  total: number;
  hiddenCount: number;
  withDoc: number;
  bySystem: { value: string | null; n: number }[];
  byGroup: { value: string | null; n: number }[];
  byCategory: { value: string | null; n: number }[];
  byType: { value: string | null; n: number }[];
  byAuthor: { value: string | null; n: number }[];
  sizeDistribution: { value: string | null; n: number }[];
  indexedOverTime: { value: string | null; n: number }[];
}

export function StatsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.get<Stats>('/stats'),
    enabled: open,
  });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl sm:inset-y-8 sm:left-auto sm:right-8 sm:w-[min(48rem,94vw)]">
          <Dialog.Title className="border-b border-line px-5 py-4 text-lg font-semibold">
            Statistics
          </Dialog.Title>
          <Dialog.Description className="sr-only">Catalog overview and breakdowns.</Dialog.Description>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {isLoading && <p className="text-sm text-muted">Loading stats...</p>}
            {data && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="Total doors" value={data.total} />
                  <StatCard label="With documentation" value={data.withDoc} />
                  <StatCard label="Hidden" value={data.hiddenCount} />
                  <StatCard label="Groups" value={data.byGroup.length} />
                </div>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">By Collection</h3>
                  <BarChart data={data.bySystem} />
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">Top Groups</h3>
                  <BarChart data={data.byGroup} />
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">By Category</h3>
                  <BarChart data={data.byCategory} />
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">By Type</h3>
                  <BarChart data={data.byType} />
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
                  <h3 className="mb-2 text-sm font-medium text-ink">Indexed Over Time</h3>
                  <BarChart data={data.indexedOverTime} maxItems={20} />
                </section>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
