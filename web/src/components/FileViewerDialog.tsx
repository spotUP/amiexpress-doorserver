/** Shared "view a file inside an archive" dialog: sniffs text-vs-binary on
 *  the server, shows text inline, triggers a download for binary. Used by
 *  both the single-door strip screen and the bulk-stripper review screen so
 *  there's one fetch/render path instead of two. */
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';

export function FileViewerDialog({
  target,
  onClose,
}: {
  target: { archiveName: string; path: string } | null;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!target) {
      setContent(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setContent(null);
    (async () => {
      const info = await api.get<{ isText: boolean }>(
        `/admin/doors/${encodeURIComponent(target.archiveName)}/file-info?path=${encodeURIComponent(target.path)}`,
      );
      if (cancelled) return;
      if (!info.isText) {
        // Binary: fetch it (with the auth header a plain <a href> can't
        // carry) and save it from a blob URL instead of dumping bytes inline.
        const blob = await api.getBlob(
          `/admin/doors/${encodeURIComponent(target.archiveName)}/file?path=${encodeURIComponent(target.path)}`,
        );
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = target.path.split('/').pop() ?? target.path;
        link.click();
        URL.revokeObjectURL(url);
        setLoading(false);
        onClose();
        return;
      }
      const text = await api.getText(
        `/admin/doors/${encodeURIComponent(target.archiveName)}/file?path=${encodeURIComponent(target.path)}`,
      );
      if (!cancelled) {
        setContent(text);
        setLoading(false);
      }
    })().catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.archiveName, target?.path]);

  if (!target || content === null) {
    if (loading) {
      return (
        <Dialog.Root open={true} onOpenChange={(open) => !open && onClose()}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
            <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(24rem,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-6 text-center text-sm text-muted shadow-2xl">
              Loading...
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      );
    }
    return null;
  }

  return (
    <Dialog.Root open={true} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[min(60rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <Dialog.Title className="truncate font-mono text-sm text-ink">{target.path}</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-muted hover:text-ink" aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">File content preview</Dialog.Description>
          <pre className="flex-1 overflow-auto whitespace-pre-wrap break-all p-4 font-amiga text-[15px] leading-[1.2] text-ink">
            {content}
          </pre>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
