#!/usr/bin/env npx tsx

/**
 * Backfill parsed ad fields (contract/bbsad.ts) into an existing bbs_ads.db.
 * New imports get them inline; this covers databases built before the
 * columns existed. Idempotent: recomputes every row from stored text.
 *
 * Usage:
 *   npx tsx scripts/backfill-bbsad-parsed.ts [--db data/bbs_ads.db]
 */

import Database from 'better-sqlite3';
import { parseAd, maskPhone } from '../contract/bbsad';

const dbPath = (() => {
  const i = process.argv.indexOf('--db');
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : 'data/bbs_ads.db';
})();

const db = new Database(dbPath);
const cols = new Set(
  (db.prepare(`PRAGMA table_info(text_ad)`).all() as { name: string }[]).map((c) => c.name)
);
for (const col of ['phones_json TEXT NOT NULL DEFAULT \'[]\'', 'nodes INTEGER', 'handles_json TEXT NOT NULL DEFAULT \'[]\'', 'groups_json TEXT NOT NULL DEFAULT \'[]\'']) {
  const name = col.split(' ')[0];
  if (!cols.has(name)) db.exec(`ALTER TABLE text_ad ADD COLUMN ${col}`);
}

const rows = db.prepare(`SELECT ad_id, text FROM text_ad`).all() as { ad_id: number; text: string }[];
const upd = db.prepare(
  `UPDATE text_ad SET phones_json = ?, nodes = ?, handles_json = ?, groups_json = ? WHERE ad_id = ?`
);
const txn = db.transaction(() => {
  for (const r of rows) {
    const p = parseAd(r.text);
    upd.run(JSON.stringify(p.phones.map(maskPhone)), p.nodes, JSON.stringify(p.handles), JSON.stringify(p.groups), r.ad_id);
  }
});
txn();

const stats = db.prepare(`SELECT
  COUNT(*) AS ads,
  COUNT(NULLIF(phones_json, '[]')) AS with_phones,
  COUNT(nodes) AS with_nodes,
  COUNT(NULLIF(handles_json, '[]')) AS with_handles,
  COUNT(NULLIF(groups_json, '[]')) AS with_groups FROM text_ad`).get();
console.log(JSON.stringify(stats));
db.close();
