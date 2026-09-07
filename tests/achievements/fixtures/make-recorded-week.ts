#!/usr/bin/env npx tsx
/**
 * The recorded week, generated once (D14).
 *
 * NOT a production capture: no board emits these events until SP2 ships,
 * so there was nothing to record. This script writes recorded-week.jsonl
 * deterministically (a seeded generator, no Date.now), it was read line by
 * line before it was frozen, and it is not regenerated casually -
 * regenerating it means re-auditing recorded-week.expected.json.
 *
 * Timestamps are OFFSETS in seconds from a base the replay chooses (six
 * days and a day before its own clock), because the clamp is relative to the
 * server's receive time: a fixture with absolute dates would drift into
 * the 30-day clamp as it aged. Day 0 is the base; day 6 is replay day.
 *
 * Four callers on three boards, seven days, every operator in the seed:
 *   alice  - links all three boards; a hundred messages, ten conferences, the
 *            file uploads by bytes, a seven-day call streak, a burst, the
 *            snapshot pair (high then lower), the duplicate ref, the
 *            future-stamped event and the 40-day-old one, and x.a earned
 *            again from the second board.
 *   bob    - links uprough only; a few messages, verified.
 *   carol  - registered, never verified: her events are rejected.
 *   dave   - verified, never linked: his events are rejected.
 *
 * Usage: npx tsx tests/achievements/fixtures/make-recorded-week.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const DAY = 86400;
const OUT = path.join(__dirname, 'recorded-week.jsonl');

interface Line {
  day: number;           // which replay batch this belongs to, 0..6
  board: 'uprough' | 'other' | 'third';
  ref: string;
  email: string;
  type: string;
  offset: number;        // seconds from base
  key?: string;
  value?: number;
}

const lines: Line[] = [];
let n = 0;
const ref = (board: string): string => `${board}:01J8Z${String(++n).padStart(21, '0')}`;
function ev(day: number, board: 'uprough' | 'other' | 'third', email: string, type: string, hour: number, extra: Partial<Line> = {}): void {
  lines.push({ day, board, ref: ref(board), email, type, offset: day * DAY + hour * 3600, ...extra });
}

const alice = 'alice@example.com';
const bob = 'bob@example.com';
const carol = 'carol@example.com';
const dave = 'dave@example.com';

// A seven-day call streak for alice, one call at 08:00 each day, hour-keyed.
for (let d = 0; d < 7; d += 1) ev(d, 'uprough', alice, 'presence.call', 8, { key: `hour:0${d}` });

// A hundred messages across ten conferences, days 0-4 (twenty a day).
for (let d = 0; d < 5; d += 1) {
  // Seven minutes apart, so no three of them ever share a five-minute window.
  for (let i = 0; i < 20; i += 1) ev(d, 'uprough', alice, 'msg.post', 9 + (i % 8) + (i * 7) / 60, { key: `conf:${(i % 10) + 1}` });
}
// A burst: three messages inside five minutes on day 5 (offsets in seconds).
for (let i = 0; i < 3; i += 1) {
  lines.push({ day: 5, board: 'uprough', ref: ref('uprough'), email: alice, type: 'msg.post', offset: 5 * DAY + 10 * 3600 + i * 100, key: 'conf:1' });
}
// Uploads by bytes: 60 MB on day 1, 50 MB on day 2 - crosses 100 MB (sum).
ev(1, 'uprough', alice, 'file.upload', 12, { value: 60 * 1024 * 1024 });
ev(2, 'uprough', alice, 'file.upload', 12, { value: 50 * 1024 * 1024 });
// The snapshot pair: file.download 137, then a LOWER 90 the next day.
lines.push({ day: 2, board: 'uprough', ref: `uprough:${alice}:stat:file.download:137`, email: alice, type: 'stat.snapshot', offset: 2 * DAY + 13 * 3600, key: 'file.download', value: 137 });
lines.push({ day: 3, board: 'uprough', ref: `uprough:${alice}:stat:file.download:90`, email: alice, type: 'stat.snapshot', offset: 3 * DAY + 13 * 3600, key: 'file.download', value: 90 });
// The duplicate ref: the same event sent on day 3 and again on day 5.
const dup = { day: 3, board: 'uprough' as const, ref: ref('uprough'), email: alice, type: 'wall.tag', offset: 3 * DAY + 14 * 3600, key: 'conf:1' };
lines.push(dup);
lines.push({ ...dup, day: 5 });
// The future-stamped event: day 3 batch, stamped a full day past replay day.
lines.push({ day: 3, board: 'uprough', ref: ref('uprough'), email: alice, type: 'social.chat', offset: 7 * DAY + 6 * 3600 });
// The 40-day-old event: day 4 batch, stamped 40 days before day 6.
lines.push({ day: 4, board: 'uprough', ref: ref('uprough'), email: alice, type: 'social.vote', offset: 6 * DAY - 40 * DAY });
// Earned again elsewhere: alice's first upload on uprough (day 1) unlocked
// file.up.1; uploads from `other` and `third` on day 6 satisfy it again
// there - three boards, and boards.same.3 fires on the third.
ev(6, 'other', alice, 'file.upload', 15, { value: 1024 });
ev(6, 'third', alice, 'file.upload', 15.5, { value: 2048 });
// One call from a real C64 on the other board.
ev(6, 'other', alice, 'presence.client', 16, { key: 'c64' });

// bob: five messages, a call, an upload.
for (let i = 0; i < 5; i += 1) ev(i, 'uprough', bob, 'msg.post', 20, { key: 'conf:2' });
ev(2, 'uprough', bob, 'presence.call', 20, { key: 'hour:20' });
ev(4, 'uprough', bob, 'file.upload', 21, { value: 4096 });

// carol (unverified) and dave (unlinked): rejected per event.
ev(1, 'uprough', carol, 'msg.post', 11, { key: 'conf:1' });
ev(2, 'uprough', dave, 'msg.post', 11, { key: 'conf:1' });

lines.sort((a, b) => a.day - b.day || a.offset - b.offset || a.ref.localeCompare(b.ref));
fs.writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
console.log(`[OK] wrote ${lines.length} events to ${path.relative(process.cwd(), OUT)}`);
