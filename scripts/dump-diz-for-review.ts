/**
 * Dump door_catalog rows so the curator can compare the catalog's `name`
 * to what the FILE_ID.DIZ actually says. The DIZ is already stored in
 * the catalog (door_catalog.file_id_diz), so no archive reads needed.
 *
 * Usage on the VPS:
 *   DOORSERVER_DB=/data/doors.db \
 *     node dist/scripts/dump-diz-for-review.js > /tmp/diz-review.tsv
 *
 * Output is TSV (tab-separated) so it pastes cleanly into a spreadsheet:
 *   id<TAB>archive_name<TAB>current_name<TAB>current_description<TAB>diz_text
 *
 * Only rows that have a FILE_ID.DIZ and at least one non-trivial word
 * in the DIZ are emitted; doors with no DIZ are skipped.
 */
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';

interface Row {
  id: string;
  archive_name: string;
  name: string;
  description: string | null;
  file_id_diz: string | null;
}

function main(): void {
  const cfg = loadConfig();
  const db = openDb(cfg);
  try {
    const rows = db
      .prepare(
        `SELECT id, archive_name, name, description, file_id_diz
           FROM door_catalog
          WHERE file_id_diz IS NOT NULL AND length(file_id_diz) > 0
          ORDER BY archive_name`
      )
      .all() as Row[];

    // Header
    process.stdout.write(['id', 'archive_name', 'current_name', 'current_description', 'diz_text'].join('\t') + '\n');
    for (const r of rows) {
      const diz = (r.file_id_diz ?? '').replace(/[\t\r\n]+/g, ' ');
      const desc = (r.description ?? '').replace(/[\t\r\n]+/g, ' ');
      process.stdout.write([r.id, r.archive_name, r.name, desc, diz].join('\t') + '\n');
    }
    process.stderr.write(`[OK] dumped ${rows.length} rows\n`);
  } finally {
    db.close();
  }
}

main();
