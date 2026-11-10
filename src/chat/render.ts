/**
 * The chat plain-text variants, byte for byte. Same house format and the same
 * escaper as leaderboard.txt and the requests surface: a header line
 * `NAME|1|<revision>|<count>`, one row per line, CRLF after every line
 * including the last, Latin-1.
 */
import type { Response } from 'express';
import { CHAT_DISCORD_BOARD, CHAT_DISCORD_MARKER, CHAT_TEXT_VERSION } from '../../contract/chat-types';
import { esc, oneLine, toLatin1Safe } from '../text-format';

export function f(v: string | number | null | undefined): string {
  return toLatin1Safe(esc(oneLine(String(v ?? ''))));
}

export function renderText(name: string, revision: number | string, rows: (string | number)[][]): Buffer {
  const lines = [`${name}|${CHAT_TEXT_VERSION}|${revision}|${rows.length}`];
  for (const r of rows) lines.push(r.map((x) => f(x)).join('|'));
  return Buffer.from(lines.map((l) => l + '\r\n').join(''), 'latin1');
}

/** Send a text body with an exact Content-Length and no keep-alive, never chunked. */
export function sendText(res: Response, body: Buffer): void {
  res.status(200);
  res.set('Content-Type', 'text/plain; charset=ISO-8859-1');
  res.set('Content-Length', String(body.length));
  res.set('Connection', 'close');
  res.end(body);
}

/**
 * D7 display labels. Every user shows as the bare handle; when two different
 * users in `users` share a handle (case-insensitive) those two, and only
 * those, keep `@BOARD`. `users` is everyone present in what the caller
 * renders: the rows themselves plus the room's members.
 */
export function displayLabels(users: Iterable<string>): Map<string, string> {
  const byHandle = new Map<string, Set<string>>();
  const all = new Set<string>();
  for (const u of users) {
    if (!u) continue;
    all.add(u);
    const at = u.lastIndexOf('@');
    const h = (at > 0 ? u.slice(0, at) : u).toLowerCase();
    const set = byHandle.get(h) ?? new Set<string>();
    set.add(u.toLowerCase());
    byHandle.set(h, set);
  }
  const out = new Map<string, string>();
  for (const u of all) {
    const at = u.lastIndexOf('@');
    const handle = at > 0 ? u.slice(0, at) : u;
    out.set(u, (byHandle.get(handle.toLowerCase())?.size ?? 0) > 1 ? u : handle);
  }
  return out;
}

const DISCORD_SUFFIX = '@' + CHAT_DISCORD_BOARD.toUpperCase();

/** D7: a Discord-origin message's text, as callers see it, ends in ` [Discord]`. */
export function markOrigin(user: string, text: string): string {
  return user.toUpperCase().endsWith(DISCORD_SUFFIX) ? text + CHAT_DISCORD_MARKER : text;
}
