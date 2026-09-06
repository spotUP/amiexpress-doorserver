/**
 * The catalog's fingerprint.
 *
 * `a<count>-t<newest updated_at>` - the same shape getCatalogRevision() uses
 * for the door repo (src/catalog.ts), and for the same reason: it is never a
 * git SHA, because a deploy that changed no achievement must not invalidate
 * a good client's cache. A 68K door that has the catalog it asked for last
 * week can compare two short ASCII strings and stop.
 *
 * It is computed here rather than in the router because it is a fact about
 * the catalog, and AC-11's seeding and AC-12's endpoints are the rest of
 * this module.
 */
import type Database from 'better-sqlite3';

export function catalogRevision(db: Database.Database): string {
  const row = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS t FROM achievements")
    .get() as { n: number; t: number };
  return `a${row.n}-t${row.t}`;
}
