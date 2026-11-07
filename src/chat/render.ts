/**
 * The chat plain-text variants, byte for byte. Same house format and the same
 * escaper as leaderboard.txt and the requests surface: a header line
 * `NAME|1|<revision>|<count>`, one row per line, CRLF after every line
 * including the last, Latin-1.
 */
import type { Response } from 'express';
import { CHAT_TEXT_VERSION } from '../../contract/chat-types';
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
