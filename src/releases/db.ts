/**
 * The only place that opens releases.db.
 *
 * Mirrors src/achievements/db.ts: same open/apply/init shape, own schema.sql
 * beside this module (copied by package.json's build script), own migration
 * array. See that file for why each of those is the way it is.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { runMigrations } from '../migrations';
import { RELEASES_MIGRATIONS } from './migrations';
import type { ReleasesConfig } from './config';

export function openReleasesDb(rel: ReleasesConfig, opts?: { readonly?: boolean }): Database.Database {
  return new Database(rel.dbPath, { readonly: opts?.readonly ?? false });
}

export function withReleasesDb<T>(
  rel: ReleasesConfig,
  fn: (db: Database.Database) => T,
  opts?: { readonly?: boolean }
): T {
  const db = openReleasesDb(rel, opts);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function applyReleasesSchema(db: Database.Database): void {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8'));
}

/** Create the file if missing, apply schema + migrations. Returns what ran. */
export function initReleasesDb(rel: ReleasesConfig): string[] {
  const db = openReleasesDb(rel);
  try {
    applyReleasesSchema(db);
    return runMigrations(db, RELEASES_MIGRATIONS);
  } finally {
    db.close();
  }
}
