#!/usr/bin/env npx tsx

/**
 * Board keys, from the host.
 *
 * This is how the FIRST key is minted: the HTTP curation routes need an
 * admin token, and on a fresh install there is neither a token nor a board.
 * The same five operations exist at
 * POST /achievements/v1/admin/boards (docs/ACHIEVEMENTS-API.md, section 9)
 * and both call the same functions in src/achievements/boards.ts - there is
 * no second implementation of minting, hashing or suspending.
 *
 * Usage:
 *   ACHIEVEMENTS_DB=/data/achievements.db npx tsx scripts/achievements-board.ts list
 *   npx tsx scripts/achievements-board.ts --db /data/achievements.db create <id> "<name>" [contact]
 *   npx tsx scripts/achievements-board.ts rotate <id>
 *   npx tsx scripts/achievements-board.ts suspend <id>
 *   npx tsx scripts/achievements-board.ts resume <id>
 *
 * ACHIEVEMENTS_SMTP_URL and ACHIEVEMENTS_MAIL_FROM are NOT read here: this
 * script never sends mail, and demanding a mail server before a sysop can
 * mint a key would be a startup rule leaking into an operator tool.
 */
import { createBoard, listBoards, rotateBoardKey, setBoardSuspended } from '../src/achievements/boards';
import { SurfaceError } from '../src/achievements/errors';
import { initAchievementsDb, openAchievementsDb } from '../src/achievements/db';
import type { AchievementsConfig } from '../src/achievements/config';

const argv = process.argv.slice(2);
let dbPath = process.env.ACHIEVEMENTS_DB ?? '';
const dbFlag = argv.indexOf('--db');
if (dbFlag !== -1) {
  dbPath = argv[dbFlag + 1] ?? '';
  argv.splice(dbFlag, 2);
}

const [command, ...args] = argv;

function usage(): never {
  console.error('[ERROR] usage: achievements-board.ts [--db <path>] list|create|rotate|suspend|resume [args]');
  process.exit(2);
}

if (!dbPath) {
  console.error('[ERROR] ACHIEVEMENTS_DB is not set and --db was not given');
  process.exit(2);
}
if (!command) usage();

/** Only dbPath is used below; the mail fields exist to satisfy the type. */
const ach: AchievementsConfig = {
  dbPath,
  smtpUrl: '',
  mailFrom: '',
  publicBaseUrl: '',
};

// The schema, so the first key can be minted before the server has ever run
// against this file. Idempotent: an existing database is left as it is.
initAchievementsDb(ach);

const db = openAchievementsDb(ach);

function printKey(id: string, key: string): void {
  console.log(`[OK] board ${id}`);
  console.log(`     key: ${key}`);
  console.log('[WARN] this is the only time this key is shown; only its hash is stored');
}

try {
  switch (command) {
    case 'list': {
      const rows = listBoards(db);
      if (rows.length === 0) {
        console.log('[INFO] no boards');
        break;
      }
      for (const row of rows) {
        const state = row.suspended_at === null ? 'active' : 'SUSPENDED';
        console.log(`${row.id}\t${state}\t${row.name}\t${row.contact ?? '-'}`);
      }
      console.log(`[INFO] ${rows.length} board(s)`);
      break;
    }
    case 'create': {
      const [id, name, contact] = args;
      if (!id || !name) usage();
      const minted = createBoard(db, id, name, contact ?? null);
      printKey(minted.id, minted.key);
      break;
    }
    case 'rotate': {
      const [id] = args;
      if (!id) usage();
      const minted = rotateBoardKey(db, id);
      printKey(minted.id, minted.key);
      console.log('[INFO] the previous key stops working on the very next request');
      break;
    }
    case 'suspend':
    case 'resume': {
      const [id] = args;
      if (!id) usage();
      setBoardSuspended(db, id, command === 'suspend');
      console.log(`[OK] board ${id} ${command === 'suspend' ? 'suspended' : 'resumed'}`);
      break;
    }
    default:
      usage();
  }
} catch (err) {
  if (err instanceof SurfaceError) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }
  throw err;
} finally {
  db.close();
}
