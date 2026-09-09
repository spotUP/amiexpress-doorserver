/**
 * Read-only table over the BBS file listing. No selection, no admin actions,
 * no downloads — there are no archives here, only the listing. A row opens a
 * detail dialog with the full extracted row.
 */
import { useState } from 'react';
import type { ReleaseFile } from '../api/releases';
import { Badge, Button, formatSize } from './ui';
import { DizView } from './DizView';

function flagBadge(flag: string): React.ReactNode {
  if (flag === 'D') return <Badge tone="warn">nuked</Badge>;
  if (flag === 'N') return <Badge tone="accent">new</Badge>;
  if (flag) return <Badge>{flag}</Badge>;
  return <span className="text-muted">–</span>;
}

function ReleaseDetailDialog({ row, onClose }: { row: ReleaseFile | null; onClose: () => void }) {
  if (!row) return null;
  const fields: Array<[string, string]> = [
    ['File', row.filename],
    ['Dir / no', `#${row.dirNo} / #${row.fileNo}`],
    ['Flag', row.flag || '–'],
    ['Size', row.sizeBytes !== null ? formatSize(row.sizeBytes) : (row.sizeNote ?? '–')],
    ['Date', row.dateIso],
    ['Version', row.version ?? '–'],
    ['Author', row.author ?? '–'],
    ['Downloads', row.dlCount !== null ? String(row.dlCount) : '–'],
    ['Uploader', row.uploader ?? '–'],
  ];
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-lg border border-line bg-surface p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={row.filename}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="m-0 break-all text-lg">{row.filename}</h2>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        {row.description && <p className="mb-4 text-sm">{row.description}</p>}
        {row.rawDesc ? (
          <div className="mb-4">
            <p className="mb-1 text-xs uppercase tracking-wide text-muted">File description, verbatim</p>
            <DizView text={row.rawDesc} label="file description" />
          </div>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {fields.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="m-0 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export function ReleasesTable({ rows }: { rows: ReleaseFile[] }) {
  const [open, setOpen] = useState<ReleaseFile | null>(null);
  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <th className="px-3 py-2 font-medium">File</th>
              <th className="px-3 py-2 font-medium">Flag</th>
              <th className="px-3 py-2 font-medium">Size</th>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">File ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer border-b border-line/50 last:border-0 hover:bg-raised"
                onClick={() => setOpen(r)}
              >
                <td className="break-all px-3 py-2 font-mono text-[13px]">{r.filename}</td>
                <td className="whitespace-nowrap px-3 py-2">{flagBadge(r.flag)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">
                  {r.sizeBytes !== null ? formatSize(r.sizeBytes) : (r.sizeNote ?? '–')}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{r.dateIso}</td>
                <td className="max-w-[28rem] truncate px-3 py-2 text-muted">{r.description ?? ''}</td>
                <td className="max-w-[24rem] px-3 py-2 align-top">
                  <pre
                    className="max-h-24 overflow-hidden font-amiga text-[15px] leading-[1.2] text-muted"
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {r.rawDesc.split('\n').slice(0, 4).join('\n')}
                  </pre>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted">
                  No releases match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ReleaseDetailDialog row={open} onClose={() => setOpen(null)} />
    </>
  );
}
