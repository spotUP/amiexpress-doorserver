/**
 * One editable field, with its provenance visible: what the scan holds, what
 * the classifier read out of the DIZ, and what a human has written. Reverting
 * removes the correction and puts the scanned value back - it never guesses.
 *
 * Corrections save themselves: a short pause in typing, or leaving the field,
 * writes the value. A curator fixing twenty fields should never hunt for a
 * button. The field says what it is doing rather than asking to be told.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CaseSensitive, RotateCcw } from 'lucide-react';
import type { FieldState } from '../api/types';
import { Badge, Button, Input, Textarea, cx } from './ui';

/** Long enough to type a word without a write per keystroke. */
const AUTOSAVE_IDLE_MS = 800;
/** How long "saved" stays up before the row goes quiet again. */
const SAVED_NOTICE_MS = 2000;

type Status = 'idle' | 'saving' | 'saved' | 'error';

export function FieldEditor({
  field,
  state,
  multiline,
  onTidy,
  onSave,
  onRevert,
  reverting,
}: {
  field: string;
  state: FieldState;
  multiline?: boolean;
  /** Given when the field can have its casing normalised server-side. */
  onTidy?: (text: string) => Promise<string>;
  onSave: (value: string | null) => Promise<unknown>;
  onRevert: () => void;
  reverting: boolean;
}) {
  const effective = state.isEdited ? (state.edited ?? '') : (state.derived ?? state.scanned ?? '');
  const [draft, setDraft] = useState(effective);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [tidying, setTidying] = useState(false);

  // The autosave paths (a timer, a blur, an unmount) all run outside the
  // render that scheduled them, so they read the draft through a ref rather
  // than closing over a value that has since moved on.
  const latest = useRef({ draft, effective, status });
  latest.current = { draft, effective, status };
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const sent = useRef<string | null>(null);
  const mounted = useRef(true);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const { draft: value, effective: server, status: current } = latest.current;
    if (value === server) return;
    // A blur landing right behind the idle timer must not write twice.
    if (sent.current === value && current !== 'error') return;
    sent.current = value;
    setStatus('saving');
    setError(null);
    void onSaveRef.current(value.trim() === '' ? null : value).then(
      () => mounted.current && setStatus('saved'),
      (cause: unknown) => {
        if (!mounted.current) return;
        setStatus('error');
        setError(cause instanceof Error ? cause.message : 'could not save');
      }
    );
  }, []);

  // A value changed elsewhere (another admin, a revert, the classifier) shows
  // up here - but only when this field holds no unsaved edit of its own. The
  // person typing outranks the refetch.
  const synced = useRef(effective);
  useEffect(() => {
    if (effective === synced.current) return;
    if (draft === synced.current) setDraft(effective);
    synced.current = effective;
  }, [effective, draft]);

  // Leaving the dialog mid-edit still writes what was typed.
  useEffect(() => {
    mounted.current = true;
    return () => {
      flush();
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, [flush]);

  useEffect(() => {
    if (status !== 'saved') return;
    const id = setTimeout(() => setStatus('idle'), SAVED_NOTICE_MS);
    return () => clearTimeout(id);
  }, [status]);

  function change(value: string) {
    setDraft(value);
    if (status === 'error') setStatus('idle');
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_IDLE_MS);
  }

  // The tidied text goes through change(), not setDraft(): it is an edit like
  // any other, so it autosaves (and stays editable) the same way.
  async function tidyCasing() {
    if (!onTidy) return;
    setTidying(true);
    try {
      change(await onTidy(latest.current.draft));
    } catch (cause: unknown) {
      setStatus('error');
      setError(cause instanceof Error ? cause.message : 'could not tidy the casing');
    } finally {
      setTidying(false);
    }
  }

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
            change(event.target.value)
          }
          onBlur={flush}
          className={cx('font-mono text-[13px]', dirty && 'border-accent-dim')}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {state.derived && !state.isEdited && <span>read from the DIZ</span>}
          {state.scanned !== null && state.scanned !== '' && (
            <span className="truncate">
              scanned: <span className="font-mono">{state.scanned.slice(0, 80)}</span>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span aria-live="polite" className={cx(status === 'error' && 'text-danger')}>
              {status === 'saving' && 'Saving...'}
              {status === 'saved' && 'Saved'}
              {status === 'error' && (error ?? 'Could not save')}
              {status === 'idle' && dirty && 'Unsaved'}
            </span>
            {onTidy && (
              <Button
                variant="ghost"
                onClick={() => void tidyCasing()}
                disabled={tidying}
                title="Rewrite eLi7e casing as normal words"
              >
                <CaseSensitive size={13} /> Fix casing
              </Button>
            )}
            {state.isEdited && (
              <Button variant="ghost" onClick={onRevert} disabled={reverting} title="Drop this correction">
                <RotateCcw size={13} /> Revert
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
