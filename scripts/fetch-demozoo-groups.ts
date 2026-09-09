#!/usr/bin/env npx tsx
/**
 * Scrape every Amiga group name + acronym out of the Demozoo API.
 *
 * The API has no group search and list rows carry no abbreviations, so this
 * enumerates all Amiga productions (platforms OCS/ECS=5, AGA=6, PPC/RTG=26)
 * and harvests author_nicks flagged is_group with a non-empty abbreviation —
 * the same field fetch-api-groups.ts and demozoo-import.ts already trust.
 * ~79k productions, ~800 pages at 1 req/s: about 15 minutes, resumable via
 * the page cache, polite by construction (sequential, project rate limit).
 *
 * Matches the harvested index against release-group candidates mined from
 * releases.db filenames and reports; --apply inserts missing abbreviations
 * only (ON CONFLICT DO NOTHING — never rewrites a curated full name).
 *
 * Usage:
 *   npx tsx scripts/fetch-demozoo-groups.ts --dry-run
 *   npx tsx scripts/fetch-demozoo-groups.ts --apply [--min-count=N]
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import { loadConfig } from '../src/config';
import { applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';

const DEMOZOO_API = 'https://demozoo.org/api/v1';
const PLATFORMS = [5, 6, 26];
const PAGE_SIZE = 100;
const PAUSE_MS = 1100;
const MAX_RETRIES = 5;

const dryRun = process.argv.includes('--dry-run');
const apply = process.argv.includes('--apply');
const minCountArg = process.argv.find((a) => a.startsWith('--min-count='));
const minCount = minCountArg ? Number(minCountArg.slice('--min-count='.length)) || 10 : 10;
// A one-prod match is a typo-grade signal; only multi-prod resolutions insert.
const minProdsArg = process.argv.find((a) => a.startsWith('--min-prods='));
const minProds = minProdsArg ? Number(minProdsArg.slice('--min-prods='.length)) || 3 : 3;
const cacheDir = process.env.DEMOZOO_CACHE ?? path.join(os.tmpdir(), 'demozoo-groups');

interface Nick {
  name: string;
  abbreviation: string;
  releaser: { id: number; name: string; is_group: boolean };
}
interface Prod {
  id: number;
  author_nicks?: Nick[];
}
interface Page {
  count: number;
  next: string | null;
  results: Prod[];
}

function getJson(url: string): Promise<Page> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number): void => {
      https
        .get(url, { headers: { 'User-Agent': 'amiexpress-doorserver group-index' } }, (res) => {
          if (res.statusCode === 429 && n < MAX_RETRIES) {
            res.resume();
            setTimeout(() => attempt(n + 1), 10000 * n);
            return;
          }
          if ((res.statusCode ?? 0) >= 400) {
            res.resume();
            if (n < MAX_RETRIES) setTimeout(() => attempt(n + 1), 5000 * n);
            else reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => {
            try {
              resolve(JSON.parse(body) as Page);
            } catch (err) {
              if (n < MAX_RETRIES) setTimeout(() => attempt(n + 1), 5000 * n);
              else reject(err);
            }
          });
        })
        .on('error', (err) => {
          if (n < MAX_RETRIES) setTimeout(() => attempt(n + 1), 5000 * n);
          else reject(err);
        });
    };
    attempt(1);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!dryRun && !apply) {
    console.error('pass --dry-run or --apply');
    process.exit(1);
  }
  fs.mkdirSync(cacheDir, { recursive: true });

  // 1. Enumerate Amiga productions, cached per platform+page for resume.
  // One abbreviation can name several groups over the decades; every
  // claimant is kept so conflicts surface instead of silently winning.
  const seen = new Set<number>();
  const index = new Map<string, Map<string, number>>();
  for (const plat of PLATFORMS) {
    let page = 1;
    for (;;) {
      const cacheFile = path.join(cacheDir, `plat${plat}-p${page}.json`);
      let data: Page;
      if (fs.existsSync(cacheFile)) {
        data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as Page;
      } else {
        data = await getJson(`${DEMOZOO_API}/productions/?platform=${plat}&limit=${PAGE_SIZE}&page=${page}`);
        fs.writeFileSync(cacheFile, JSON.stringify(data));
        await sleep(PAUSE_MS);
      }
      for (const prod of data.results) {
        if (seen.has(prod.id)) continue;
        seen.add(prod.id);
        for (const nick of prod.author_nicks ?? []) {
          if (!nick.releaser?.is_group || !nick.abbreviation?.trim()) continue;
          const key = nick.abbreviation.trim().toUpperCase();
          let cur = index.get(key);
          if (!cur) {
            cur = new Map();
            index.set(key, cur);
          }
          cur.set(nick.releaser.name, (cur.get(nick.releaser.name) ?? 0) + 1);
        }
      }
      if (!data.next) break;
      page++;
      if (page % 100 === 0) console.error(`[groups] platform ${plat} page ${page}, ${seen.size} prods, ${index.size} groups`);
    }
    console.error(`[groups] platform ${plat}: ${seen.size} prods total so far, ${index.size} group abbreviations`);
  }

  // 2. Candidates from releases.db filenames.
  const dbFlag = process.argv.find((a) => a.startsWith('--db='));
  const dbPath = dbFlag ? dbFlag.slice('--db='.length) : loadConfig().dbPath;
  const db = new Database(dbPath);
  applySchema(db);
  runMigrations(db);
  const known = new Set(
    (db.prepare('SELECT abbreviation FROM release_groups').all() as { abbreviation: string }[]).map((r) =>
      r.abbreviation.toUpperCase()
    )
  );
  const pat = /^([A-Za-z0-9!$^&]{1,5})[-_^!]/;
  const counts = new Map<string, number>();
  for (const r of db.prepare('SELECT archive_name FROM door_catalog').all() as { archive_name: string }[]) {
    const m = pat.exec(r.archive_name);
    if (!m) continue;
    const tag = m[1].toUpperCase();
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  // releases.db filenames too (same prefix rule, own corpus).
  let relDb: Database.Database | null = null;
  try {
    const releasesDb = process.env.RELEASES_DB;
    if (releasesDb && fs.existsSync(releasesDb)) {
      relDb = new Database(releasesDb, { readonly: true });
      for (const r of relDb.prepare('SELECT filename FROM release_files').all() as { filename: string }[]) {
        const m = pat.exec(r.filename);
        if (!m) continue;
        const tag = m[1].toUpperCase();
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
  } finally {
    relDb?.close();
  }

  // 3. Match + report; --apply inserts missing only.
  const insert = db.prepare(
    'INSERT INTO release_groups (abbreviation, full_name) VALUES (?, ?) ON CONFLICT(abbreviation) DO NOTHING'
  );
  let matched = 0;
  let inserted = 0;
  const candidates = [...counts.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1]);
  for (const [tag, n] of candidates) {
    if (known.has(tag)) continue;
    const hit = index.get(tag);
    if (!hit) continue;
    const claimants = [...hit.entries()].sort((a, b) => b[1] - a[1]);
    const prods = claimants.reduce((a, [, k]) => a + k, 0);
    matched++;
    if (claimants.length > 1) {
      console.log(
        `[groups] ${tag} x${n} CONFLICT: ${claimants.map(([f, k]) => `${f}(${k})`).join(', ')} — left for curation`
      );
      continue;
    }
    if (prods < minProds) {
      console.log(`[groups] ${tag} x${n} -> ${claimants[0][0]} (${prods} prods) — too thin, left for curation`);
      continue;
    }
    console.log(`[groups] ${tag} x${n} -> ${claimants[0][0]} (${prods} prods)`);
    if (apply) {
      const r = insert.run(tag, claimants[0][0]);
      if (r.changes > 0) inserted++;
    }
  }
  console.error(
    `[groups] ${dryRun ? 'dry-run, ' : ''}${candidates.length} candidates, ${matched} Demozoo-matched, ${inserted} inserted`
  );
  db.close();
}

main().catch((err) => {
  console.error(`[ERROR] ${(err as Error).message}`);
  process.exit(1);
});
