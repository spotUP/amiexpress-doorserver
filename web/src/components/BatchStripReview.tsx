/** Review screen shown between batch-strip-preview and batch-strip-apply:
 *  every candidate archive's flagged files, pre-checked, with per-file
 *  uncheck before the admin commits to stripping them. */
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from './ui';
import { useMarkNotJunk } from '../api/queries';
import type { StripPreviewResult } from '../api/queries';

// Archive names and paths can contain almost anything printable, but never a
// NUL byte, so it's a safe join/split delimiter for the composite key below.
const SEP = '\0';
const key = (archiveName: string, path: string) => `${archiveName}${SEP}${path}`;

export function BatchStripReview({
  candidates,
  onConfirm,
  onCancel,
}: {
  candidates: StripPreviewResult[];
  onConfirm: (selections: { archiveName: string; members: string[] }[]) => void;
  onCancel: () => void;
}) {
  // Pre-checked, matching what opening a single door's strip-preview shows
  // today: the classifier's picks are the default, not an empty slate.
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(candidates.flatMap((c) => c.stripped.map((f) => key(c.archiveName, f.path))))
  );
  // Files the admin has corrected as false positives in this review session.
  // Marked via markNotJunk (persists per-archive server side) and excluded
  // from the checked set so they're never sent to batch-strip-apply.
  const [notJunk, setNotJunk] = useState<Set<string>>(new Set());
  const markNotJunk = useMarkNotJunk();

  const toggle = (archiveName: string, path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      const k = key(archiveName, path);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const markFalsePositive = async (archiveName: string, path: string) => {
    await markNotJunk.mutateAsync({ archiveName, path });
    const k = key(archiveName, path);
    setNotJunk((prev) => new Set(prev).add(k));
    setChecked((prev) => {
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
  };

  const totalFiles = checked.size;
  const totalArchives = new Set([...checked].map((k) => k.split(SEP)[0])).size;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-accent bg-accent/5 p-4">
      <div className="flex items-center justify-between">
        <span className="font-medium text-ink">Review flagged files before stripping</span>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
      <div className="max-h-96 space-y-3 overflow-y-auto">
        {candidates.map((c) => (
          <div key={c.archiveName} className="rounded border border-line bg-bg p-2">
            <div className="mb-1 font-mono text-xs text-accent">{c.archiveName}</div>
            {c.error ? (
              <div className="text-xs text-danger">Could not be read: {c.error}</div>
            ) : c.stripped.length === 0 ? (
              <div className="text-xs text-muted">Nothing flagged.</div>
            ) : (
              c.stripped.map((f) => {
                const k = key(c.archiveName, f.path);
                const isNotJunk = notJunk.has(k);
                return (
                  <div key={f.path} className="flex items-center gap-2 py-0.5 text-xs">
                    <input
                      type="checkbox"
                      checked={checked.has(k)}
                      onChange={() => toggle(c.archiveName, f.path)}
                      disabled={isNotJunk}
                      className="h-3.5 w-3.5 rounded border-line accent-accent"
                    />
                    <span className={`font-mono ${isNotJunk ? 'text-muted line-through' : ''}`}>{f.path}</span>
                    <span className="text-muted">({f.reason})</span>
                    {isNotJunk ? (
                      <span className="inline-flex items-center gap-0.5 rounded border border-success/40 bg-success/10 px-1 py-0.5 text-[10px] font-medium text-success">
                        <ShieldCheck size={10} /> not junk
                      </span>
                    ) : (
                      <button
                        onClick={() => markFalsePositive(c.archiveName, f.path)}
                        className="rounded p-1 text-muted hover:bg-raised hover:text-success"
                        title="False positive - mark as not junk (kept from now on in this door)"
                      >
                        <ShieldCheck size={12} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ))}
      </div>
      <Button
        onClick={() => {
          const byArchive = new Map<string, string[]>();
          for (const k of checked) {
            const [archiveName, path] = k.split(SEP);
            byArchive.set(archiveName, [...(byArchive.get(archiveName) ?? []), path]);
          }
          // Every previewed archive is included, even with an empty
          // members list - batch-strip-apply treats that as "skip", not
          // "error", per the spec. An archive whose PREVIEW failed to read
          // is excluded outright: sending it with members: [] would make
          // stripArchiveOnServer treat it as "reviewed, nothing to strip"
          // and mark ads_stripped=1 on an archive nothing actually checked.
          const selections = candidates
            .filter((c) => !c.error)
            .map((c) => ({ archiveName: c.archiveName, members: byArchive.get(c.archiveName) ?? [] }));
          onConfirm(selections);
        }}
        disabled={totalFiles === 0}
      >
        Confirm and strip {totalFiles} files across {totalArchives} archives
      </Button>
    </div>
  );
}
