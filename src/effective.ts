/**
 * Human corrections, layered over the scanned catalog.
 *
 * `door_catalog` is machine-written: a corpus re-scan rewrites it whole.
 * Anything a person fixes by hand therefore cannot live there, or the next
 * scan silently destroys it - so a correction is stored per FIELD in
 * `door_catalog_overrides`, and every read path layers those on top of the
 * scanned row.
 *
 * Two consequences worth keeping in mind:
 *   - reverting one field is a DELETE of one row, not a guess at what the
 *     scanner would have said;
 *   - a row exists only for a field a human touched, so a re-scan keeps
 *     delivering fresh checksums, sizes and file lists for exactly the doors
 *     someone cared enough to correct.
 *
 * NOTHING may read door_catalog for display without passing through here.
 * The one legitimate exception is the admin UI's "scanned vs edited" diff,
 * which needs both values side by side.
 */
import type Database from 'better-sqlite3';

/**
 * The fields a human may correct. An allowlist, not a free-form column name:
 * the admin API writes `field` straight from a request body, and this is what
 * keeps that from reaching an arbitrary column.
 */
export const OVERRIDABLE_FIELDS = [
  'name',
  'description',
  'version',
  'author',
  'release_group',
  'category',
  'door_type',
  'requires_bbs',
  'binary_name',
  'suggested_tooltypes',
] as const;

export type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

export function isOverridableField(field: string): field is OverridableField {
  return (OVERRIDABLE_FIELDS as readonly string[]).includes(field);
}

/** catalog id -> the fields a human has corrected on that door. */
export type OverrideMap = Map<string, Partial<Record<OverridableField, string | null>>>;

export const NO_OVERRIDES: OverrideMap = new Map();

interface OverrideRow {
  catalog_id: string;
  field: string;
  value: string | null;
}

/** Every override in the catalog, keyed by door. One query, not one per row. */
export function loadOverrides(db: Database.Database): OverrideMap {
  const map: OverrideMap = new Map();
  if (!hasOverridesTable(db)) {
    return map;
  }
  const rows = db.prepare('SELECT catalog_id, field, value FROM door_catalog_overrides').all() as OverrideRow[];
  for (const row of rows) {
    if (!isOverridableField(row.field)) {
      // A field that is no longer overridable (renamed, dropped) is ignored
      // rather than applied blindly; the row stays for the audit trail.
      continue;
    }
    const existing = map.get(row.catalog_id) ?? {};
    existing[row.field] = row.value;
    map.set(row.catalog_id, existing);
  }
  return map;
}

export function hasOverridesTable(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'door_catalog_overrides'")
    .get();
  return row !== undefined;
}

/**
 * The most recent edit, as a unix timestamp, or 0 when nothing is overridden.
 * Part of the catalog revision: without it, an edit would leave every cached
 * list.txt, manifest and index.tsv serving pre-edit bytes under an unchanged
 * ETag.
 */
export function overridesStamp(db: Database.Database): number {
  if (!hasOverridesTable(db)) {
    return 0;
  }
  const row = db.prepare('SELECT COALESCE(MAX(edited_at), 0) AS t FROM door_catalog_overrides').get() as {
    t: number;
  };
  return row.t;
}

/**
 * Lay a door's corrections over its scanned row. `undefined` means "not
 * overridden, keep what the scan said"; a stored NULL means "a human blanked
 * this field", which is a decision and is honoured.
 */
export function applyOverrides<T extends object>(row: T, id: string, overrides: OverrideMap): T {
  const fields = overrides.get(id);
  if (!fields) {
    return row;
  }
  const out: Record<string, unknown> = { ...(row as object) } as Record<string, unknown>;
  for (const field of OVERRIDABLE_FIELDS) {
    if (field in fields) {
      out[field] = fields[field] ?? null;
    }
  }
  return out as T;
}

/** Was this door's `field` written by a human rather than the scanner? */
export function isOverridden(id: string, field: OverridableField, overrides: OverrideMap): boolean {
  const fields = overrides.get(id);
  return fields !== undefined && field in fields;
}
