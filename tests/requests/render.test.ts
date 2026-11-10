/**
 * list.txt and requests/<id>.txt: the house format, the same escaper.
 *
 * Expected bytes are built in code as Latin-1 byte arrays and compared with
 * Buffer.compare, never written as UTF-8 source text - the leaderboard.txt
 * precedent.
 */
import { renderDetailTxt, renderListTxt } from '../../src/requests/render';
import type { RequestDetail, RequestRow } from '../../contract/request-types';

function isoOf(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

function row(over: Partial<RequestRow> = {}): RequestRow {
  return {
    id: 103,
    kind: 'release',
    state: 'open',
    votes: 12,
    board: 'uprough',
    handle: 'Spot',
    title: 'Fairlight - Nexus 7 (AGA)',
    claimHandle: null,
    createdAt: isoOf(1000),
    updatedAt: isoOf(2000),
    ...over,
  };
}

describe('list.txt', () => {
  it('is ISO-8859-1 with CRLF after every row and a header naming the count', () => {
    const rows = [
      row(),
      row({ id: 102, kind: 'art', state: 'claimed', votes: 8, handle: 'Phantasm', title: 'Login screen for /X', claimHandle: 'Rebel', createdAt: isoOf(500), updatedAt: isoOf(1500) }),
    ];
    const bytes = renderListTxt('r2-t2000', rows);
    const expected = Buffer.from(
      'REQUEST|1|r2-t2000|2\r\n' +
        '103|release|open|12|uprough|Spot|Fairlight - Nexus 7 (AGA)||1000|2000\r\n' +
        '102|art|claimed|8|uprough|Phantasm|Login screen for /X|Rebel|500|1500\r\n',
      'latin1'
    );
    expect(Buffer.compare(bytes, expected)).toBe(0);
    expect(bytes.toString('latin1').endsWith('\r\n')).toBe(true);
  });

  it('an empty listing is a valid header line and nothing else', () => {
    const bytes = renderListTxt('r0-t0', []);
    expect(Buffer.compare(bytes, Buffer.from('REQUEST|1|r0-t0|0\r\n', 'latin1'))).toBe(0);
  });

  it('escapes a pipe to !, folds a newline to a space, and the row count still matches the lines', () => {
    const rows = [
      row({ id: 1, handle: 'Pi|pe', title: 'a|b\nc', claimHandle: null }),
      row({ id: 2, handle: 'Café \u{1F600}', title: 'x', claimHandle: null }),
    ];
    const bytes = renderListTxt('r2-t2000', rows);
    const expected = Buffer.concat([
      Buffer.from('REQUEST|1|r2-t2000|2\r\n1|release|open|12|uprough|Pi!pe|a!b c||1000|2000\r\n2|release|open|12|uprough|Caf', 'latin1'),
      Buffer.from([0xe9]),
      Buffer.from(' ?|x||1000|2000\r\n', 'latin1'),
    ]);
    expect(Buffer.compare(bytes, expected)).toBe(0);
    const lines = bytes.toString('latin1').split('\r\n');
    // header + 2 rows + trailing '' after last CRLF.
    expect(lines.length - 2).toBe(Number(lines[0].split('|')[3]));
  });
});

describe('requests/<id>.txt', () => {
  it('is the header line, the row, a blank line, then the notes, all CRLF Latin-1', () => {
    const detail: RequestDetail = {
      ...row({ id: 7, votes: 3, title: 'Dopewars source' }),
      notes: 'v1.3 if you have it | any format',
      claimBoard: null,
      doneNote: null,
      claimedAt: null,
      doneAt: null,
    };
    const bytes = renderDetailTxt(detail);
    const expected = Buffer.from(
      'REQUEST|1|r1-t2000|1\r\n' +
        '7|release|open|3|uprough|Spot|Dopewars source||1000|2000\r\n' +
        '\r\n' +
        'v1.3 if you have it | any format\r\n',
      'latin1'
    );
    expect(Buffer.compare(bytes, expected)).toBe(0);
  });
});
