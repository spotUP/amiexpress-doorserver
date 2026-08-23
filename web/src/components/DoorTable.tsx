/** The listing: sortable columns, one row per door, keyboard reachable. */
import { ArrowDown, ArrowUp, Download, FileText } from 'lucide-react';
import type { Door } from '../api/types';
import { Badge, Tooltip, cx, formatSize } from './ui';

export interface SortState {
  sort: string;
  dir: 'asc' | 'desc';
}

const COLUMNS: { key: string; label: string; sortable: boolean; className?: string }[] = [
  { key: 'archive', label: 'Archive', sortable: true, className: 'w-56' },
  // The catalog's `name` field is the DIZ's first line for 1031 of 3301
  // rows - border art. What this column shows is the cleaned reading of it
  // (src/describe.ts, displayName), never the raw value.
  { key: 'name', label: 'Name', sortable: true, className: 'w-48' },
  { key: 'version', label: 'Version', sortable: true, className: 'w-20' },
  { key: 'description', label: 'Description', sortable: false },
  { key: 'requires', label: 'Needs', sortable: true, className: 'w-28' },
  { key: 'author', label: 'Author', sortable: true, className: 'w-40' },
  { key: 'size', label: 'Size', sortable: true, className: 'w-20 text-right' },
];

export function DoorTable({
  rows,
  sortState,
  onSort,
  onOpen,
}: {
  rows: Door[];
  sortState: SortState;
  onSort: (key: string) => void;
  onOpen: (door: Door) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[56rem] border-collapse text-sm">
        <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.key} scope="col" className={cx('px-3 py-2 font-medium', column.className)}>
                {column.sortable ? (
                  <button
                    type="button"
                    onClick={() => onSort(column.key)}
                    className="inline-flex items-center gap-1 hover:text-ink"
                  >
                    {column.label}
                    {sortState.sort === column.key &&
                      (sortState.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                ) : (
                  column.label
                )}
              </th>
            ))}
            <th scope="col" className="w-24 px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((door) => (
            <tr
              key={door.archiveName}
              className="cursor-pointer border-t border-line hover:bg-surface"
              onClick={() => onOpen(door)}
            >
              <td className="px-3 py-2 font-mono text-[12px] text-accent">{door.archiveName}</td>
              <td className="px-3 py-2">
                <span className={door.nameSource === 'archive' ? 'text-muted' : undefined}>{door.name}</span>
              </td>
              <td className="px-3 py-2 font-mono text-[12px] text-muted">{door.version || '-'}</td>
              <td className="px-3 py-2 text-muted">
                {door.description}
                {door.descriptionSource === 'edited' && (
                  <span className="ml-2 align-middle">
                    <Badge tone="ok">edited</Badge>
                  </span>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-[12px] text-muted">{door.requiresBbs ?? '-'}</td>
              <td className="px-3 py-2 text-muted">{door.author ?? '-'}</td>
              <td className="px-3 py-2 text-right font-mono text-[12px] text-muted">{formatSize(door.size)}</td>
              <td className="px-3 py-2">
                <div className="flex items-center justify-end gap-2" onClick={(event) => event.stopPropagation()}>
                  {door.hasDoc && (
                    <Tooltip label="Has documentation">
                      <span className="text-muted">
                        <FileText size={14} />
                      </span>
                    </Tooltip>
                  )}
                  <Tooltip label={`Download ${door.archiveName}`}>
                    <a
                      href={door.downloadUrl}
                      className="rounded p-1 text-muted hover:bg-raised hover:text-accent"
                      aria-label={`Download ${door.archiveName}`}
                    >
                      <Download size={15} />
                    </a>
                  </Tooltip>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">No doors match that search.</p>}
    </div>
  );
}
