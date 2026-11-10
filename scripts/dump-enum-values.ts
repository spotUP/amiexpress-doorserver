/**
 * Dump distinct door_type and category values from the live catalog.
 * Used to populate the select-button options in the admin dialog.
 *
 *   DOORSERVER_DB=/data/doors.db \
 *     node dist/scripts/dump-enum-values.js
 */
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';

function main(): void {
  const cfg = loadConfig();
  const db = openDb(cfg);
  try {
    for (const col of ['door_type', 'category'] as const) {
      const rows = db
        .prepare(`SELECT ${col} AS value, COUNT(*) AS n FROM door_catalog WHERE ${col} IS NOT NULL AND ${col} <> '' GROUP BY value ORDER BY n DESC`)
        .all() as { value: string; n: number }[];
      console.log(`# ${col}`);
      for (const r of rows) console.log(`${r.n}\t${r.value}`);
      console.log();
    }
  } finally {
    db.close();
  }
}

main();
