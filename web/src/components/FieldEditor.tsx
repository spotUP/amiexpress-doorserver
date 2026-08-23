/**
 * One editable field, with its provenance visible: what the scan holds, what
 * the classifier read out of the DIZ, and what a human has written. Reverting
 * removes the correction and puts the scanned value back - it never guesses.
 */
import { useEffect, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import type { FieldState } from '../api/types';
import { Badge, Button, Input, Textarea, cx } from './ui';

export function FieldEditor({
  field,
  state,
  multiline,
  onSave,
  onRevert,
  busy,
}: {
  field: string;
  state: FieldState;
  multiline?: boolean;
  onSave: (value: string | null) => void;
  onRevert: () => void;
  busy: boolean;
}) {
  const effective = state.isEdited ? (state.edited ?? '') : (state.derived ?? state.scanned ?? '');
  const [draft, setDraft] = useState(effective);
  // A value changed elsewhere (another admin, a revert) must show up here.
  useEffect(() => setDraft(effective), [effective]);

  const dirty = draft !== effective;
  const Field = multiline ? Textarea : Input;

  return (
    <div className="grid gap-1.5 border-b border-line py-3 last:border-b-0 md:grid-cols-[10rem_1fr]">
      <div className="flex items-start gap-2 pt-1.5">
        <label htmlFor={`field-${field}`} className="text-sm text-muted">
          {field.replace(/_/g, ' ')}
        </label>
        {state.isEdited && <Badge tone="ok">edited</Badge>}
      </div>
      <div className="grid gap-2">
        <Field
          id={`field-${field}`}
          value={draft}
          rows={multiline ? 3 : undefined}
          onChange={(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            setDraft(event.target.value)
          }
          className={cx('font-mono text-[13px]', dirty && 'border-accent-dim')}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {state.derived && !state.isEdited && <span>read from the DIZ</span>}
          {state.scanned !== null && state.scanned !== '' && (
            <span className="truncate">
              scanned: <span className="font-mono">{state.scanned.slice(0, 80)}</span>
            </span>
          )}
          <div className="ml-auto flex gap-2">
            {state.isEdited && (
              <Button variant="ghost" onClick={onRevert} disabled={busy} title="Drop this correction">
                <RotateCcw size={13} /> Revert
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => onSave(draft.trim() === '' ? null : draft)}
              disabled={!dirty || busy}
            >
              <Save size={13} /> Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
