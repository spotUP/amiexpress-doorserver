/**
 * The fixture every achievements suite drives.
 *
 * One temp directory holding BOTH databases side by side, the way the live
 * volume holds them: `doors.db` (the catalog, seeded with a single door so
 * `assertCatalogUsable` and the door-repo routes stay usable) and
 * `achievements.db` (the player data). Nothing here reaches into a router or
 * a handler: the app under test is always the real `createApp(cfg)`, so a
 * suite cannot accidentally prove something about a function that no request
 * ever reaches.
 *
 * AC-1 (RED) needs only the two paths, the config and the app. AC-2 extends
 * this file with the initialised achievements database and the recording
 * mailer; the shape of `makeAchievementsFixture()` does not change.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { openDb, applySchema } from '../../src/db';
import { createApp } from '../../src/app';
import type { ServerConfig } from '../../src/config';

/** The board every suite reports as. The id is the ref prefix (D1). */
export const TEST_BOARD_ID = 'uprough';

/**
 * `Board <id>.<secret>` (D1): the id rides in the key so exactly one scrypt
 * runs per request. AC-4 mints real keys; until then this is the shape a
 * board author would present.
 */
export const TEST_BOARD_KEY = `${TEST_BOARD_ID}.qeAtPnDs4Wv2Lm7xKcRb9TfHgJyZuNe3`;

export interface AchievementsFixture {
  /** The temp directory both databases live in. */
  dir: string;
  /** The door catalog. Never touched by anything in this plan. */
  doorsDbPath: string;
  /** ACHIEVEMENTS_DB. */
  achievementsDbPath: string;
  cfg: ServerConfig;
  app: ReturnType<typeof createApp>;
  /**
   * The achievements database, for assertions about STORAGE that no
   * endpoint exposes (the clamp flag, the player row count). Never used to
   * drive behaviour - the entry point is always the app.
   */
  openAchievements(): Database.Database;
  cleanup(): void;
}

export function makeAchievementsFixture(): AchievementsFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-ach-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  fs.writeFileSync(path.join(dir, 'Archives', 'ACC-V103.LHA'), Buffer.from([0x4c, 0x5a, 0x00]));

  const doorsDbPath = path.join(dir, 'doors.db');
  const achievementsDbPath = path.join(dir, 'achievements.db');
  fs.writeFileSync(doorsDbPath, '');

  const cfg: ServerConfig = {
    dbPath: doorsDbPath,
    archivesRoot: path.join(dir, 'Archives'),
    port: 3010,
    adminKeys: [],
    jwtSecret: null,
    learnKey: null,
  };

  // One door, so the catalog half of the server is usable and a test can
  // tell "the achievements surface is missing" apart from "the whole server
  // is broken".
  const db = openDb(cfg);
  applySchema(db);
  db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, name, door_type, archive_size, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'ACC-V103.LHA', 'Account Editor', 'XIM', 3, 1700000000)`
  ).run();
  db.close();

  return {
    dir,
    doorsDbPath,
    achievementsDbPath,
    cfg,
    app: createApp(cfg),
    openAchievements: () => new Database(achievementsDbPath),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
