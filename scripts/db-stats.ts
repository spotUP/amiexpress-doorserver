#!/usr/bin/env npx tsx

/**
 * Door catalog stats — runs anywhere better-sqlite3 is available.
 * Used by the apply-demozoo-bundle workflow to verify the bundle landed
 * without needing sqlite3 on PATH in the doorserver container.
 *
 * Usage:
 *   npx tsx scripts/db-stats.ts [/path/to/doors.db]
 */

import Database from 'better-sqlite3';
import { loadConfig } from '../src/config';

const dbPath = process.argv[2];
const db = dbPath ? new Database(dbPath, { readonly: true }) : (() => {
  const cfg = loadConfig();
  return new Database(cfg.dbPath, { readonly: true });
})();

const bySource = db.prepare(`SELECT source, COUNT(*) as n FROM door_catalog GROUP BY source ORDER BY n DESC`).all() as any[];
const withDz = db.prepare(`SELECT COUNT(*) as n FROM door_catalog WHERE demozoo_url IS NOT NULL`).get() as { n: number };
const total = db.prepare(`SELECT COUNT(*) as n FROM door_catalog`).get() as { n: number };

console.log(JSON.stringify({
  total: total.n,
  withDemozooUrl: withDz.n,
  bySource: bySource.reduce((acc: any, r: any) => { acc[r.source] = r.n; return acc; }, {}),
}, null, 2));

db.close();
