/**
 * Read-only table over the BBS file listing. No selection, no admin actions,
 * no downloads — there are no archives here, only the listing. A row opens a
 * detail dialog with the full extracted row.
 */
import { useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { ReleaseFile } from '../api/releases';
import { Badge, Button, cx, formatSize } from './ui';
import { DizView } from './DizView';
import type { SortState } from './DoorTable';

const COLUMNS: { key: string; label: string; sortable: boolean; className?: string }[] = [
  { key: 'filename', label: 'File', sortable: true, className: 'whitespace-nowrap' },
  { key: 'group', label: 'Group', sortable: true },
  { key: 'flag', label: 'Flag', sortable: true },
  { key: 'size', label: 'Size', sortable: true, className: 'whitespace-nowrap' },
  { key: 'date', label: 'Date', sortable: true, className: 'whitespace-nowrap' },
  { key: 'dir', label: 'Dir', sortable: true, className: 'whitespace-nowrap' },
  { key: 'version', label: 'Ver', sortable: true, className: 'whitespace-nowrap' },
  { key: 'author', label: 'Author', sortable: true },
  { key: 'downloads', label: 'DLs', sortable: true, className: 'whitespace-nowrap' },
  { key: 'description', label: 'Description', sortable: false },
  { key: 'rawDesc', label: 'File ID', sortable: false },
];

function SortHeader({ column, sortState, onSort }: { column: typeof COLUMNS[number]; sortState: SortState; onSort: (k: string) => void }) {
  if (!column.sortable) return column.label;
  return (
    <button type="button" onClick={() => onSort(column.key)} className="inline-flex items-center gap-1 hover:text-ink">
      {column.label}
      {sortState.sort === column.key && (sortState.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
    </button>
  );
}

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
    ['Group', row.releaseGroupFull ?? row.releaseGroup ?? '–'],
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

export function ReleasesTable({ rows, sortState, onSort }: { rows: ReleaseFile[]; sortState: SortState; onSort: (key: string) => void }) {
  const [open, setOpen] = useState<ReleaseFile | null>(null);
  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-sm">
              <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              {COLUMNS.map((column) => (
                <th key={column.key} scope="col" className={cx('px-3 py-2 font-medium', column.className)}>
                  <SortHeader column={column} sortState={sortState} onSort={onSort} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer border-b border-line/50 last:border-0 hover:bg-raised"
                onClick={() => setOpen(r)}
              >
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[13px]">{r.filename}</td>
                <td
                  className="max-w-[12rem] truncate px-3 py-2 text-muted"
                  title={r.releaseGroupFull ?? r.releaseGroup ?? ''}
                >
                  {r.releaseGroupFull ?? r.releaseGroup ?? '–'}
                </td>
                <td className="whitespace-nowrap px-3 py-2">{flagBadge(r.flag)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">
                  {r.sizeBytes !== null ? formatSize(r.sizeBytes) : (r.sizeNote ?? '–')}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{r.dateIso}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">#{r.dirNo}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{r.version ?? '–'}</td>
                <td className="max-w-[10rem] truncate px-3 py-2 text-muted">{r.author ?? '–'}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">
                  {r.dlCount !== null ? String(r.dlCount) : '–'}
                </td>
                <td className="max-w-[28rem] truncate px-3 py-2 text-muted">{r.description ?? ''}</td>
                <td className="px-3 py-2 align-top">
                  {r.rawDesc ? (
                    <pre className="w-max px-2 py-1 font-amiga text-[15px] leading-[1.2] text-muted">
                      {r.rawDesc}
                    </pre>
                  ) : (
                    <span className="text-muted">–</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-muted">
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
