/**
 * Fill door_catalog.requires_bbs from each door's FILE_ID.DIZ.
 *
 *   DOORSERVER_DB=/data/doors.db DOOR_ARCHIVES_ROOT=/data/Archives \
 *     node dist/scripts/backfill-requires.js [--dry-run]
 *
 * Reads the requirement with the same rules the API uses (src/describe.ts),
 * so the column and a freshly-rendered row can never disagree. Safe to
 * re-run: it rewrites the column from the DIZ every time, and a row whose
 * DIZ names no BBS version is set back to NULL rather than left stale.
 */
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { runMigrations } from '../src/migrations';
import { analyseDoor, buildGroupTags } from '../src/describe';

interface Row {
  id: string;
  archive_name: string;
  binary_name: string | null;
  name: string;
  version: string | null;
  author: string | null;
  file_id_diz: string | null;
  requires_bbs: string | null;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = loadConfig();
  const db = openDb(cfg);
  try {
    const ran = runMigrations(db);
    for (const step of ran) console.log(`[INFO] migration ${step}`);

    const rows = db
      .prepare(
        `SELECT id, archive_name, binary_name, name, version, author, file_id_diz, requires_bbs
           FROM door_catalog`
      )
      .all() as Row[];
    const groupTags = buildGroupTags(rows.map((r) => r.archive_name));
    const update = db.prepare('UPDATE door_catalog SET requires_bbs = ? WHERE id = ?');

    let changed = 0;
    let found = 0;
    const write = db.transaction((pending: [string | null, string][]) => {
      for (const [value, id] of pending) update.run(value, id);
    });

    const pending: [string | null, string][] = [];
    for (const r of rows) {
      const facts = analyseDoor(
        {
          dizText: r.file_id_diz,
          name: r.name,
          archiveName: r.archive_name,
          binaryName: r.binary_name,
          catalogVersion: r.version,
          catalogAuthor: r.author,
        },
        groupTags
      );
      const value = facts.requiresBbs || null;
      if (value) found++;
      if (value !== r.requires_bbs) {
        changed++;
        pending.push([value, r.id]);
      }
    }

    if (!dryRun) write(pending);
    console.log(
      `[OK] ${found} of ${rows.length} doors name a BBS version; ${changed} rows ${dryRun ? 'would change' : 'updated'}`
    );
  } finally {
    db.close();
  }
}

main();
