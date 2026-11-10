/**
 * AC-1 - RED. Eleven symptoms, named the way a board author would name them.
 *
 * No production code exists for any of these yet, and that is the point:
 * every test here FAILS on arrival, and each one names a user-visible
 * symptom rather than a function. As the tasks that own them turn them
 * GREEN, each test MOVES (not copies) into that task's own suite - AC-4
 * takes SYM-2 and SYM-3, AC-5 takes SYM-1, AC-7 takes SYM-4, AC-8 takes
 * SYM-5, AC-9 takes SYM-6/7/8, AC-12 takes SYM-9, AC-13 takes SYM-10 and
 * AC-15 takes SYM-11 - and AC-20's ledger records which task closed which.
 *
 * MOVED OUT SO FAR: SYM-2 and SYM-3 now live in
 * tests/achievements/boards.test.ts, where they are GREEN (AC-4); SYM-4 now
 * lives in tests/achievements/players.test.ts, GREEN (AC-7).
 *
 * SYM-5, SYM-6, SYM-7 and SYM-8 now live in tests/achievements/events.test.ts,
 * GREEN (AC-9), adapted to a world with players and links; SYM-9 lives in
 * tests/achievements/catalog.test.ts, GREEN (AC-12); SYM-10 in
 * tests/achievements/door-catalog.test.ts, GREEN (AC-13). The RED versions
 * posted for an address nobody had registered, which AC-9 rejects before it
 * ever reaches the behaviour they were written to catch.
 *
 * SYM-1 CLOSED BY AC-9: it asked for POST /events to exist behind the
 * mounted surface. AC-5 delivered the mount and its headers
 * (tests/achievements/mount.test.ts); AC-9 delivered the endpoint, and every
 * test in tests/achievements/events.test.ts drives it.
 *
 * Every test drives the REAL app: `createApp(cfg)` over HTTP through
 * supertest, exactly as tests/routes.test.ts does. Never a router, never a
 * handler, never a function in isolation. A test that passes here is
 * mis-specified and is rewritten before AC-2 starts.
 */
/**
 * Where every symptom went. This file is the RED ledger AC-1 wrote; by
 * AC-15 every test in it had moved into the suite of the task that turned
 * it green, and what remains is the map - checked, so a renamed suite does
 * not silently orphan a symptom's provenance.
 */
import * as fs from 'fs';
import * as path from 'path';

const HOMES: Record<string, string> = {
  'SYM-1': 'mount.test.ts',        // AC-5 mounted the surface; AC-9 gave it POST /events
  'SYM-2': 'boards.test.ts',       // AC-4
  'SYM-3': 'boards.test.ts',       // AC-4
  'SYM-4': 'players.test.ts',      // AC-7
  'SYM-5': 'events.test.ts',       // AC-9 (the link itself: links.test.ts, AC-8)
  'SYM-6': 'events.test.ts',       // AC-9
  'SYM-7': 'events.test.ts',       // AC-9
  'SYM-8': 'events.test.ts',       // AC-9
  'SYM-9': 'catalog.test.ts',      // AC-12
  'SYM-10': 'door-catalog.test.ts', // AC-13
  'SYM-11': 'leaderboard.test.ts', // AC-15
};

describe('the RED file, emptied', () => {
  it('every symptom has a home suite, and it exists', () => {
    for (const [sym, file] of Object.entries(HOMES)) {
      const full = path.join(__dirname, file);
      expect(fs.existsSync(full)).toBe(true);
      // SYM-1's assertion was split between the mount and the endpoint; the
      // rest carry their name into the suite that owns them.
      if (sym !== 'SYM-1' && !['SYM-2', 'SYM-3'].includes(sym)) {
        expect(fs.readFileSync(full, 'utf8')).toContain(sym);
      }
    }
  });
});
