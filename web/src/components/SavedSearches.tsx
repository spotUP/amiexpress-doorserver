/** Save and recall search queries from localStorage. */
import { Bookmark, BookmarkCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui';

const STORAGE_KEY = 'door-repo-saved-searches';

export interface SavedSearch {
  id: string;
  label: string;
  query: string;
  system: string;
  type: string;
  requires: string;
}

function load(): SavedSearch[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function save(list: SavedSearch[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function SavedSearches({
  query,
  system,
  type,
  requires,
  onApply,
}: {
  query: string;
  system: string;
  type: string;
  requires: string;
  onApply: (s: SavedSearch) => void;
}) {
  const [list, setList] = useState<SavedSearch[]>(load);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    save(list);
  }, [list]);

  const addCurrent = useCallback(() => {
    const label = prompt('Name for this search:');
    if (!label) return;
    setList((prev) => [
      ...prev,
      { id: Date.now().toString(36), label, query, system, type, requires },
    ]);
  }, [query, system, type, requires]);

  const remove = useCallback((id: string) => {
    setList((prev) => prev.filter((s) => s.id !== id));
  }, []);

  if (list.length === 0 && !open) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" onClick={() => setOpen((v) => !v)} className="text-xs">
        {open ? <BookmarkCheck size={14} /> : <Bookmark size={14} />}
        {list.length > 0 && ` ${list.length}`}
      </Button>
      {open && (
        <div className="flex flex-wrap gap-1">
          {list.map((s) => (
            <span key={s.id} className="flex items-center gap-1 rounded border border-line bg-surface px-2 py-0.5 text-xs">
              <button
                type="button"
                onClick={() => onApply(s)}
                className="text-ink hover:text-accent"
              >
                {s.label}
              </button>
              <button
                type="button"
                onClick={() => remove(s.id)}
                className="text-muted hover:text-red"
              >
                <Trash2 size={10} />
              </button>
            </span>
          ))}
          <Button variant="ghost" onClick={addCurrent} className="text-xs">
            + Save current
          </Button>
        </div>
      )}
    </div>
  );
}
