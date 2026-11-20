/**
 * Wire saver for the LIVECHAT engine path (livechat-host.ts).
 *
 * The door repaints with one SGR run per fragment (its glitch header is ~25
 * cursor-addressed 1-3 char writes, each re-asserting the same attributes), so
 * a keystroke costs ~1 KB where the hub's own screen costs ~1 byte. An SGR
 * byte-identical to the one already in effect re-asserts the same rendition
 * and cannot change the caller's terminal, so it is dropped. RIS/DECSTR reset
 * the rendition and clear the tracker; anything else keeps it. A miss only
 * costs bytes, never correctness: only exact-duplicate SGRs are dropped.
 */
export class SgrDedupe {
  private last: string | null = null;

  /** The D bytes to forward: the input string minus redundant SGR runs. */
  filter(s: string): string {
    return s.replace(/\x1b\[[0-9;:?]*m|\x1bc|\x1b\[!p/g, (m) => {
      if (m === '\x1bc' || m === '\x1b[!p') { this.last = null; return m; }
      if (m === this.last) return '';
      this.last = m;
      return m;
    });
  }
}
