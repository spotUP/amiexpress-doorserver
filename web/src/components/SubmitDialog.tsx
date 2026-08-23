/**
 * Sending a door in.
 *
 * Open to anyone, no account. The file goes into a queue and is invisible
 * until a curator approves it - the dialog says so, because a contributor
 * who does not see their upload appear should know why.
 *
 * The size is checked here as well as on the server: refusing 9 MB before it
 * leaves the browser is faster for the sender and cheaper for the host.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { doorKeys } from '../api/queries';
import { Button, Input } from './ui';

const MAX_BYTES = 8 * 1024 * 1024;

export function SubmitDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const client = useQueryClient();

  function reset() {
    setFile(null);
    setNote('');
    setError(null);
    setDone(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError('That file is larger than 8 MB.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      if (note.trim()) body.append('note', note.trim());
      // Not through api/client.ts: this is multipart, and the client sets a
      // JSON content type.
      const res = await fetch('/api/door-repo/submissions', { method: 'POST', body });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; archiveName?: string };
      if (!res.ok) {
        setError(payload.error ?? 'That upload was refused.');
        return;
      }
      setDone(payload.archiveName ?? file.name);
      void client.invalidateQueries({ queryKey: doorKeys.submissions });
    } catch {
      setError('That upload could not be sent. If the file is very large, the connection may have been cut.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(30rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-2xl">
          <Dialog.Title className="text-lg font-semibold">Send in a door</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">
            LHA, LZX, LZH, DMS or ZIP, up to 8 MB. It joins a queue and appears in the repository once a curator
            has looked at it - nothing is published automatically.
          </Dialog.Description>

          {done ? (
            <div className="mt-4 space-y-4">
              <p className="text-sm text-ok">
                {done} is in the queue. Thank you.
              </p>
              <div className="flex justify-end gap-2">
                <Button onClick={reset}>Send another</Button>
                <Dialog.Close asChild>
                  <Button variant="primary">Done</Button>
                </Dialog.Close>
              </div>
            </div>
          ) : (
            <form onSubmit={submit} className="mt-4 grid gap-3">
              <label className="grid gap-1 text-sm">
                <span className="text-muted">Archive</span>
                <input
                  type="file"
                  accept=".lha,.lzx,.lzh,.dms,.zip"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setError(null);
                  }}
                  className="text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-raised file:px-3 file:py-1.5 file:text-sm file:text-ink"
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted">Anything worth knowing (optional)</span>
                <Input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="where it came from, what it does, which BBS it needs"
                />
              </label>
              {error && <p className="text-sm text-danger">{error}</p>}
              <div className="flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button variant="ghost">Cancel</Button>
                </Dialog.Close>
                <Button variant="primary" type="submit" disabled={!file || busy}>
                  <Upload size={14} /> {busy ? 'Sending...' : 'Send it in'}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
