/** Review screen shown between batch-strip-preview and batch-strip-apply:
 *  every candidate archive's flagged files, pre-checked, with per-file
 *  uncheck before the admin commits to stripping them. */
import { useState } from 'react';
import { Button } from './ui';
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

  const toggle = (archiveName: string, path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      const k = key(archiveName, path);
      if (next.has(k)) next.delete(k);
      else next.add(k);
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
              c.stripped.map((f) => (
                <label key={f.path} className="flex items-center gap-2 py-0.5 text-xs">
                  <input
                    type="checkbox"
                    checked={checked.has(key(c.archiveName, f.path))}
                    onChange={() => toggle(c.archiveName, f.path)}
                    className="h-3.5 w-3.5 rounded border-line accent-accent"
                  />
                  <span className="font-mono">{f.path}</span>
                  <span className="text-muted">({f.reason})</span>
                </label>
              ))
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
          // "error", per the spec.
          const selections = candidates.map((c) => ({ archiveName: c.archiveName, members: byArchive.get(c.archiveName) ?? [] }));
          onConfirm(selections);
        }}
        disabled={totalFiles === 0}
      >
        Confirm and strip {totalFiles} files across {totalArchives} archives
      </Button>
    </div>
  );
}
