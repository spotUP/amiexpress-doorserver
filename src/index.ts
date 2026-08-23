import { createApp } from './app';
import { loadConfig, ConfigError } from './config';
import type { ServerConfig } from './config';
import { getDoorCount, getCatalogRevision } from './catalog';
import { openDb } from './db';
import { runMigrations } from './migrations';

/**
 * Refuse to serve a catalog that cannot be read, or that reads clean but
 * holds zero doors. A present-but-unmigrated doors.db (the volume is seeded
 * by hand) starts happily otherwise and serves `revision c0-t0` with a
 * valid ETag and no doors - a valid revision that poisons every client's
 * cache. Throws (rather than exiting) so it stays testable without binding
 * a port; callers translate the failure into the operator-facing message
 * and exit code.
 */
export function assertCatalogUsable(cfg: ServerConfig): number {
  let doors: number;
  try {
    doors = getDoorCount(cfg);
  } catch (err) {
    throw new Error(`cannot read the catalog at ${cfg.dbPath}: ${(err as Error).message}`);
  }
  if (doors === 0) {
    throw new Error(
      `the catalog at ${cfg.dbPath} holds no doors; refusing to serve an empty catalog\n` +
        'an empty catalog publishes a valid revision and poisons every client cache'
    );
  }
  return doors;
}

function main(): void {
  let cfg: ServerConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[ERROR] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Before anything reads the catalog: the volume is seeded by hand and a
  // column added after the first deploy exists only if a migration adds it.
  try {
    const db = openDb(cfg);
    try {
      for (const step of runMigrations(db)) console.log(`[INFO] migration ${step}`);
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`[ERROR] migrating ${cfg.dbPath} failed: ${(err as Error).message}`);
    process.exit(1);
  }

  let doors: number;
  try {
    doors = assertCatalogUsable(cfg);
  } catch (err) {
    for (const line of (err as Error).message.split('\n')) {
      console.error(`[ERROR] ${line}`);
    }
    process.exit(1);
  }

  const app = createApp(cfg);
  app.listen(cfg.port, () => {
    console.log(`[OK] door server listening on ${cfg.port}`);
    console.log(`[INFO] catalog ${doors} doors, revision ${getCatalogRevision(cfg)}`);
  });
}

// Guarded so importing this module (e.g. tests/startup.test.ts, to exercise
// assertCatalogUsable) never binds a port or touches process.exit as a side
// effect of the import itself.
if (require.main === module) {
  main();
}
