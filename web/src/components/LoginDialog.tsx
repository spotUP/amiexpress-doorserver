/** Admin sign-in. The only place in the app that asks for anything. */
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { login } from '../api/client';
import type { AdminUser } from '../api/types';
import { Button, Input } from './ui';

export function LoginDialog({
  open,
  onOpenChange,
  onSignedIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignedIn: (user: AdminUser) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await login(username, password));
      onOpenChange(false);
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(24rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-2xl">
          <Dialog.Title className="text-lg font-semibold">Sign in</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">
            Curators only. Everything on this site is readable without an account.
          </Dialog.Description>
          <form onSubmit={submit} className="mt-4 grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted">Username</span>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-muted">Password</span>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button variant="primary" type="submit" disabled={busy || !username || !password}>
              {busy ? 'Checking...' : 'Sign in'}
            </Button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
