/** Toolbar shown when doors are selected for batch operations. */
import { Eye, EyeOff, Tag, Wand2, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui';

export function BatchToolbar({
  count,
  onHide,
  onRestore,
  onRecategorize,
  onFixCasing,
  onClear,
  isPending,
}: {
  count: number;
  onHide: () => void;
  onRestore: () => void;
  onRecategorize: (category: string) => void;
  onFixCasing: () => void;
  onClear: () => void;
  isPending: boolean;
}) {
  const [category, setCategory] = useState('');

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent bg-accent/5 px-4 py-2 text-sm">
      <span className="font-medium text-ink">{count} selected</span>
      <span className="text-muted">|</span>
      <Button variant="ghost" onClick={onHide} disabled={isPending}>
        <EyeOff size={14} /> Hide
      </Button>
      <Button variant="ghost" onClick={onRestore} disabled={isPending}>
        <Eye size={14} /> Restore
      </Button>
      <div className="flex items-center gap-1">
        <Tag size={14} className="text-muted" />
        <input
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Set category..."
          className="w-32 rounded border border-line bg-bg px-2 py-1 text-xs text-ink placeholder:text-muted focus:border-accent focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && category.trim()) {
              onRecategorize(category.trim());
              setCategory('');
            }
          }}
        />
        <Button
          variant="ghost"
          onClick={() => {
            if (category.trim()) {
              onRecategorize(category.trim());
              setCategory('');
            }
          }}
          disabled={isPending || !category.trim()}
        >
          Apply
        </Button>
      </div>
      <Button variant="ghost" onClick={onFixCasing} disabled={isPending}>
        <Wand2 size={14} /> Fix casing
      </Button>
      <div className="flex-1" />
      <Button variant="ghost" onClick={onClear} disabled={isPending}>
        <X size={14} /> Clear
      </Button>
    </div>
  );
}
