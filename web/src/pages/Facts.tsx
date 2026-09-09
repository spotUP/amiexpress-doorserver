/** Fun facts squeezed out of the BBS file listing: records, eras, habits. */
import * as Dialog from '@radix-ui/react-dialog';
import { useReleaseFacts, type FactsFile } from '../api/releases';
import { BarChart, StatCard } from '../components/StatBits';
import { DizView } from '../components/DizView';
import { formatSize } from '../components/ui';

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function FileRef({ file, extra }: { file: FactsFile; extra?: string }) {
  return (
    <p className="text-sm">
      <span className="font-mono text-[13px] text-accent">{file.filename}</span>{' '}
      <span className="text-muted">
        uploaded {file.dateIso} (dir #{file.dirNo}, file #{file.fileNo}){extra ? ` — ${extra}` : ''}
      </span>
    </p>
  );
}

export function FactsPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading } = useReleaseFacts(open);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed inset-4 z-50 flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl sm:inset-y-8 sm:left-auto sm:right-8 sm:w-[min(48rem,94vw)]">
          <Dialog.Title className="border-b border-line px-5 py-4 text-lg font-semibold">
            BBS Files Fun Facts
          </Dialog.Title>
          <Dialog.Description className="sr-only">
            Headline records and trends from the file listing.
          </Dialog.Description>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {isLoading && <p className="text-sm text-muted">Digging through the listing...</p>}
            {data && (
              <div className="space-y-6">
                {data.firstDiz && (
                  <section>
                    <h3 className="mb-2 text-sm font-medium text-ink">The first real FILE_ID.DIZ</h3>
                    <FileRef
                      file={data.firstDiz}
                      extra={`${data.firstDiz.lines} description lines, the earliest art-bearing one in the listing`}
                    />
                    <div className="mt-2">
                      <DizView text={data.firstDiz.rawDesc} label="first art-bearing file description" />
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Earliest reliably-dated one: 4+ description lines with ASCII-art runs,
                      skipping files listed twice with conflicting dates (BBS date typos).
                    </p>
                  </section>
                )}

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">
                    {data.span.firstDate.slice(0, 4)} – {data.span.lastDate.slice(0, 4)}: the whole span
                  </h3>
                  <div className="space-y-1">
                    <FileRef file={data.span.firstFile} extra="oldest entry" />
                    <FileRef file={data.span.lastFile} extra="newest entry" />
                  </div>
                  {data.futureCount > 0 && (
                    <p className="mt-1 text-xs text-muted">
                      {data.futureCount} {data.futureCount === 1 ? 'file is' : 'files are'} dated
                      after today — capture typos, not time travel.
                    </p>
                  )}
                </section>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label={`Files in ${data.peakYear.year} (peak year)`} value={data.peakYear.n} />
                  <StatCard label={`Files in ${data.peakMonth.month} (peak month)`} value={data.peakMonth.n} />
                  <StatCard label="Median file size (bytes)" value={data.medianSize ?? 0} />
                  <StatCard label={`Busiest weekday (${data.weekday.day}s)`} value={Math.max(...data.weekday.counts)} />
                </div>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">The great format migration</h3>
                  {data.extCrossover && (
                    <p className="mb-2 text-sm text-muted">
                      LHA overtook DMS in {data.extCrossover.year} and never looked back.
                    </p>
                  )}
                  <BarChart data={data.topExt.map((e) => ({ value: e.ext, n: e.n }))} />
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">Uploads by weekday</h3>
                  <BarChart
                    data={data.weekday.counts.map((n, i) => ({ value: DAY_SHORT[i], n }))}
                    maxItems={7}
                  />
                  <p className="mt-1 text-xs text-muted">
                    {data.weekday.day}s win — the weekend-warrior BBS.
                  </p>
                </section>

                <section>
                  <h3 className="mb-2 text-sm font-medium text-ink">Records</h3>
                  <div className="space-y-1">
                    {data.biggest && (
                      <FileRef file={data.biggest} extra={`biggest file at ${formatSize(data.biggest.sizeBytes)}`} />
                    )}
                    {data.longestDesc && (
                      <FileRef
                        file={data.longestDesc}
                        extra={`longest description: ${data.longestDesc.chars.toLocaleString()} chars over ${data.longestDesc.lines} lines`}
                      />
                    )}
                    {data.mostDownloaded && (
                      <FileRef
                        file={data.mostDownloaded}
                        extra={`most downloaded: ${data.mostDownloaded.dlCount} d/L times`}
                      />
                    )}
                  </div>
                </section>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
