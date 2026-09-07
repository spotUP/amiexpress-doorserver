/**
 * The ONE escaper for every plain-text format this server serves.
 *
 * list.txt (the door repo) and catalog.txt / leaderboard.txt (achievements)
 * are parsed by the same kind of client - a 68K door with a line reader
 * and a pipe splitter - and a parser written against one must not mis-read
 * the other. So the three functions that decide what a text field may
 * contain live here, once, and both renderers import them. Moved verbatim
 * out of src/manifest.ts on 2026-09-07 (AC-12); manifest.ts re-exports
 * toLatin1Safe so nothing that imported it from there breaks.
 */

export function esc(s: string): string {
  return s.replace(/\|/g, '!');
}

export function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ');
}

// `Buffer.from(str, 'latin1')` never throws on a character outside the
// ISO-8859-1 range: it silently truncates each UTF-16 code unit to its
// low byte (e.g. Cyrillic U+0416 becomes byte 0x16, an unrelated control
// character), producing a valid-looking but WRONG byte, not an error and
// not a visible marker. Against the real catalog this affects a handful of
// rows with non-ASCII metadata (accented names not in precomposed form,
// stray Unicode punctuation, etc.). Since these bytes are parsed by a real
// Amiga client with no Unicode awareness, an explicit '?' substitution is
// preferable to that silent corruption.
//
// Iterates by Unicode code point (not UTF-16 code unit), so an astral
// character encoded as a surrogate pair collapses to exactly one '?'
// ("a single '?' per character"), not two.
export function toLatin1Safe(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp <= 0xff ? ch : '?';
  }
  return out;
}

