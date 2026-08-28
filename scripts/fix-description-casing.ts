/**
 * Batch-apply fixCasing to every description in the catalog.
 *
 * For doors without a human override, derives the description from the DIZ via
 * the classifier, applies fixCasing, and writes the result as an override.
 * For doors that already have an override, applies fixCasing in place.
 *
 * Dry-run by default: pass --apply to actually write.
 */
import Database from 'better-sqlite3';
import { applySchema } from '../src/db';
import { analyseDoor, fixCasing } from '../src/describe';
import { corpusGroupTags } from '../src/catalog';
import type { DoorCatalogRow } from '../src/manifest';

const DB_PATH = process.env.DOORSERVER_DB ?? '/data/doors.db';
const DRY_RUN = !process.argv.includes('--apply');

interface CatalogRow extends DoorCatalogRow {
  description_overridden: number;
}

interface OverrideRow {
  catalog_id: string;
  field: string;
  value: string | null;
}

function run() {
  const db = new Database(DB_PATH);
  applySchema(db);

  const groupTags = corpusGroupTags(db);
  const rows = db.prepare('SELECT * FROM door_catalog').all() as CatalogRow[];
  const existingOverrides = new Map<string, string | null>();
  for (const row of db.prepare('SELECT catalog_id, value FROM door_catalog_overrides WHERE field = ?').all('description') as OverrideRow[]) {
    existingOverrides.set(row.catalog_id, row.value);
  }

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  const upsert = db.prepare(
    `INSERT INTO door_catalog_overrides (catalog_id, field, value, edited_by, edited_at)
     VALUES (?, 'description', ?, NULL, strftime('%s','now'))
     ON CONFLICT(catalog_id, field) DO UPDATE SET
       value = excluded.value, edited_by = NULL, edited_at = excluded.edited_at`
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      let derived: string;
      if (row.description_overridden && existingOverrides.has(row.id)) {
        // Human already edited this — fix the existing override in place
        derived = existingOverrides.get(row.id)!;
      } else {
        // Derive from DIZ via the classifier
        derived = analyseDoor(
          {
            dizText: row.file_id_diz,
            name: row.name,
            archiveName: row.archive_name,
            binaryName: row.binary_name,
            catalogVersion: null,
            catalogAuthor: row.author,
          },
          groupTags
        ).description;
      }

      const fixed = fixCasing(derived);
      if (fixed === derived) {
        unchanged++;
        continue;
      }

      updated++;
      if (!DRY_RUN) {
        upsert.run(row.id, fixed);
      }

      if (updated <= 5 || updated % 500 === 0) {
        console.log(`  [${DRY_RUN ? 'dry-run' : 'applied'}] ${row.archive_name}: "${derived}" -> "${fixed}"`);
      }
    }
  });

  tx();
  db.close();

  console.log(`\n${updated} updated, ${unchanged} unchanged, ${rows.length} total${DRY_RUN ? ' (dry-run, pass --apply to write)' : ''}`);
}

run();
