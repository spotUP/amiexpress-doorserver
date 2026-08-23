/**
 * Copies the door catalog out of the BBS database into the door server's.
 *
 * ATTACH + INSERT SELECT, never a SQL text dump: doc_raw carries form
 * feeds, ANSI and other control bytes, and dumping it to text and back has
 * mangled it before. The per-node columns (installed, installed_as,
 * install_dir) are deliberately not copied - they describe one node and
 * move to that node's own door_installs table.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { applySchema } from '../src/db';

const COLUMNS = [
  'id', 'archive_name', 'archive_path', 'binary_name', 'door_type', 'name', 'version',
  'author', 'release_group', 'description', 'file_id_diz', 'doc_filename', 'doc_raw',
  'suggested_tooltypes', 'category', 'archive_size', 'junk_count', 'corpus_id', 'source',
  'indexed_at', 'md5', 'sha256',
];

export interface MigrationCounts {
  entries: number;
  files: number;
}

export function migrateFromBbs(opts: { sourceDb: string; targetDb: string }): MigrationCounts {
  if (!fs.existsSync(opts.sourceDb)) {
    throw new Error(`source database ${opts.sourceDb} does not exist`);
  }
  const db = new Database(opts.targetDb);
  try {
    applySchema(db);
    db.prepare('ATTACH DATABASE ? AS src').run(opts.sourceDb);
    try {
      const cols = COLUMNS.join(', ');
      db.exec(`INSERT OR REPLACE INTO main.door_catalog (${cols}) SELECT ${cols} FROM src.door_catalog`);
      db.exec(
        `INSERT OR REPLACE INTO main.door_catalog_files (catalog_id, path, size, is_junk, junk_reason)
         SELECT catalog_id, path, size, is_junk, junk_reason FROM src.door_catalog_files`
      );
      const entries = (db.prepare('SELECT COUNT(*) AS n FROM main.door_catalog').get() as { n: number }).n;
      const files = (db.prepare('SELECT COUNT(*) AS n FROM main.door_catalog_files').get() as { n: number }).n;
      return { entries, files };
    } finally {
      db.exec('DETACH DATABASE src');
    }
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const [sourceDb, targetDb] = process.argv.slice(2);
  if (!sourceDb || !targetDb) {
    console.error('[ERROR] usage: migrate-from-bbs.ts <bbs-database.sqlite> <doors.db>');
    process.exit(1);
  }
  const counts = migrateFromBbs({ sourceDb, targetDb });
  console.log(`[OK] migrated ${counts.entries} catalog entries and ${counts.files} file rows`);
}
