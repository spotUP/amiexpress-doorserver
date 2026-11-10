/**
 * The requests plain-text variants, byte for byte.
 *
 * House format from leaderboard.txt: a header line naming the format, the
 * version, the revision and the row count, then one row per line, CRLF
 * including after the LAST row, `Content-Type: text/plain; charset=ISO-8859-1`.
 * The SAME escaper leaderboard.txt uses - imported, never re-implemented, so a
 * 68K parser written against one reads the other.
 *
 *   REQUEST|1|<revision>|<count>CRLF
 *   <id>|<kind>|<state>|<votes>|<board>|<handle>|<title>|<claim_handle>|<created>|<updated>CRLF
 *
 * kind is release/art and state is open|claimed|done|withdrawn - plain words a
 * C89 client tests with strcmp, never a code to decode. created/updated are
 * epoch seconds: integers a client with no date library can still order by.
 * Append-only: a new field goes on the END and the `1` never moves.
 */
import { esc, oneLine, toLatin1Safe } from '../text-format';
import { REQUESTS_TEXT_FORMAT, REQUESTS_TEXT_VERSION, REQUEST_CAPS } from '../../contract/request-types';
import type { RequestDetail, RequestRow } from '../../contract/request-types';

const HEADER = `${REQUESTS_TEXT_FORMAT}|${REQUESTS_TEXT_VERSION}`;

/** A display string field, capped and made pipe- and Latin-1-safe. */
function field(s: string | null, cap: number): string {
  return toLatin1Safe(esc(oneLine(s ?? ''))).slice(0, cap);
}

function epoch(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function rowLine(r: RequestRow): string {
  return [
    String(r.id),
    r.kind,
    r.state,
    String(r.votes),
    field(r.board, 32),
    field(r.handle, REQUEST_CAPS.handle),
    field(r.title, REQUEST_CAPS.title),
    field(r.claimHandle, REQUEST_CAPS.handle),
    String(epoch(r.createdAt)),
    String(epoch(r.updatedAt)),
  ].join('|');
}

/** GET /list.txt */
export function renderListTxt(revision: string, rows: RequestRow[]): Buffer {
  const lines = [`${HEADER}|${revision}|${rows.length}`];
  for (const r of rows) lines.push(rowLine(r));
  return Buffer.from(lines.join('\r\n') + '\r\n', 'latin1');
}

/**
 * GET /requests/<id>.txt: the header line, the row, a blank line, then the
 * notes as free text for the door's word-wrapped pager. The notes are the
 * only free-text block, so they come last and are one logical line.
 */
export function renderDetailTxt(detail: RequestDetail): Buffer {
  const revision = `r1-t${epoch(detail.updatedAt)}`;
  const parts = [`${HEADER}|${revision}|1`, rowLine(detail), '', toLatin1Safe(oneLine(detail.notes))];
  return Buffer.from(parts.join('\r\n') + '\r\n', 'latin1');
}
