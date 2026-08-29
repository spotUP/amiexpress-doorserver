/**
 * A FILE_ID.DIZ verbatim.
 *
 * PC-DOS / demoscene FILE_ID.DIZ files are Latin-1 text that may carry
 * SGR ANSI escape codes (\\x1B[...m) for foreground/background colour and
 * bold/underline. Amiga DIZs are usually plain Latin-1, no escape codes.
 * ansi_up converts either form to inline-styled HTML; on plain text it
 * returns the text verbatim.
 *
 * Every character matters: these are pictures drawn with text, in Latin-1,
 * on an 80-column screen. So: monospace, whitespace preserved, no wrapping,
 * and a horizontal scrollbar rather than a reflow that would break the art.
 */
import * as ScrollArea from '@radix-ui/react-scroll-area';
import { AnsiUp } from 'ansi_up';

const ANSI = new AnsiUp();
ANSI.use_classes = true;

export function DizView({ text, label }: { text: string; label: string }) {
  if (!text) {
    return <p className="text-sm text-muted">No {label} in this archive.</p>;
  }
  // ansi_to_html returns sanitised HTML. For text without escape codes
  // it is a verbatim passthrough; for DIZs with SGR codes it wraps
  // spans around the colour runs.
  const html = ANSI.ansi_to_html(text);
  return (
    <ScrollArea.Root className="overflow-hidden rounded-md border border-line bg-bg">
      <ScrollArea.Viewport className="max-h-[26rem] w-full">
        <pre
          className="w-max px-4 py-3 font-amiga text-[15px] leading-[1.2] text-ink ansi-diz"
          aria-label={label}
          dangerouslySetInnerHTML={{ __html: html }}
        />
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
