/**
 * @name completion for the Partyline input, a copy of LIVECHAT utils/at-completion.ts:
 * Tab completes the @token at the end of the line against the room's users, a
 * repeated Tab on the unchanged line cycles to the next match, and the draw shows
 * the dim ghost tail of the first match after the cursor.
 */
export interface AtCycle { head: string; matches: string[]; index: number; produced: string }

const AT_TOKEN_AT_END = /(^|[^\w@])@([\w@.-]*)$/;

function atTokenAtEnd(text: string): { head: string; prefix: string } | null {
  const m = AT_TOKEN_AT_END.exec(text);
  return m ? { head: text.slice(0, m.index + m[1].length), prefix: m[2] } : null;
}

export function completeAtMention(text: string, members: string[], cycle: AtCycle | null): { value: string; cycle: AtCycle } | null {
  if (cycle && cycle.produced === text && cycle.matches.length > 0) {
    const index = (cycle.index + 1) % cycle.matches.length;
    const value = `${cycle.head}@${cycle.matches[index]}`;
    return { value, cycle: { ...cycle, index, produced: value } };
  }
  const token = atTokenAtEnd(text);
  if (!token) return null;
  const want = token.prefix.toLowerCase(), seen = new Set<string>(), matches: string[] = [];
  for (const id of members) {
    const key = id.toLowerCase();
    if (!key.startsWith(want) || seen.has(key)) continue;
    seen.add(key);
    matches.push(id);
  }
  if (matches.length === 0) return null;
  const value = `${token.head}@${matches[0]}`;
  return { value, cycle: { head: token.head, matches, index: 0, produced: value } };
}

export function atGhostTail(text: string, members: string[]): string {
  const done = completeAtMention(text, members, null);
  return done ? done.value.slice(text.length) : '';
}
