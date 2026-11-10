/**
 * Copies ONE scanned corpus directory out of a BBS database into the door
 * server's, leaving every other row in both alone.
 *
 *   node dist/scripts/import-scanned-batch.js <bbs-database.sqlite> <doors.db> <Prefix/>
 *
 * migrate-from-bbs.ts is the whole-table move, for standing this server up
 * from the BBS's catalog. This is the incremental one: a batch of archives
 * lands in a new directory under the archive root, the BBS's
 * build-door-catalog.ts indexes it (which is where door_type detection and
 * junk-file flagging live), and only that directory's rows come across.
 * Copying the whole table instead would drag every other row back to
 * whatever the BBS snapshot happens to hold - a live catalog that has moved
 * on since would silently regress.
 *
 * Refuses rather than clobbers. A batch whose archive_name or id already
 * belongs to a different row in the target is a mistake upstream - two
 * different files claiming one name - and the fix is to rename the incoming
 * archive and re-index it, not to overwrite a door that is already
 * published. Re-importing the SAME batch is fine and does nothing new: a row
 * matching on both id and archive_name is refreshed in place.
 *
 * The source is never attached directly - see migrate-from-bbs.ts for why:
 * ATTACH opens read-write, and the BBS may be writing to the live database.
 * A throwaway copy is what gets attached.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';

/**
 * The per-node columns (installed, installed_as, install_dir) are absent
 * here for the same reason migrate-from-bbs.ts leaves them: they describe
 * one BBS's own installation, not the door.
 */
const COLUMNS = [
  'id', 'archive_name', 'archive_path', 'binary_name', 'door_type', 'name', 'version',
  'author', 'release_group', 'description', 'file_id_diz', 'doc_filename', 'doc_raw',
  'suggested_tooltypes', 'category', 'archive_size', 'junk_count', 'corpus_id', 'source',
  'indexed_at', 'md5', 'sha256',
];

export interface ImportCounts {
  entries: number;
  files: number;
  refreshed: number;
}

export interface Clash {
  kind: 'archive_name' | 'id';
  incoming: string;
  held: string;
}

export class ImportClashError extends Error {
  constructor(readonly clashes: Clash[]) {
    super(
      `${clashes.length} incoming row(s) collide with rows already in the target:\n` +
        clashes
          .map((c) => `  ${c.incoming} - that ${c.kind} already belongs to ${c.held}`)
          .join('\n')
    );
    this.name = 'ImportClashError';
  }
}

/**
 * Every incoming row that would take a name or an id off an existing,
 * different row. A row that matches on BOTH is the same door being
 * re-imported and is not a clash.
 */
export function findClashes(db: Database.Database, prefix: string): Clash[] {
  const clashes: Clash[] = [];
  const byName = db.prepare(
    `SELECT s.archive_name AS incoming, t.archive_name AS held, t.id AS heldId
       FROM src.door_catalog s
       JOIN main.door_catalog t ON t.archive_name = s.archive_name COLLATE NOCASE
      WHERE s.archive_path LIKE ? AND t.id <> s.id`
  ).all(`${prefix}%`) as { incoming: string; held: string; heldId: string }[];
  for (const row of byName) {
    clashes.push({ kind: 'archive_name', incoming: row.incoming, held: `${row.held} (id ${row.heldId})` });
  }

  const byId = db.prepare(
    `SELECT s.archive_name AS incoming, s.id AS id, t.archive_name AS held
       FROM src.door_catalog s
       JOIN main.door_catalog t ON t.id = s.id
      WHERE s.archive_path LIKE ? AND t.archive_name <> s.archive_name COLLATE NOCASE`
  ).all(`${prefix}%`) as { incoming: string; id: string; held: string }[];
  for (const row of byId) {
    clashes.push({ kind: 'id', incoming: `${row.incoming} (id ${row.id})`, held: row.held });
  }
  return clashes;
}

export function importScannedBatch(opts: {
  sourceDb: string;
  targetDb: string;
  prefix: string;
  dryRun?: boolean;
}): ImportCounts {
  if (!fs.existsSync(opts.sourceDb)) {
    throw new Error(`source database ${opts.sourceDb} does not exist`);
  }
  if (path.resolve(opts.sourceDb) === path.resolve(opts.targetDb)) {
    throw new Error('sourceDb and targetDb resolve to the same file - refusing to import a database into itself');
  }
  if (!opts.prefix) {
    throw new Error('a path prefix is required - importing every row is what migrate-from-bbs.ts is for');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-import-src-'));
  const snapshot = path.join(tmpDir, 'source-snapshot.db');
  try {
    fs.copyFileSync(opts.sourceDb, snapshot);

    const db = new Database(opts.targetDb);
    try {
      applySchema(db);
      runMigrations(db);
      db.prepare('ATTACH DATABASE ? AS src').run(snapshot);
      try {
        const clashes = findClashes(db, opts.prefix);
        if (clashes.length) throw new ImportClashError(clashes);

        const like = `${opts.prefix}%`;
        const entries = (
          db.prepare('SELECT COUNT(*) AS n FROM src.door_catalog WHERE archive_path LIKE ?').get(like) as { n: number }
        ).n;
        const refreshed = (
          db.prepare(
            `SELECT COUNT(*) AS n FROM src.door_catalog s
               JOIN main.door_catalog t ON t.id = s.id
              WHERE s.archive_path LIKE ?`
          ).get(like) as { n: number }
        ).n;
        const files = (
          db.prepare(
            `SELECT COUNT(*) AS n FROM src.door_catalog_files f
              WHERE f.catalog_id IN (SELECT id FROM src.door_catalog WHERE archive_path LIKE ?)`
          ).get(like) as { n: number }
        ).n;

        if (!opts.dryRun) {
          const cols = COLUMNS.join(', ');
          const copy = db.transaction(() => {
            db.prepare(
              `INSERT OR REPLACE INTO main.door_catalog (${cols})
               SELECT ${cols} FROM src.door_catalog WHERE archive_path LIKE ?`
            ).run(like);
            db.prepare(
              `INSERT OR REPLACE INTO main.door_catalog_files (catalog_id, path, size, is_junk, junk_reason)
               SELECT catalog_id, path, size, is_junk, junk_reason FROM src.door_catalog_files
                WHERE catalog_id IN (SELECT id FROM src.door_catalog WHERE archive_path LIKE ?)`
            ).run(like);
          });
          copy();
        }

        return { entries, files, refreshed };
      } finally {
        db.exec('DETACH DATABASE src');
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const [sourceDb, targetDb, prefix] = args.filter((a) => a !== '--dry-run');
  if (!sourceDb || !targetDb || !prefix) {
    console.error('[ERROR] usage: import-scanned-batch.ts <bbs-database.sqlite> <doors.db> <Prefix/> [--dry-run]');
    process.exit(1);
  }
  try {
    const counts = importScannedBatch({ sourceDb, targetDb, prefix, dryRun });
    const what = `${counts.entries} catalog entries (${counts.refreshed} already present, refreshed) and ${counts.files} file rows`;
    console.log(dryRun ? `[INFO] would import ${what}` : `[OK] imported ${what}`);
  } catch (error) {
    console.error(`[ERROR] ${(error as Error).message}`);
    process.exit(1);
  }
}
