/**
 * Seasons: a quarter, named YYYYQn, with UTC boundaries.
 *
 * The season lives on the unlock row, so a "reset" is nothing but the next
 * id. This file holds the naming and the ensure-the-row half that the write
 * path needs from AC-10 on; AC-15 adds the close - the winner, the
 * five-player floor - behind the same ensureCurrentSeason() hook (D12: no
 * scheduler, the top of every write request is the clock).
 */
import type Database from 'better-sqlite3';

export function seasonIdAt(nowSeconds: number): string {
  const d = new Date(nowSeconds * 1000);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}Q${q}`;
}

/** [starts_at, ends_at) of the quarter holding `nowSeconds`, epoch seconds. */
export function seasonBoundsAt(nowSeconds: number): { startsAt: number; endsAt: number } {
  const d = new Date(nowSeconds * 1000);
  const year = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3);
  const startsAt = Date.UTC(year, q * 3, 1) / 1000;
  const endsAt = (q === 3 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, (q + 1) * 3, 1)) / 1000;
  return { startsAt, endsAt };
}

/** The current season's id, creating its row if this is its first write. */
export function ensureCurrentSeason(db: Database.Database, nowSeconds: number): string {
  const id = seasonIdAt(nowSeconds);
  const { startsAt, endsAt } = seasonBoundsAt(nowSeconds);
  db.prepare(
    `INSERT INTO seasons (id, starts_at, ends_at, closed_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(id) DO NOTHING`
  ).run(id, startsAt, endsAt);
  return id;
}
