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
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('');
  const [author, setAuthor] = useState('');
  const [needs, setNeeds] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const client = useQueryClient();

  function reset() {
    setFile(null);
    setNote('');
    setName('');
    setDescription('');
    setVersion('');
    setAuthor('');
    setNeeds('');
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
      if (name.trim()) body.append('name', name.trim());
      if (description.trim()) body.append('description', description.trim());
      if (version.trim()) body.append('version', version.trim());
      if (author.trim()) body.append('author', author.trim());
      if (needs.trim()) body.append('needs', needs.trim());
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
              <p className="text-xs text-muted">
                The fields below are optional. Left blank, they're guessed from the archive's own
                FILE_ID.DIZ if it has one - not every archive does, so filling these in yourself is
                the only way to be sure they're right.
              </p>
              <label className="grid gap-1 text-sm">
                <span className="text-muted">Name</span>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="the door's name" />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted">Description</span>
                <Input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="what it does"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1 text-sm">
                  <span className="text-muted">Version</span>
                  <Input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.0" />
                </label>
                <label className="grid gap-1 text-sm">
                  <span className="text-muted">Author</span>
                  <Input
                    value={author}
                    onChange={(event) => setAuthor(event.target.value)}
                    placeholder="who made it"
                  />
                </label>
              </div>
              <label className="grid gap-1 text-sm">
                <span className="text-muted">Needs</span>
                <Input
                  value={needs}
                  onChange={(event) => setNeeds(event.target.value)}
                  placeholder="which BBS software or version it needs, if any"
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted">Note to the curator (optional)</span>
                <Input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="where it came from, anything else worth knowing"
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
