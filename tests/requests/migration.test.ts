/**
 * The requests tables are migration step 1 of ACHIEVEMENTS_MIGRATIONS, and it
 * must be idempotent: achievements.db is deployed, so this step runs against a
 * database that may already have the tables. Every statement is CREATE ...
 * IF NOT EXISTS; a second run is a no-op.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/migrations';
import { ACHIEVEMENTS_MIGRATIONS } from '../../src/achievements/migrations';
import { applyAchievementsSchema } from '../../src/achievements/db';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'req-mig-'));
  dbPath = path.join(dir, 'achievements.db');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the requests migration', () => {
  it('is version 1 and unique-ascending', () => {
    const versions = ACHIEVEMENTS_MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    expect(ACHIEVEMENTS_MIGRATIONS[0].version).toBe(1);
  });

  it('creates the requests and request_votes tables and their indexes', () => {
    const db = new Database(dbPath);
    applyAchievementsSchema(db);
    const ran = runMigrations(db, ACHIEVEMENTS_MIGRATIONS);
    expect(ran).toContain('1:requests: the global-requests surface');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain('requests');
    expect(tables).toContain('request_votes');
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain('idx_requests_open');
    expect(indexes).toContain('idx_requests_author');
    db.close();
  });

  it('runs cleanly a second time on a database that already has the tables', () => {
    const first = new Database(dbPath);
    applyAchievementsSchema(first);
    expect(runMigrations(first, ACHIEVEMENTS_MIGRATIONS)).toHaveLength(ACHIEVEMENTS_MIGRATIONS.length);
    first.close();

    // A fresh open of the same file, as a redeploy does. The step is already
    // recorded, so nothing runs; and even forced, IF NOT EXISTS makes it safe.
    const second = new Database(dbPath);
    expect(runMigrations(second, ACHIEVEMENTS_MIGRATIONS)).toHaveLength(0);
    // Force the up() again against the live tables: still a no-op, no throw.
    expect(() => ACHIEVEMENTS_MIGRATIONS[0].up(second)).not.toThrow();
    second.close();
  });

  it('leaves the requests tables empty at birth', () => {
    const db = new Database(dbPath);
    applyAchievementsSchema(db);
    runMigrations(db, ACHIEVEMENTS_MIGRATIONS);
    expect(db.prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('chat migration (step 2)', () => {
  it('is idempotent and creates the chat tables', () => {
    const db = new Database(dbPath);
    applyAchievementsSchema(db);
    runMigrations(db, ACHIEVEMENTS_MIGRATIONS);
    expect(runMigrations(db, ACHIEVEMENTS_MIGRATIONS)).toHaveLength(0);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['chat_rooms', 'chat_sessions', 'chat_messages', 'chat_events', 'chat_roles']) expect(tables).toContain(t);
    db.close();
  });
});
