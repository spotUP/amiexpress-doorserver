/**
 * A FILE_ID.DIZ verbatim.
 *
 * Every character matters: these are pictures drawn with text, in Latin-1,
 * on an 80-column screen. So: monospace, whitespace preserved, no wrapping,
 * and a horizontal scrollbar rather than a reflow that would break the art.
 */
import * as ScrollArea from '@radix-ui/react-scroll-area';

export function DizView({ text, label }: { text: string; label: string }) {
  if (!text) {
    return <p className="text-sm text-muted">No {label} in this archive.</p>;
  }
  return (
    <ScrollArea.Root className="overflow-hidden rounded-md border border-line bg-bg">
      <ScrollArea.Viewport className="max-h-[26rem] w-full">
        <pre
          className="w-max px-4 py-3 font-mono text-[12px] leading-[1.35] text-ink"
          aria-label={label}
        >
          {text}
        </pre>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation="horizontal" className="flex h-2 touch-none bg-surface">
        <ScrollArea.Thumb className="rounded bg-line" />
      </ScrollArea.Scrollbar>
      <ScrollArea.Scrollbar orientation="vertical" className="flex w-2 touch-none bg-surface">
        <ScrollArea.Thumb className="rounded bg-line" />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
}
