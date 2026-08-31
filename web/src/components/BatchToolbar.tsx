/** Toolbar shown when doors are selected for batch operations. */
import { Eraser, Eye, EyeOff, Tag, Trash2, Wand2, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { Button, Select } from './ui';
import { useJobProgress } from '../api/queries';

// Mirrors OVERRIDABLE_FIELDS in src/effective.ts - the two lists must be
// kept in sync by hand, since web/ and src/ aren't a shared module today.
const OVERRIDABLE_FIELDS = [
  'name', 'description', 'version', 'author', 'release_group', 'category',
  'door_type', 'requires_bbs', 'binary_name', 'suggested_tooltypes', 'file_id_diz',
] as const;

export function BatchToolbar({
  count,
  onHide,
  onRestore,
  onSetField,
  onFixCasing,
  onTagsChange,
  onDelete,
  onReextract,
  reextractJobId,
  onStripPreview,
  onClear,
  isPending,
}: {
  count: number;
  onHide: () => void;
  onRestore: () => void;
  onSetField: (field: string, value: string) => void;
  onFixCasing: () => void;
  onTagsChange: (add: string[], remove: string[]) => void;
  onDelete: (confirm: string) => void;
  onReextract: () => void;
  reextractJobId: string | null;
  onStripPreview: () => void;
  onClear: () => void;
  isPending: boolean;
}) {
  const [field, setField] = useState<string>(OVERRIDABLE_FIELDS[0]);
  const [value, setValue] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const reextractProgress = useJobProgress(reextractJobId);

  if (reextractJobId && reextractProgress && reextractProgress.status !== 'done') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-accent bg-accent/5 px-4 py-2 text-sm">
        <RefreshCw size={14} className="animate-spin text-accent" />
        <span>Re-extracting {reextractProgress.completed} / {reextractProgress.total}</span>
        {reextractProgress.failedCount > 0 && <span className="text-danger">{reextractProgress.failedCount} failed</span>}
      </div>
    );
  }

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
        <Select
          ariaLabel="Field to edit"
          placeholder="Field"
          value={field}
          onChange={setField}
          options={OVERRIDABLE_FIELDS.map((f) => ({ value: f, label: f }))}
          required
        />
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="New value..."
          className="w-32 rounded border border-line bg-bg px-2 py-1 text-xs text-ink placeholder:text-muted focus:border-accent focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) {
              onSetField(field, value.trim());
              setValue('');
            }
          }}
        />
        <Button
          variant="ghost"
          onClick={() => { if (value.trim()) { onSetField(field, value.trim()); setValue(''); } }}
          disabled={isPending || !value.trim()}
        >
          Apply
        </Button>
      </div>

      <Button variant="ghost" onClick={onFixCasing} disabled={isPending}>
        <Wand2 size={14} /> Fix casing
      </Button>

      <div className="flex items-center gap-1">
        <Tag size={14} className="text-muted" />
        <input
          type="text"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          placeholder="tag, +tag, -tag..."
          className="w-36 rounded border border-line bg-bg px-2 py-1 text-xs text-ink placeholder:text-muted focus:border-accent focus:outline-none"
          title="Comma-separated tags. Prefix with - to remove."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && tagInput.trim()) {
              const parts = tagInput.split(',').map((t) => t.trim()).filter(Boolean);
              const add = parts.filter((t) => !t.startsWith('-'));
              const remove = parts.filter((t) => t.startsWith('-')).map((t) => t.slice(1));
              onTagsChange(add, remove);
              setTagInput('');
            }
          }}
        />
      </div>

      <Button variant="ghost" onClick={onReextract} disabled={isPending}>
        <RefreshCw size={14} /> Re-extract
      </Button>

      <Button variant="ghost" onClick={onStripPreview} disabled={isPending}>
        <Eraser size={14} /> Strip ads
      </Button>

      {!deleteConfirmOpen ? (
        <Button variant="danger" onClick={() => setDeleteConfirmOpen(true)} disabled={isPending}>
          <Trash2 size={14} /> Delete
        </Button>
      ) : (
        <div className="flex items-center gap-1">
          <span className="text-xs text-danger">Type {count} to confirm:</span>
          <input
            type="text"
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            className="w-12 rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
          />
          <Button
            variant="danger"
            onClick={() => { onDelete(deleteConfirmText); setDeleteConfirmOpen(false); setDeleteConfirmText(''); }}
            disabled={deleteConfirmText !== String(count)}
          >
            Confirm delete
          </Button>
          <Button
            variant="ghost"
            onClick={() => { setDeleteConfirmOpen(false); setDeleteConfirmText(''); }}
            disabled={isPending}
          >
            Cancel
          </Button>
        </div>
      )}

      <div className="flex-1" />
      <Button variant="ghost" onClick={onClear} disabled={isPending}>
        <X size={14} /> Clear
      </Button>
    </div>
  );
}
