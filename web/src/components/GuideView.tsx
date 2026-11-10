/**
 * An AmigaGuide document, read the way it was meant to be read.
 *
 * 1125 of the 3218 documented doors in this corpus ship a .guide rather than
 * a README: hypertext with @node sections and links between them. Shown raw
 * it is markup; shown like this it is documentation - a node list down the
 * side, the node's own text in Topaz, and its links as buttons that jump.
 *
 * Parsed server-side by the BBS's own AmigaGuide parser, so a door's
 * documentation reads the same here as it does on the board.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, BookOpen } from 'lucide-react';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import type { Guide } from '../api/types';
import { Button, cx } from './ui';

export function GuideView({ guide }: { guide: Guide }) {
  const [nodeName, setNodeName] = useState(guide.mainNode);
  const [history, setHistory] = useState<string[]>([]);

  // A different door means a different document: start at its own main node.
  useEffect(() => {
    setNodeName(guide.mainNode);
    setHistory([]);
  }, [guide]);

  const node = guide.nodes.find((n) => n.name === nodeName) ?? guide.nodes[0];

  function go(target: string) {
    if (!guide.nodes.some((n) => n.name === target)) return;
    setHistory((previous) => [...previous, nodeName]);
    setNodeName(target);
  }

  function back() {
    setHistory((previous) => {
      const target = previous[previous.length - 1];
      if (target) setNodeName(target);
      return previous.slice(0, -1);
    });
  }

  return (
    <div className="grid gap-3 md:grid-cols-[13rem_1fr]">
      <aside className="hidden md:block">
        <p className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-muted">
          <BookOpen size={13} /> {guide.database || 'Contents'}
        </p>
        <ScrollArea.Root className="overflow-hidden rounded-md border border-line">
          <ScrollArea.Viewport className="max-h-[24rem]">
            <ul className="p-1">
              {guide.nodes.map((entry) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    onClick={() => go(entry.name)}
                    className={cx(
                      'w-full truncate rounded px-2 py-1 text-left text-xs',
                      entry.name === node?.name ? 'bg-accent-dim text-ink' : 'text-muted hover:bg-raised hover:text-ink'
                    )}
                    title={entry.title || entry.name}
                  >
                    {entry.title || entry.name}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="vertical" className="flex w-2 bg-surface">
            <ScrollArea.Thumb className="rounded bg-line" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      </aside>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {history.length > 0 && (
            <Button variant="ghost" onClick={back}>
              <ArrowLeft size={13} /> Back
            </Button>
          )}
          <h3 className="text-sm text-ink">{node?.title || node?.name}</h3>
        </div>

        <ScrollArea.Root className="overflow-hidden rounded-md border border-line bg-bg">
          <ScrollArea.Viewport className="max-h-[26rem] w-full">
            <pre className="w-max px-4 py-3 font-amiga text-[15px] leading-[1.2] text-ink">{node?.content}</pre>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="horizontal" className="flex h-2 bg-surface">
            <ScrollArea.Thumb className="rounded bg-line" />
          </ScrollArea.Scrollbar>
          <ScrollArea.Scrollbar orientation="vertical" className="flex w-2 bg-surface">
            <ScrollArea.Thumb className="rounded bg-line" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>

        {node && node.links.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {node.links.map((link, index) => (
              <Button key={`${link.target}-${index}`} onClick={() => go(link.target)}>
                {link.text || link.target}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
