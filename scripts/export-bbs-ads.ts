#!/usr/bin/env npx tsx

/**
 * Export the BBS text-ad corpus for asciiarena's display database.
 *
 * One JSON object per line: ad + BBS identity + parsed fields. Text is
 * DISPLAY-masked (maskPhonesInText): the doorserver DB keeps raw bytes for
 * research, but anything leaving this repo for a website must not carry
 * dialable numbers. phones_json is already stored masked.
 *
 * Usage:
 *   npx tsx scripts/export-bbs-ads.ts [--db data/bbs_ads.db] [--out /tmp/bbs_ads.jsonl]
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import { maskPhonesInText } from '../contract/bbsad';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (n: string, d: string): string => {
    const i = args.indexOf(n);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
  };
  return { db: get('--db', 'data/bbs_ads.db'), out: get('--out', '/tmp/bbs_ads.jsonl') };
}

const { db, out } = parseArgs();
const d = new Database(db, { readonly: true });
const rows = d.prepare(
  `SELECT a.ad_id, a.filename, a.filesize, a.text, a.encoding_used, a.is_ansi,
          a.phones_json, a.nodes, a.handles_json, a.groups_json, a.page_url,
          a.bbs_id, b.name AS bbs_name
   FROM text_ad a JOIN bbs b ON b.bbs_id = a.bbs_id ORDER BY a.ad_id`
).all() as Record<string, unknown>[];

const stream = fs.createWriteStream(out);
for (const r of rows) {
  stream.write(JSON.stringify({
    ad_id: r.ad_id,
    filename: r.filename,
    filesize: r.filesize,
    text: maskPhonesInText(r.text as string),
    encoding: r.encoding_used,
    is_ansi: r.is_ansi,
    phones: JSON.parse(r.phones_json as string),
    nodes: r.nodes,
    handles: JSON.parse(r.handles_json as string),
    groups: JSON.parse(r.groups_json as string),
    page_url: r.page_url,
    bbs_id: r.bbs_id,
    bbs_name: r.bbs_name,
  }) + '\n');
}
stream.end();
stream.on('finish', () => console.log(`exported ${rows.length} ads to ${out}`));
