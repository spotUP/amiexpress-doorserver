/**
 * Reader for the hub's plain-text variants (src/chat/render.ts renderText):
 * header `NAME|1|<revision>|<count>`, one `|` row per line, CRLF, Latin-1.
 *
 * Searched first for a reusable parser (src/chat, contract/, tests/): none
 * exists. The hub only writes this format, and the tests split it inline
 * (`rowsOf`). Column names come from contract/chat-types.ts so the bridge
 * and the hub cannot drift; the bridge imports the contract, never hub internals.
 */
import { CHAT_TEXT_FORMATS } from '../../contract/chat-types';

export interface TextTable {
  name: string;
  version: number;
  revision: number;
  rows: string[][];
}

/** Decode the Latin-1 body of a text variant. */
export function decodeBody(buf: Buffer): string {
  return buf.toString('latin1');
}

export function parseTextTable(body: string): TextTable {
  const lines = body.split('\r\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const head = (lines[0] ?? '').split('|');
  if (head.length < 4) throw new Error(`not a hub text table: ${JSON.stringify((lines[0] ?? '').slice(0, 60))}`);
  const rows = lines.slice(1).map((l) => l.split('|'));
  const count = Number(head[3]);
  if (count !== rows.length) throw new Error(`${head[0]} header says ${head[3]} rows, body has ${rows.length}`);
  return { name: head[0], version: Number(head[1]), revision: Number(head[2]), rows };
}

export interface BridgeEvent {
  seq: number;
  type: string;
  room: string;
  user: string;
  ref: string;
  at: string;
  roleColor: string;
  text: string;
  replyTo: string;
  label: string;
}

const EVENT_COLUMNS = CHAT_TEXT_FORMATS.EVENTS.length;

export function parseEvents(body: string): { revision: number; events: BridgeEvent[] } {
  const t = parseTextTable(body);
  if (t.name !== 'EVENTS') throw new Error(`expected EVENTS, got ${t.name}`);
  const events = t.rows.map((r) => {
    // Older hubs send fewer columns: pad rather than read undefined.
    const c = [...r];
    while (c.length < EVENT_COLUMNS) c.push('');
    return { seq: Number(c[0]), type: c[1], room: c[2], user: c[3], ref: c[4], at: c[5], roleColor: c[6], text: c[7], replyTo: c[8], label: c[9] };
  });
  return { revision: t.revision, events };
}
