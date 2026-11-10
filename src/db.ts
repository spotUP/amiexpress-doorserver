/**
 * The single place that opens the catalog database.
 *
 * The BBS computed its DB path in two modules (door-catalog.service.ts and
 * door-repo-manifest.ts) from the same env vars, which meant two chances to
 * disagree. Here, a caller passes the ServerConfig it was given.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { ServerConfig } from './config';

export function openDb(cfg: ServerConfig, opts?: { readonly?: boolean }): Database.Database {
  return new Database(cfg.dbPath, { readonly: opts?.readonly ?? false });
}

export function applySchema(db: Database.Database): void {
  const schemaPath = path.join(__dirname, 'schema.sql');
  db.exec(fs.readFileSync(schemaPath, 'utf-8'));
}
