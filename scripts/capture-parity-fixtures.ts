// scripts/capture-parity-fixtures.ts
/**
 * Captures responses from a RUNNING door-repo API (the BBS-hosted one) as
 * committed fixtures, so the standalone server can be asserted byte-equal
 * without a live server in CI.
 *
 * Bodies are stored as base64: several are Latin-1 with control bytes, and
 * a UTF-8 round-trip through a text file would corrupt exactly the bytes
 * this harness exists to protect.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const BASE = process.argv[2];
const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'parity');

const HEADERS_OF_INTEREST = [
  'content-type', 'content-length', 'etag', 'x-door-repo-revision',
  'x-archive-md5', 'x-archive-sha256', 'x-doc-filename',
];

// Bodies are stored whole only while they are small. Measured against the
// live API: /manifest is 2.75 MB, /manifest?type=XIM 2.66 MB, /list.txt
// 620 KB - storing those as base64 would commit ~9 MB of fixtures. So:
//
//   - JSON bodies      -> `jsonDigest`, a sha256 over the parsed body with
//                         `generatedAt` removed (it is a wall clock and
//                         differs on every call), plus the door count.
//   - bodies >= 32 KB  -> `sha256` + `byteLength`. Still an exact
//                         byte-equality proof, just not human readable.
//   - everything else  -> `bodyBase64`, so the Latin-1 and CRLF bytes of
//                         diz/doc/files stay inspectable by eye.
//
// Large bodies also keep `headBase64`, the first 512 bytes, so a failure
// says something more useful than "digest differs".
const INLINE_BODY_LIMIT = 32 * 1024;

interface Capture {
  name: string;
  method: 'GET' | 'HEAD';
  requestPath: string;
  requestHeaders: Record<string, string>;
  status: number;
  headers: Record<string, string>;
  bodyBase64?: string;
  headBase64?: string;
  sha256?: string;
  byteLength?: number;
  jsonDigest?: string;
  doorCount?: number;
}

/** sha256 of a JSON body with the wall-clock field lifted out. */
export function jsonBodyDigest(body: Buffer): { digest: string; doorCount: number } {
  const parsed = JSON.parse(body.toString('utf-8')) as Record<string, unknown> & { doors?: unknown[] };
  delete parsed.generatedAt;
  return {
    digest: crypto.createHash('sha256').update(JSON.stringify(parsed)).digest('hex'),
    doorCount: Array.isArray(parsed.doors) ? parsed.doors.length : 0,
  };
}

async function capture(
  name: string,
  requestPath: string,
  requestHeaders: Record<string, string> = {},
  method: 'GET' | 'HEAD' = 'GET'
): Promise<Capture> {
  const res = await fetch(`${BASE}${requestPath}`, { method, headers: requestHeaders });
  const body = Buffer.from(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const key of HEADERS_OF_INTEREST) {
    const value = res.headers.get(key);
    if (value !== null) headers[key] = value;
  }
  const base: Capture = { name, method, requestPath, requestHeaders, status: res.status, headers };
  if ((headers['content-type'] ?? '').includes('application/json') && body.length > 0) {
    const { digest, doorCount } = jsonBodyDigest(body);
    return { ...base, jsonDigest: digest, doorCount, byteLength: body.length };
  }
  if (body.length >= INLINE_BODY_LIMIT) {
    return {
      ...base,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      byteLength: body.length,
      headBase64: body.subarray(0, 512).toString('base64'),
    };
  }
  return { ...base, bodyBase64: body.toString('base64'), byteLength: body.length };
}

async function main(): Promise<void> {
  if (!BASE) {
    console.error('[ERROR] usage: capture-parity-fixtures.ts <base-url e.g. http://localhost:3001/api/door-repo>');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const archives = process.argv.slice(3);
  const captures: Capture[] = [];
  captures.push(await capture('manifest', '/manifest'));
  captures.push(await capture('list', '/list.txt'));
  captures.push(await capture('health', '/health'));
  // The filtered forms have their own SQL path - and the q filter is the one
  // place the port deliberately differs from the source (it drops the
  // installed_as term, whose column this server does not have). Capture both
  // so the difference is visible rather than assumed.
  captures.push(await capture('manifest-type-xim', '/manifest?type=XIM'));
  captures.push(await capture('list-type-xim', '/list.txt?type=XIM'));
  captures.push(await capture('manifest-q', '/manifest?q=door'));
  // The one deliberate divergence in the port: the BBS's ?q= filter also
  // searches installed_as, a per-node column this server's schema drops.
  // `q=door` (above) matches 249 doors on the live catalog with ZERO of
  // them matched via installed_as alone, so it proves nothing about this
  // difference. `q=KICKBOX` matches exactly one door, 187-KB1.LZH, and
  // ONLY through installed_as - verified against the live catalog. Named
  // `divergence-*` so the generic comparison loop in tests/parity.test.ts
  // excludes it (it is SUPPOSED to differ) and a dedicated test pins the
  // difference explicitly instead.
  captures.push(await capture('divergence-q-installed-as', '/manifest?q=KICKBOX'));
  for (const a of archives) {
    const enc = encodeURIComponent(a);
    captures.push(await capture(`files-${a}`, `/files/${enc}`));
    captures.push(await capture(`diz-${a}`, `/diz/${enc}`));
    captures.push(await capture(`doc-${a}`, `/doc/${enc}`));
    captures.push(await capture(`archive-${a}`, `/archive/${enc}`));
  }
  captures.push(await capture('archive-missing', '/archive/NOPE-NOT-REAL.LHA'));
  // HEAD and Range are captured because they are ODD today and the port must
  // not quietly "fix" them. Verified against the live API: the catch-all
  // router bails on any method that is not GET (door-repo.routes.ts:379), so
  // HEAD on a per-archive path falls through to Express's HTML 404 - even
  // for an archive that GET serves happily. And GET ignores Range entirely:
  // a `bytes=0-99` request returns 200 with all 25528 bytes. Both are
  // pre-existing behaviour, tracked separately; parity means preserving
  // them here, not repairing them mid-move.
  if (archives.length > 0) {
    const first = encodeURIComponent(archives[0]);
    captures.push(await capture(`head-archive-${archives[0]}`, `/archive/${first}`, {}, 'HEAD'));
    captures.push(await capture(`head-files-${archives[0]}`, `/files/${first}`, {}, 'HEAD'));
    captures.push(await capture(`range-archive-${archives[0]}`, `/archive/${first}`, { Range: 'bytes=0-99' }));
  }
  // Latin-1 archive name, percent-encoded the way an Amiga client encodes it
  // (%DF, not UTF-8's %C3%9F). Passed raw, NOT through encodeURIComponent.
  captures.push(await capture('files-latin1-raw', '/files/%24CP-BU%DF1.LZX'));
  // A capture run against a MISCONFIGURED server is the dangerous failure
  // here: if the BBS is not in owner mode the router is not mounted, every
  // request 404s, and the fixture set becomes 24 rows of "NOT FOUND" that
  // the new server would match trivially - parity would pass while proving
  // nothing. Verified against the live API: every per-archive endpoint for
  // the named archives answers 200 today. So refuse to write a fixture set
  // that does not look like a working catalog.
  const shouldBe200 = captures.filter(
    (c) => c.method === 'GET' && !c.name.startsWith('archive-missing')
  );
  const bad = shouldBe200.filter((c) => c.status !== 200);
  if (bad.length > 0) {
    console.error(`[ERROR] ${bad.length} capture(s) did not return 200 - is the source server in owner mode?`);
    for (const c of bad) console.error(`[ERROR]   ${c.status} ${c.requestPath}`);
    process.exit(1);
  }
  const manifest = captures.find((c) => c.name === 'manifest');
  const doors = manifest?.doorCount ?? 0;
  if (doors < 100) {
    console.error(`[ERROR] manifest carries only ${doors} doors - that is not the real catalog, refusing to write fixtures`);
    process.exit(1);
  }

  fs.writeFileSync(path.join(OUT, 'captures.json'), JSON.stringify(captures, null, 1), 'utf-8');
  console.log(`[OK] captured ${captures.length} responses from ${BASE} (${doors} doors in the manifest)`);
}

// Guarded like scripts/gen-contract-types.ts: tests/parity.test.ts imports
// jsonBodyDigest from this module. An unconditional call here would run
// main() as a side effect of that import, with Jest's own CLI argv
// (`--config`, `jest.config.ts`, ...) standing in for BASE - which is
// exactly what happened the first time this ran (`Failed to parse URL from
// --config/manifest`). Only run when this file is the entry point.
if (require.main === module) {
  void main();
}
