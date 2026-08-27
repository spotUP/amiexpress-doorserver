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
  { key: 'name', label: 'Name', sortable: true, className: 'w-48' },
  { key: 'version', label: 'Version', sortable: true, className: 'w-20' },
  { key: 'description', label: 'Description', sortable: false },
  { key: 'requires', label: 'Needs', sortable: true, className: 'w-28' },
  { key: 'author', label: 'Author', sortable: true, className: 'w-40' },
  { key: 'group', label: 'Group', sortable: true, className: 'w-44' },
  { key: 'size', label: 'Size', sortable: true, className: 'w-20 text-right' },
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

export function DoorTable({
  rows,
  sortState,
  onSort,
  onOpen,
  selected,
  onToggle,
  onToggleAll,
}: {
  rows: Door[];
  sortState: SortState;
  onSort: (key: string) => void;
  onOpen: (door: Door) => void;
  selected?: Set<string>;
  onToggle?: (name: string) => void;
  onToggleAll?: () => void;
}) {
  const hasSelection = selected && onToggle && onToggleAll;
  const allSelected = hasSelection && rows.length > 0 && rows.every((d) => selected!.has(d.archiveName));

  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-lg border border-line md:block">
        <table className="w-full min-w-[60rem] border-collapse text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {hasSelection && (
                <th scope="col" className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={onToggleAll}
                    className="h-3.5 w-3.5 rounded border-line accent-accent"
                  />
                </th>
              )}
              {COLUMNS.map((column) => (
                <th key={column.key} scope="col" className={cx('px-3 py-2 font-medium', column.className)}>
                  <SortHeader column={column} sortState={sortState} onSort={onSort} />
                </th>
              ))}
              <th scope="col" className="w-24 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((door) => (
              <tr
                key={door.archiveName}
                className={cx(
                  'cursor-pointer border-t border-line hover:bg-surface',
                  hasSelection && selected!.has(door.archiveName) && 'bg-accent/5',
                )}
                onClick={() => onOpen(door)}
              >
                {hasSelection && (
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected!.has(door.archiveName)}
                      onChange={() => onToggle!(door.archiveName)}
                      className="h-3.5 w-3.5 rounded border-line accent-accent"
                    />
                  </td>
                )}
                <td className="px-3 py-2 font-mono text-[12px] text-accent">{door.archiveName}</td>
                <td className="px-3 py-2">
                  <span className={door.nameSource === 'archive' ? 'text-muted' : undefined}>{door.name}</span>
                </td>
                <td className="px-3 py-2 font-mono text-[12px] text-muted">{door.version || '-'}</td>
                <td className="px-3 py-2 text-muted">
                  {door.description}
                  {door.descriptionSource === 'edited' && (
                    <span className="ml-2 align-middle"><Badge tone="ok">edited</Badge></span>
                  )}
                  {door.adsStripped && (
                    <span className="ml-2 align-middle"><Badge tone="warn">stripped</Badge></span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-[12px] text-muted">{door.requiresBbs ?? '-'}</td>
                <td className="px-3 py-2 text-muted">{door.author ?? '-'}</td>
                <td className="px-3 py-2 text-muted" title={door.releaseGroup ?? undefined}>
                  {door.releaseGroupFullName ?? door.releaseGroup ?? '-'}
                </td>
                <td className="px-3 py-2 text-right font-mono text-[12px] text-muted">{formatSize(door.size)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                    {door.hasDoc && (
                      <Tooltip label="Has documentation">
                        <span className="text-muted"><FileText size={14} /></span>
                      </Tooltip>
                    )}
                    <Tooltip label={`Download ${door.archiveName}`}>
                      <a href={door.downloadUrl} className="rounded p-1 text-muted hover:bg-raised hover:text-accent" aria-label={`Download ${door.archiveName}`}>
                        <Download size={15} />
                      </a>
                    </Tooltip>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-2 md:hidden">
        {hasSelection && (
          <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onToggleAll}
              className="h-3.5 w-3.5 rounded border-line accent-accent"
            />
            <span className="text-muted">Select all ({rows.length})</span>
          </label>
        )}
        {rows.map((door) => (
          <div
            key={door.archiveName}
            className={cx(
              'cursor-pointer rounded-lg border border-line bg-surface px-3 py-2.5',
              hasSelection && selected!.has(door.archiveName) && 'border-accent/40 bg-accent/5',
            )}
            onClick={() => onOpen(door)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{door.name}</p>
                <p className="truncate font-mono text-[11px] text-accent">{door.archiveName}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                {hasSelection && (
                  <input
                    type="checkbox"
                    checked={selected!.has(door.archiveName)}
                    onChange={() => onToggle!(door.archiveName)}
                    className="h-3.5 w-3.5 rounded border-line accent-accent"
                  />
                )}
                {door.hasDoc && <FileText size={13} className="text-muted" />}
                <a href={door.downloadUrl} className="rounded p-1 text-muted hover:bg-raised hover:text-accent">
                  <Download size={14} />
                </a>
              </div>
            </div>
            {door.description && (
              <p className="mt-1 line-clamp-2 text-xs text-muted">{door.description}</p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
              {door.doorType && <Badge>{door.doorType}</Badge>}
              {(door.releaseGroupFullName ?? door.releaseGroup) && (
                <span title={door.releaseGroup ?? undefined}>{door.releaseGroupFullName ?? door.releaseGroup}</span>
              )}
              {door.author && <span>{door.author}</span>}
              <span className="ml-auto font-mono">{formatSize(door.size)}</span>
            </div>
          </div>
        ))}
      </div>

      {rows.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted">No doors match that search.</p>}
    </>
  );
}
