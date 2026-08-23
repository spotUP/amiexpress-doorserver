/**
 * One door in full: what it is, what it needs, what is inside the archive,
 * and its FILE_ID.DIZ verbatim. An admin gets the same dialog with an Edit
 * tab, so there is one place that describes a door rather than two.
 */
import * as Dialog from '@radix-ui/react-dialog';
import * as Tabs from '@radix-ui/react-tabs';
import { Download, X } from 'lucide-react';
import { useState } from 'react';
import { useAdminDoor, useDoor, useRedescribe, useRevertField, useSaveField } from '../api/queries';
import type { AdminUser, DoorFacts } from '../api/types';
import { DizView } from './DizView';
import { GuideView } from './GuideView';
import { FieldEditor } from './FieldEditor';
import { RemoveDoor } from './RemoveDoor';
import { Badge, Button, formatSize } from './ui';

const MULTILINE_FIELDS = new Set(['description', 'suggested_tooltypes']);

export function DoorDetailDialog({
  archiveName,
  admin,
  onClose,
}: {
  archiveName: string | null;
  admin: AdminUser | null;
  onClose: () => void;
}) {
  const { data: door, isLoading } = useDoor(archiveName);
  const { data: adminDoor } = useAdminDoor(archiveName, Boolean(admin));
  const save = useSaveField(archiveName ?? '');
  const revert = useRevertField(archiveName ?? '');
  const redescribe = useRedescribe(archiveName ?? '');
  const [preview, setPreview] = useState<DoorFacts | null>(null);

  return (
    <Dialog.Root open={Boolean(archiveName)} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[min(60rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-lg font-semibold text-ink">
                {door?.name ?? archiveName}
              </Dialog.Title>
              <Dialog.Description className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="font-mono text-accent">{archiveName}</span>
                {door && <span>{formatSize(door.size)}</span>}
                {door?.doorType && <Badge>{door.doorType}</Badge>}
                {door?.requiresBbs && <Badge tone="accent">needs {door.requiresBbs}</Badge>}
                {door?.system && <span>{door.system}</span>}
              </Dialog.Description>
            </div>
            <div className="flex items-center gap-2">
              {door && (
                // A real link, not a button that navigates: the browser then
                // offers "save as", and the URL is copyable.
                <a
                  href={door.downloadUrl}
                  className="inline-flex items-center gap-2 rounded-md border border-accent-dim bg-accent-dim px-3 py-1.5 text-sm font-medium text-ink hover:bg-accent hover:text-bg"
                >
                  <Download size={14} /> Download
                </a>
              )}
              <Dialog.Close asChild>
                <Button variant="ghost" aria-label="Close">
                  <X size={16} />
                </Button>
              </Dialog.Close>
            </div>
          </header>

          <Tabs.Root defaultValue="about" className="flex min-h-0 flex-1 flex-col">
            <Tabs.List className="flex gap-1 border-b border-line px-4">
              {[
                ['about', 'About'],
                ['diz', 'FILE_ID.DIZ'],
                ['files', `Files${door ? ` (${door.files.length})` : ''}`],
                ...(door?.doc
                  ? [['doc', door.docFormat === 'amigaguide' ? 'Guide' : 'Documentation'] as const]
                  : []),
                ...(admin ? [['edit', 'Edit'] as const] : []),
              ].map(([value, label]) => (
                <Tabs.Trigger
                  key={value}
                  value={value}
                  className="border-b-2 border-transparent px-3 py-2 text-sm text-muted data-[state=active]:border-accent data-[state=active]:text-ink"
                >
                  {label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {isLoading && <p className="text-sm text-muted">Reading the catalog...</p>}

              <Tabs.Content value="about" className="space-y-4">
                <p className="text-sm text-ink">{door?.description}</p>
                <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
                  {[
                    ['Version', door?.version],
                    ['Author', door?.author],
                    ['Group', door?.releaseGroup],
                    ['Category', door?.category],
                    ['Needs', door?.requiresBbs],
                    ['Type', door?.doorType],
                    ['MD5', door?.md5],
                  ].map(([label, value]) => (
                    <div key={label as string}>
                      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
                      <dd className="truncate font-mono text-[12px] text-ink">{(value as string) || '-'}</dd>
                    </div>
                  ))}
                </dl>
              </Tabs.Content>

              <Tabs.Content value="diz">
                <DizView text={door?.fileIdDiz ?? ''} label="FILE_ID.DIZ" />
              </Tabs.Content>

              <Tabs.Content value="files">
                <ul className="divide-y divide-line rounded-md border border-line">
                  {door?.files.map((file) => (
                    <li key={file.path} className="flex items-center gap-3 px-3 py-1.5 text-sm">
                      <span className="flex-1 truncate font-mono text-[12px]">{file.path}</span>
                      {file.isJunk && <Badge tone="warn">{file.junkReason ?? 'junk'}</Badge>}
                      <span className="w-16 text-right font-mono text-[12px] text-muted">
                        {formatSize(file.size)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Tabs.Content>

              {door?.doc && (
                <Tabs.Content value="doc">
                  {door.guide ? (
                    <GuideView guide={door.guide} />
                  ) : (
                    <DizView text={door.doc} label={door.docFilename ?? 'documentation'} />
                  )}
                </Tabs.Content>
              )}

              {admin && (
                <Tabs.Content value="edit" className="space-y-3">
                  {archiveName && <RemoveDoor archiveName={archiveName} hidden={Boolean(adminDoor?.hidden)} />}
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={() => redescribe.mutateAsync().then(setPreview)}
                      disabled={redescribe.isPending}
                    >
                      Re-read from the DIZ
                    </Button>
                    {preview && (
                      <p className="text-xs text-muted">
                        classifier says: <span className="font-mono text-ink">{preview.description}</span>
                      </p>
                    )}
                  </div>
                  {adminDoor &&
                    Object.entries(adminDoor.fields).map(([field, state]) => (
                      <FieldEditor
                        key={field}
                        field={field}
                        state={state}
                        multiline={MULTILINE_FIELDS.has(field)}
                        busy={save.isPending || revert.isPending}
                        onSave={(value) => save.mutate({ [field]: value })}
                        onRevert={() => revert.mutate(field)}
                      />
                    ))}
                  {save.isError && <p className="text-sm text-danger">{(save.error as Error).message}</p>}
                </Tabs.Content>
              )}
            </div>
          </Tabs.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
