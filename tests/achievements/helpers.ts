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
 * AC-4 mints the board through `createBoard`, the same function the CLI and
 * the curation route call, so every suite's key is a REAL key: a random
 * secret, its scrypt hash in the row, and the plaintext returned once. A
 * hand-written constant would have been a shape, not a key, and the first
 * test to check `401` would have been testing the constant.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { openDb, applySchema } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import { bootstrapAdmins } from '../../src/auth';
import { createApp } from '../../src/app';
import { createBoard, _clearBoardKeyCacheForTests } from '../../src/achievements/boards';
import { initAchievementsDb, openAchievementsDb } from '../../src/achievements/db';
import type { ServerConfig } from '../../src/config';
import type { AchievementsConfig } from '../../src/achievements/config';

/** The board every suite reports as. The id is the ref prefix (D1). */
export const TEST_BOARD_ID = 'uprough';

/** The admin account the curation routes are driven as, when they are on. */
export const TEST_ADMIN = { username: 'spot', password: 'correct horse battery staple' };
const TEST_JWT_SECRET = 'a-test-secret-that-is-long-enough-to-pass';

export interface FixtureOptions {
  /**
   * Switch the admin API on: a signing secret and one bootstrapped account,
   * so the curation routes under /achievements/v1/admin can be driven. Off
   * by default - it costs two scrypt hashes, and most suites are board-facing.
   */
  admin?: boolean;
}

export interface AchievementsFixture {
  /** The temp directory both databases live in. */
  dir: string;
  /** The door catalog. Never touched by anything in this plan. */
  doorsDbPath: string;
  /** ACHIEVEMENTS_DB. */
  achievementsDbPath: string;
  cfg: ServerConfig;
  /** The same object as `cfg.achievements`, non-null, for convenience. */
  ach: AchievementsConfig;
  app: ReturnType<typeof createApp>;
  boardId: string;
  /** A real minted key: `<id>.<secret>`, shown once, hashed in the row. */
  boardKey: string;
  /** `Board <id>.<secret>`, ready for an Authorization header. */
  auth: string;
  /** A signed admin token. Only with `{ admin: true }`. */
  adminToken(): Promise<string>;
  /**
   * The achievements database, for assertions about STORAGE that no
   * endpoint exposes (the clamp flag, the player row count). Never used to
   * drive behaviour - the entry point is always the app.
   */
  openAchievements(): Database.Database;
  cleanup(): void;
}

export function makeAchievementsFixture(opts: FixtureOptions = {}): AchievementsFixture {
  // The verified-key cache is process state shared by every suite in this
  // worker; a fixture that did not clear it could inherit another test's
  // board and hide a missing verification.
  _clearBoardKeyCacheForTests();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-ach-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  fs.writeFileSync(path.join(dir, 'Archives', 'ACC-V103.LHA'), Buffer.from([0x4c, 0x5a, 0x00]));

  const doorsDbPath = path.join(dir, 'doors.db');
  const achievementsDbPath = path.join(dir, 'achievements.db');
  fs.writeFileSync(doorsDbPath, '');

  // A configured surface, with an SMTP URL that points at a closed port:
  // no suite may ever open a socket, and AC-6's tests drive the drain
  // directly with an injected clock instead.
  const ach: AchievementsConfig = {
    dbPath: achievementsDbPath,
    smtpUrl: 'smtp://127.0.0.1:1',
    mailFrom: 'achievements@example.invalid',
    publicBaseUrl: 'https://doors.example.invalid',
  };

  const cfg: ServerConfig = {
    dbPath: doorsDbPath,
    archivesRoot: path.join(dir, 'Archives'),
    port: 3010,
    adminKeys: opts.admin ? [{ label: TEST_ADMIN.username, key: TEST_ADMIN.password }] : [],
    jwtSecret: opts.admin ? TEST_JWT_SECRET : null,
    learnKey: null,
    achievements: ach,
  };

  // One door, so the catalog half of the server is usable and a test can
  // tell "the achievements surface is missing" apart from "the whole server
  // is broken".
  const db = openDb(cfg);
  applySchema(db);
  runMigrations(db);
  db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, name, door_type, archive_size, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'ACC-V103.LHA', 'Account Editor', 'XIM', 3, 1700000000)`
  ).run();
  if (opts.admin) bootstrapAdmins(db, cfg);
  db.close();

  // Exactly what startup does: schema, then migrations, against a file that
  // does not exist yet.
  initAchievementsDb(ach);

  const achDb = openAchievementsDb(ach);
  let boardKey: string;
  try {
    boardKey = createBoard(achDb, TEST_BOARD_ID, 'Up Rough', null).key;
  } finally {
    achDb.close();
  }

  const app = createApp(cfg);

  return {
    dir,
    doorsDbPath,
    achievementsDbPath,
    cfg,
    ach,
    app,
    boardId: TEST_BOARD_ID,
    boardKey,
    auth: `Board ${boardKey}`,
    adminToken: async () => {
      const res = await request(app)
        .post('/api/door-repo/admin/login')
        .send({ username: TEST_ADMIN.username, password: TEST_ADMIN.password });
      if (typeof res.body.token !== 'string') {
        throw new Error(`the fixture could not sign an admin token: ${JSON.stringify(res.body)}`);
      }
      return res.body.token as string;
    },
    openAchievements: () => new Database(achievementsDbPath),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
