/**
 * A fresh hub database holds no rooms, so /chat showed an empty room list.
 * initAchievementsDb seeds the shared lobby, and seeding twice keeps one row.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initAchievementsDb } from '../src/achievements/db';
import { ensureDefaultRoom } from '../src/chat/store';
import { CHAT_DEFAULT_ROOM_KEY } from '../contract/chat-types';
import type { AchievementsConfig } from '../src/achievements/config';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-room-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

it('seeds exactly one lobby room on a fresh database, however often init runs', () => {
  const ach = { dbPath: path.join(dir, 'achievements.db') } as unknown as AchievementsConfig;
  const seed = { achievements: [] } as never;
  initAchievementsDb(ach, { seed });
  initAchievementsDb(ach, { seed });
  const db = new Database(ach.dbPath);
  try {
    const rows = db.prepare('SELECT id, visibility FROM chat_rooms WHERE name_key = ?').all(CHAT_DEFAULT_ROOM_KEY) as { id: string; visibility: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].visibility).toBe('public');
    expect(ensureDefaultRoom(db)).toBe(rows[0].id);
  } finally { db.close(); }
});
