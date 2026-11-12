import { createApp } from './app';
import { loadConfig, ConfigError } from './config';
import type { ServerConfig } from './config';
import { getDoorCount, getCatalogRevision } from './catalog';
import { openDb } from './db';
import { prepareCatalogDb } from './migrations';
import { bootstrapAdmins } from './auth';
import { initAchievementsDb } from './achievements/db';
import { initReleasesDb } from './releases/db';
import { smtpMailer, startMailDrain, MAIL_DRAIN_INTERVAL_MS } from './achievements/mail';
import { ensureQuarantine } from './submissions';

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
      for (const step of prepareCatalogDb(db)) console.log(`[INFO] migration ${step}`);
      // DOORSERVER_ADMIN_KEYS becomes accounts: the label is the username,
      // the key is the password. An existing account is never touched.
      for (const username of bootstrapAdmins(db, cfg)) console.log(`[INFO] admin account created: ${username}`);
      if (!cfg.jwtSecret) {
        console.log('[INFO] admin API disabled: DOORSERVER_JWT_SECRET is not set');
      }
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(`[ERROR] migrating ${cfg.dbPath} failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // The achievements surface keeps its player data in a SECOND database
  // file. Its own try/catch, and its own block after the door-repo one,
  // because a failure here must name ACHIEVEMENTS_DB and not doors.db -
  // the whole point of the second file is that the two never share a fate.
  if (cfg.achievements) {
    try {
      for (const step of initAchievementsDb(cfg.achievements)) {
        console.log(`[INFO] achievements migration ${step}`);
      }
    } catch (err) {
      console.error(
        `[ERROR] initialising ${cfg.achievements.dbPath} failed: ${(err as Error).message}`
      );
      process.exit(1);
    }
  } else {
    console.log('[INFO] achievements surface disabled: ACHIEVEMENTS_DB is not set');
  }

  // Own file, own schema, own migrations — a failure here names RELEASES_DB.
  if (cfg.releases) {
    try {
      for (const step of initReleasesDb(cfg.releases)) {
        console.log(`[INFO] releases migration ${step}`);
      }
    } catch (err) {
      console.error(`[ERROR] initialising ${cfg.releases.dbPath} failed: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    console.log('[INFO] releases surface disabled: RELEASES_DB is not set');
  }

  let doors = 0;
  if (cfg.chatOnly) {
    console.log('[INFO] chat-only mode: catalog check skipped');
  } else {
    try {
      doors = assertCatalogUsable(cfg);
    } catch (err) {
      for (const line of (err as Error).message.split('\n')) {
        console.error(`[ERROR] ${line}`);
      }
      process.exit(1);
    }
  }

  // Uploads land on the data volume, which is empty on a fresh host.
  ensureQuarantine(cfg);

  const app = createApp(cfg);
  app.listen(cfg.port, () => {
    console.log(`[OK] door server listening on ${cfg.port}`);
    console.log(`[INFO] catalog ${doors} doors, revision ${getCatalogRevision(cfg)}`);
  });

  // The only timer this server starts, and only when the surface is on.
  // Mail is QUEUED on the request path and posted here, so a registration
  // never waits on an SMTP handshake and survives the mail server being
  // down. The timer is unref'd inside startMailDrain, so it can never be
  // the reason a process refuses to exit.
  if (cfg.achievements) {
    startMailDrain(cfg.achievements, smtpMailer(cfg.achievements));
    console.log(`[INFO] mail drain every ${MAIL_DRAIN_INTERVAL_MS / 1000}s`);
  }
}

// Guarded so importing this module (e.g. tests/startup.test.ts, to exercise
// assertCatalogUsable) never binds a port or touches process.exit as a side
// effect of the import itself.
if (require.main === module) {
  main();
}
