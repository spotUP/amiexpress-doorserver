#!/usr/bin/env npx tsx

/**
 * Demozoo BBS text-ads enumerator.
 *
 * Walks every BBS in the public Demozoo API, fetches each BBS's PUBLIC page
 * (no login needed for the listing - only the ad CONTENT is login-walled)
 * and records every linked text ad into a JSONL index.
 *
 * Output line: {bbs_id, bbs_name, ad_id, filename, filesize, page_url}
 *
 * Re-runnable: with --resume, BBS ids already present in the output are
 * skipped. Polite by default: ~1 request/second (Demozoo's documented
 * rate limit), with a longer breather every 200 requests.
 *
 * Usage:
 *   npx tsx scripts/demozoo-textads-enumerate.ts --out data/demozoo-textads-index.jsonl
 *   npx tsx scripts/demozoo-textads-enumerate.ts --out <path> --limit 50
 *   npx tsx scripts/demozoo-textads-enumerate.ts --out <path> --resume
 */

import * as fs from 'fs';

const API = 'https://demozoo.org/api/v1';
const SITE = 'https://demozoo.org';
const UA = 'amiexpress-doorserver text-ad census (+https://doors.uprough.net)';

const AD_LINK_RE = /<a href="\/bbs\/(\d+)\/text_ad\/(\d+)\/" title="([^"]*)">/g;
// title shape: "<filename> - (<N> bytes)"
const TITLE_RE = /^(.*) - \((\d+) bytes\)$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

function parseArgs(): { out: string; limit: number; resume: boolean; delayMs: number } {
  const args = process.argv.slice(2);
  const get = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  return {
    out: get('--out') ?? 'data/demozoo-textads-index.jsonl',
    limit: get('--limit') ? Number(get('--limit')) : Infinity,
    resume: args.includes('--resume'),
    delayMs: get('--delay-ms') ? Number(get('--delay-ms')) : 1100,
  };
}

async function main(): Promise<void> {
  const { out, limit, resume, delayMs } = parseArgs();

  const done = new Set<number>();
  if (resume && fs.existsSync(out)) {
    for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        done.add((JSON.parse(line) as { bbs_id: number }).bbs_id);
      } catch { /* skip bad line */ }
    }
    console.log(`resume: ${done.size} BBSes already indexed`);
  }

  // 1. Every BBS id + name via the public API (fast: 100/page).
  const bbses: { id: number; name: string }[] = [];
  let url: string | null = `${API}/bbses/?format=json`;
  while (url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    const page = (await res.json()) as {
      count: number;
      next: string | null;
      results: { id: number; name: string }[];
    };
    for (const r of page.results) bbses.push({ id: r.id, name: r.name });
    process.stdout.write(`\rAPI: ${bbses.length}/${page.count} BBSes`);
    url = page.next;
    if (url && bbses.length < limit) await sleep(400);
    if (bbses.length >= limit) break;
  }
  console.log(`\nAPI done: ${bbses.length} BBSes (capped at limit=${limit})`);
  const targets = bbses.slice(0, limit);

  // 2. Each BBS page -> text-ad links. Append-only JSONL.
  const stream = fs.createWriteStream(out, { flags: resume ? 'a' : 'w' });
  let checked = 0;
  let withAds = 0;
  let totalAds = 0;
  let totalBytes = 0;
  for (const bbs of targets) {
    if (done.has(bbs.id)) continue;
    checked++;
    try {
      const html = await getText(`${SITE}/bbs/${bbs.id}/`);
      AD_LINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      let n = 0;
      while ((m = AD_LINK_RE.exec(html)) !== null) {
        const title = m[3].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
        const tm = TITLE_RE.exec(title);
        const filename = tm ? tm[1] : title;
        const filesize = tm ? Number(tm[2]) : 0;
        stream.write(
          JSON.stringify({
            bbs_id: bbs.id,
            bbs_name: bbs.name,
            ad_id: Number(m[2]),
            filename,
            filesize,
            page_url: `${SITE}/bbs/${bbs.id}/text_ad/${m[2]}/`,
          }) + '\n'
        );
        n++;
        totalBytes += filesize;
      }
      if (n > 0) {
        withAds++;
        totalAds += n;
      }
    } catch (e) {
      console.error(`\nBBS ${bbs.id}: ${(e as Error).message}`);
    }
    if (checked % 20 === 0) {
      process.stdout.write(
        `\rpages: ${checked} checked, ${withAds} with ads, ${totalAds} ads`
      );
    }
    await sleep(delayMs);
    if (checked % 200 === 0) await sleep(15000);
  }
  stream.end();
  await new Promise<void>((resolve) => stream.on('finish', () => resolve()));
  console.log(
    `\ndone: ${checked} pages checked, ${withAds} BBSes with ads, ${totalAds} ads, ~${totalBytes} bytes`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
