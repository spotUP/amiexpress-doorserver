/** Who changed what. Read-only, and only visible to a signed-in curator. */
import * as Dialog from '@radix-ui/react-dialog';
import { useAudit } from '../api/queries';
import type { AuditEntry } from '../api/types';

function formatDetail(entry: AuditEntry): string | null {
  const d = entry.detail;
  if (!d || typeof d !== 'object') return null;

  switch (entry.action) {
    case 'edit': {
      const { field, from, to } = d as { field?: string; from?: unknown; to?: unknown };
      if (field && to !== undefined) {
        const label = field.replace(/_/g, ' ');
        if (from === undefined || from === null) return `${label} set to "${String(to).slice(0, 80)}"`;
        return `${label} changed from "${String(from).slice(0, 40)}" to "${String(to).slice(0, 40)}"`;
      }
      return null;
    }
    case 'revert': {
      const { field } = d as { field?: string };
      return field ? `reverted ${field.replace(/_/g, ' ')}` : null;
    }
    case 'hide': {
      const { reason } = d as { reason?: string };
      return reason ? `reason: ${reason}` : 'hidden';
    }
    case 'restore':
      return 'restored to catalog';
    case 'strip': {
      const { removed } = d as { removed?: number };
      return removed ? `stripped ${removed} file${removed !== 1 ? 's' : ''}` : null;
    }
    case 'strip-failed':
    case 'strip-preview-failed': {
      const { error } = d as { error?: string };
      return error ? `error: ${error}` : null;
    }
    case 'delete-files': {
      const { members, removed } = d as { members?: string[]; removed?: number };
      if (members?.length) {
        const names = members.map((m) => m.split('/').pop() ?? m).slice(0, 3);
        const more = members.length > 3 ? ` (+${members.length - 3} more)` : '';
        return `deleted ${names.join(', ')}${more}`;
      }
      return removed ? `deleted ${removed} file${removed !== 1 ? 's' : ''}` : null;
    }
    case 'approve':
      return 'submission approved';
    case 'reject': {
      const { reason } = d as { reason?: string };
      return reason ? `rejected: ${reason}` : 'submission rejected';
    }
    case 'edit-release-group': {
      const { full_name } = d as { full_name?: string | null };
      return full_name ? `group set to "${full_name}"` : 'group name cleared';
    }
    case 'edit-tags': {
      const { tags } = d as { tags?: string[] };
      return tags?.length ? `tags: ${tags.join(', ')}` : 'tags cleared';
    }
    case 'login':
      return null;
    default:
      return null;
  }
}

function formatTarget(target: string): string {
  if (!target) return '';
  // Target is usually a catalog_id (UUID-like) or archive_name
  // If it looks like an archive name, show it; otherwise just show the ID
  if (target.includes('.')) return target;
  return target.length > 12 ? target.slice(0, 12) + '...' : target;
}

export function AuditPanel({
  open,
  onOpenChange,
  enabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
}) {
  const { data } = useAudit(enabled && open);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(34rem,94vw)] flex-col border-l border-line bg-surface shadow-2xl">
          <Dialog.Title className="border-b border-line px-5 py-4 text-lg font-semibold">Audit trail</Dialog.Title>
          <Dialog.Description className="sr-only">Every change made through the admin console.</Dialog.Description>
          <ul className="flex-1 divide-y divide-line overflow-y-auto text-sm">
            {(data?.rows ?? []).map((entry) => {
              const detail = formatDetail(entry);
              return (
                <li key={entry.id} className="px-5 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium capitalize text-ink">
                      {entry.action.replace(/-/g, ' ')}
                    </span>
                    <time className="text-xs text-muted">{new Date(entry.at * 1000).toLocaleString()}</time>
                  </div>
                  {formatTarget(entry.target) && (
                    <p className="mt-0.5 font-mono text-[11px] text-accent">{formatTarget(entry.target)}</p>
                  )}
                  {detail && (
                    <p className="mt-1 text-xs text-muted">{detail}</p>
                  )}
                  <p className="mt-0.5 text-[11px] text-muted">by {entry.by ?? 'system'}</p>
                </li>
              );
            })}
            {data?.rows.length === 0 && <li className="px-5 py-8 text-center text-muted">Nothing has changed yet.</li>}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
