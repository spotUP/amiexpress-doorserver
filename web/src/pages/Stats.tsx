/** Statistics dashboard: charts and breakdowns of the catalog. */
import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { Button } from '../components/ui';

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

function BarChart({ data, maxItems = 10 }: { data: { value: string | null; n: number }[]; maxItems?: number }) {
  const items = data.slice(0, maxItems);
  const maxN = Math.max(...items.map((d) => d.n), 1);
  return (
    <div className="space-y-1">
      {items.map((item) => (
        <div key={item.value} className="flex items-center gap-2 text-xs">
          <span className="w-32 shrink-0 truncate text-right text-muted" title={item.value ?? ''}>
            {item.value ?? 'None'}
          </span>
          <div className="flex-1 overflow-hidden rounded bg-line">
            <div
              className="h-4 rounded bg-accent/60"
              style={{ width: `${(item.n / maxN) * 100}%` }}
            />
          </div>
          <span className="w-12 text-right font-mono text-muted">{item.n.toLocaleString()}</span>
        </div>
      ))}
      {data.length > maxItems && (
        <p className="text-xs text-muted">...and {data.length - maxItems} more</p>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 text-center">
      <p className="text-2xl font-semibold text-ink">{value.toLocaleString()}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
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
                  <h3 className="mb-2 text-sm font-medium text-ink">By System</h3>
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
