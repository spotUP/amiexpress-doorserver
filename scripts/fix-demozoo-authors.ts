#!/usr/bin/env npx tsx

/**
 * Re-derive `author` from the JSON in `credits` for every demozoo
 * source row whose author is empty or NULL.
 *
 * The previous version of demozoo-import.ts was reading
 * `credits?.[0]?.person` which never matched the current demozoo.org
 * API shape (`{ nick: { name, ... } }` instead of `{ person }`).
 * As a result, every door enriched in the 35-min run was written with
 * an empty `author` column, even though the credits JSON next to it
 * has the correct name. This script reads the JSON back out and fills
 * the column in place. Re-runnable (no-op when author is already set).
 */

import Database from 'better-sqlite3';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';

async function main() {
  const cfg = loadConfig();
  const db = new Database(cfg.dbPath);
  applySchema(db);
  runMigrations(db);

  const rows = db.prepare(`
    SELECT id, archive_name, credits
      FROM door_catalog
     WHERE source = 'demozoo'
       AND credits IS NOT NULL AND credits != ''
       AND (author IS NULL OR author = '')
  `).all() as { id: string; archive_name: string; credits: string }[];

  console.error(`[fix-authors] ${rows.length} rows need their author filled in`);

  const updateStmt = db.prepare('UPDATE door_catalog SET author = ? WHERE id = ?');
  let updated = 0;
  let firstPerson = 0;
  let noNick = 0;

  for (const r of rows) {
    let nick: string | null = null;
    try {
      const parsed = JSON.parse(r.credits) as Array<{
        nick?: { name?: string; releaser?: { is_group?: boolean } };
        category?: string;
      }>;
      // The first credit with is_group=false is the individual coder.
      // Falls back to the first nick if no is_group flag is set (some
      // demozoo records don't have releaser info at all).
      const person = parsed.find((c) => c.nick?.releaser?.is_group === false)?.nick?.name
        ?? parsed.find((c) => c.nick?.name && c.nick?.releaser?.is_group !== true)?.nick?.name
        ?? parsed[0]?.nick?.name
        ?? null;
      nick = person;
    } catch (e: any) {
      console.error(`[fix-authors] ${r.archive_name}: bad credits JSON: ${e.message}`);
    }
    if (nick) {
      updateStmt.run(nick, r.id);
      updated++;
      firstPerson++;
    } else {
      noNick++;
    }
  }
  console.error(`[fix-authors] done. updated=${updated} (${firstPerson} from credits[0].nick.name) noNick=${noNick}`);
  db.close();
}

main().catch((e) => { console.error('[fix-authors] fatal:', e); process.exit(1); });
