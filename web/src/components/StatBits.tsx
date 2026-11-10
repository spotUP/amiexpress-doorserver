/** Shared bits for the stats/facts dashboards: one source, three panels. */

export function BarChart({ data, maxItems = 10 }: { data: { value: string | null; n: number }[]; maxItems?: number }) {
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

export function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3 text-center">
      <p className="text-2xl font-semibold text-ink">{value.toLocaleString()}</p>
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}
