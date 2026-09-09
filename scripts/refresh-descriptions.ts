#!/usr/bin/env npx tsx
/**
 * Refresh derived fields (description, version, author, requires_bbs, name)
 * for doors that have NOT been hand-edited (no override for that field).
 * Hand-edited doors (with a row in door_catalog_overrides) are left untouched
 * – they carry the "edited" badge in the admin UI.
 *
 * Usage on the live host:
 *   npx tsx scripts/refresh-descriptions.ts [--dry-run] [--db /data/doors.db]
 *   npx tsx scripts/refresh-descriptions.ts --apply
 *
 * Dry-run by default; pass --apply to actually write.
 * Run inside the doorserver container or on the host with DOORSERVER_DB set.
 */
import Database from 'better-sqlite3';
import { analyseDoor } from '../contract/describe';
import { corpusGroupTags } from '../src/catalog';
import { loadConfig } from '../src/config';

const DRY_RUN = !process.argv.includes('--apply');
const dbPathArg = process.argv.find(a => a.startsWith('--db='));
const explicitDb = dbPathArg ? dbPathArg.slice(5) : null;

function getDbPath(): string {
  if (explicitDb) return explicitDb;
  try {
    const cfg = loadConfig();
    return cfg.dbPath;
  } catch {
    return process.env.DOORSERVER_DB || '/data/doors.db';
  }
}

const dbPath = getDbPath();
console.error(`[refresh] db: ${dbPath} ${DRY_RUN ? '(dry-run)' : '(apply)'}`);

const db = new Database(dbPath);
const groupTags = corpusGroupTags(db);

// Load existing overrides per field
const overrides = new Map<string, Set<string>>();
for (const row of db.prepare('SELECT catalog_id, field FROM door_catalog_overrides').all() as {catalog_id:string, field:string}[]) {
  if (!overrides.has(row.catalog_id)) overrides.set(row.catalog_id, new Set());
  overrides.get(row.catalog_id)!.add(row.field);
}

const rows = db.prepare('SELECT id, archive_name, archive_path, binary_name, name, version, author, release_group, description, file_id_diz, requires_bbs FROM door_catalog').all() as any[];

let touched = 0, skippedEdited = 0, unchanged = 0;
let wouldChange = 0;

const updateStmt = db.prepare(`
  UPDATE door_catalog SET
    name = COALESCE(?, name),
    description = COALESCE(?, description),
    version = COALESCE(?, version),
    author = COALESCE(?, author),
    requires_bbs = COALESCE(?, requires_bbs)
  WHERE id = ?
`);

const tx = db.transaction(() => {
  for (const row of rows) {
    const hasAnyOverride = overrides.has(row.id);
    // The "edited" badge means the door has been hand-edited for any field;
    // per the user's request, those doors remain untouched entirely.
    if (hasAnyOverride) {
      skippedEdited++;
      continue;
    }
    const hasDescOverride = false;
    const hasNameOverride = false;
    const hasVersionOverride = false;
    const hasAuthorOverride = false;
    const hasRequiresOverride = false;

    const derived = analyseDoor({
      dizText: row.file_id_diz,
      name: row.name,
      archiveName: row.archive_name,
      binaryName: row.binary_name,
    }, groupTags);

    // Only update fields that are NOT hand-edited and where derived is non-empty and different
    const newName = !hasNameOverride && derived ? null : null; // name is derived via displayName, not analyseDoor – handle separately
    // For name, use displayName logic? For now, keep existing name unless you want to refresh it too.
    // We'll refresh name via displayName if not overridden and if derived name differs.
    // To avoid complexity, we only refresh description/version/author/requires_bbs which are the DIZ-extracted fields.

    const newDesc = !hasDescOverride ? derived.description : null;
    const newVer = !hasVersionOverride ? (derived.version || null) : null;
    const newAuthor = !hasAuthorOverride ? (derived.author || null) : null;
    const newReq = !hasRequiresOverride ? (derived.requiresBbs || null) : null;

    // Check if any would change
    const wouldDescChange = newDesc !== null && newDesc !== row.description;
    const wouldVerChange = newVer !== null && newVer !== row.version;
    const wouldAuthorChange = newAuthor !== null && newAuthor !== row.author;
    const wouldReqChange = newReq !== null && newReq !== row.requires_bbs;

    if (!wouldDescChange && !wouldVerChange && !wouldAuthorChange && !wouldReqChange) {
      unchanged++;
      continue;
    }

    wouldChange++;

    if (!DRY_RUN) {
      // Only set fields that would change; keep others as null to not touch
      const descToSet = wouldDescChange ? newDesc : null;
      const verToSet = wouldVerChange ? newVer : null;
      const authorToSet = wouldAuthorChange ? newAuthor : null;
      const reqToSet = wouldReqChange ? newReq : null;
      // For name, we could also refresh via displayName, but skip for now as it's more sensitive
      updateStmt.run(null, descToSet, verToSet, authorToSet, reqToSet, row.id);
      touched++;
    } else {
      // Dry-run logging for first few
      if (wouldChange <= 5) {
        console.log(`[dry-run] ${row.archive_name}:`);
        if (wouldDescChange) console.log(`  description: ${JSON.stringify(row.description?.slice(0,60))} -> ${JSON.stringify(newDesc?.slice(0,80))}`);
        if (wouldVerChange) console.log(`  version: ${row.version} -> ${newVer}`);
        if (wouldAuthorChange) console.log(`  author: ${row.author} -> ${newAuthor}`);
        if (wouldReqChange) console.log(`  requires_bbs: ${row.requires_bbs} -> ${newReq}`);
      }
    }
  }
});

tx();
db.close();

console.error(`[refresh] scanned ${rows.length} doors`);
console.error(`[refresh] would change: ${wouldChange}, unchanged: ${unchanged}, skipped (all hand-edited): ${skippedEdited}`);
if (DRY_RUN) {
  console.error(`[refresh] dry-run, no writes. Pass --apply to write.`);
} else {
  console.error(`[refresh] applied ${touched} rows`);
}
