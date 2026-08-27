// tests/parity.test.ts
/**
 * Byte-parity against the BBS-hosted API.
 *
 * The captures were taken from the API this server replaces. Any
 * difference in status, header or body is a regression in the move - the
 * whole safety argument for the split is that location changed and
 * behaviour did not.
 *
 * Skips itself when no capture file is present, so a fresh checkout is not
 * blocked; CI runs with the fixtures committed.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createApp } from '../src/app';
import { jsonBodyDigest } from '../scripts/capture-parity-fixtures';
import { buildManifest, renderListTxt } from '../src/manifest';
import { loadConfig } from '../src/config';

const CAPTURES = path.join(__dirname, 'fixtures', 'parity', 'captures.json');

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

const shouldRun = fs.existsSync(CAPTURES) && Boolean(process.env.PARITY_DB);
const describeOrSkip = shouldRun ? describe : describe.skip;

describeOrSkip('parity with the BBS-hosted API', () => {
  // `describe.skip(name, fn)` still executes `fn` synchronously during
  // Jest's collection phase - only the `it()` bodies registered inside are
  // actually skipped. Without this early return, a plain `npm test` (no
  // PARITY_DB set) would still hit loadConfig() below and throw
  // "DOORSERVER_DB is not set", failing the whole suite instead of skipping
  // it. Verified live: that is exactly what happened before this guard.
  //
  // A bare early return isn't enough either: with zero `it()`s registered,
  // Jest itself fails the suite with "Your test suite must contain at least
  // one test" - also verified live. A placeholder keeps the file always
  // registering something; describe.skip marks it (and everything else in
  // this block) skipped rather than run.
  if (!shouldRun) {
    console.warn(
      '[WARN] parity NOT verified: PARITY_DB is unset. A skipped parity run is not a passing one.'
    );
    it('SKIPPED: parity not verified - PARITY_DB unset', () => {
      /* real assertions only run when both are present; see shouldRun above */
    });
    return;
  }

  const captures: Capture[] = JSON.parse(fs.readFileSync(CAPTURES, 'utf-8'));
  const cfg = loadConfig({
    DOORSERVER_DB: process.env.PARITY_DB,
    DOOR_ARCHIVES_ROOT: process.env.PARITY_ARCHIVES,
  });
  const app = createApp(cfg);

  // `divergence-*` captures record a KNOWN, deliberate difference (see the
  // dedicated test below) rather than a parity claim - running them through
  // this byte-equality loop would fail by design, not by regression.
  //
  // The same is true of every capture that carries a DESCRIPTION. The BBS
  // served the catalog's raw `description` column, which is scene box art as
  // often as it is words; this server reads what the door IS out of its
  // FILE_ID.DIZ (src/describe.ts). That was a deliberate change, and the
  // test below proves it is the ONLY change: it rebuilds each of these
  // bodies with the raw column put back and asserts the result still hashes
  // to the byte the old API produced.
  const DESCRIPTION_DIVERGENT = new Set(['manifest', 'list', 'manifest-type-xim', 'list-type-xim', 'manifest-q']);
  const parityCaptures = captures.filter(
    (c) => !c.name.startsWith('divergence-') && !DESCRIPTION_DIVERGENT.has(c.name)
  );

  for (const c of parityCaptures) {
    it(`${c.name} matches`, async () => {
      const agent = request(app);
      const res = await (c.method === 'HEAD'
        ? agent.head(`/api/door-repo${c.requestPath}`)
        : agent.get(`/api/door-repo${c.requestPath}`))
        .set(c.requestHeaders)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (d: Buffer) => chunks.push(d));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(c.status);
      for (const [key, value] of Object.entries(c.headers)) {
        if (key === 'content-type' || key === 'content-length' || key.startsWith('x-') || key === 'etag') {
          expect(`${key}=${res.headers[key]}`).toBe(`${key}=${value}`);
        }
      }

      // The manifest body carries `generatedAt: new Date().toISOString()`
      // (door-repo-manifest.ts:309), so its bytes are never twice the same
      // and a raw base64 comparison could not pass even against the server
      // that produced the capture. Verified against the live API: two calls
      // one second apart differ only in that field. Compare the manifest
      // structurally with the timestamp lifted out, and assert separately
      // that the field is still a real ISO instant. Its length is fixed
      // (24 chars), so Content-Length above stays a valid check.
      // EVERY other endpoint is compared byte-for-byte.
      // A HEAD response has no body by definition; its status and headers are
      // the whole contract - but the capture recorded that emptiness too, so
      // assert it rather than skipping the body check entirely.
      //
      // supertest/superagent never invokes a custom body parser for a HEAD
      // request - verified with a standalone probe (a HEAD against a route
      // whose GET body is non-empty still yields res.body === {}) - so
      // res.body is NOT the Buffer our .parse() callback produces for every
      // other method here; it stays superagent's untouched default. That IS
      // the emptiness guarantee worth asserting: if a future supertest ever
      // started parsing a HEAD body, this fails loudly. The actual byte
      // count a GET would have sent is already pinned by the Content-Length
      // equality check above.
      if (c.method === 'HEAD') {
        expect(res.body).toEqual({});
        return;
      }

      const body = res.body as Buffer;
      expect(body.length).toBe(c.byteLength);

      // A JSON body carries `generatedAt: new Date().toISOString()`
      // (door-repo-manifest.ts:309), so its bytes are never twice the same -
      // verified live, two calls a second apart differ only there. Compare a
      // digest of the body with that field lifted out, and assert separately
      // that the field is still a real ISO instant. Its length is fixed at 24
      // characters, so the Content-Length check above still bites.
      if (c.jsonDigest !== undefined) {
        const parsed: Record<string, unknown> = JSON.parse(body.toString('utf-8'));
        // Only /manifest carries a wall-clock `generatedAt`
        // (door-repo-manifest.ts:309); /health's body is `{ status,
        // revision, doors }` (routes.ts) and has no such field. Assert the
        // ISO-instant shape only when the field is actually present, rather
        // than assuming every JSON capture is a manifest.
        if ('generatedAt' in parsed) {
          expect(parsed.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }
        const { digest, doorCount } = jsonBodyDigest(body);
        // /health's body has no `doors` array at all, so jsonBodyDigest
        // reports doorCount: 0 for it - a trivially-true assertion that
        // reads stronger than it is. Only assert the count where it means
        // something: a manifest capture that actually carries doors.
        if (c.doorCount !== undefined && c.doorCount > 0) {
          expect(doorCount).toBe(c.doorCount);
        }
        expect(digest).toBe(c.jsonDigest);
        return;
      }

      // Large non-JSON bodies (list.txt is 620 KB) are pinned by digest -
      // exactly as strict as comparing bytes, without committing them. The
      // first 512 bytes are compared too, so a failure shows something
      // readable rather than only "digest differs".
      if (c.sha256 !== undefined) {
        expect(body.subarray(0, 512).toString('base64')).toBe(c.headBase64);
        expect(crypto.createHash('sha256').update(body).digest('hex')).toBe(c.sha256);
        return;
      }

      // Everything small is compared byte-for-byte, which is where the
      // Latin-1 and CRLF risk actually lives.
      expect(body.toString('base64')).toBe(c.bodyBase64);
    });
  }

  /**
   * Put the raw catalog `description` back into a rendered body, exactly
   * where the classifier's answer sits now. If every other byte of the port
   * is faithful, the result must be what the old API sent.
   */
  function rawDescriptions(): Map<string, string | null> {
    const db = new Database(process.env.PARITY_DB as string, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT archive_name, description FROM door_catalog')
        .all() as { archive_name: string; description: string | null }[];
      return new Map(rows.map((r) => [r.archive_name, r.description]));
    } finally {
      db.close();
    }
  }

  describe('known divergence: descriptions are now read from FILE_ID.DIZ', () => {
    const raw = rawDescriptions();
    const withRawDescriptions = (opts?: { type?: string; q?: string }) => {
      const m = buildManifest(cfg, opts);
      return { ...m, doors: m.doors.map((d) => ({ ...d, description: raw.get(d.archiveName) ?? null })) };
    };

    it.each([
      ['list', undefined],
      ['list-type-xim', { type: 'XIM' }],
    ] as const)('%s differs from the BBS in the description column and nowhere else', (name, opts) => {
      const capture = captures.find((c) => c.name === name);
      expect(capture?.sha256).toBeDefined();
      const restored = renderListTxt(withRawDescriptions(opts));
      expect(crypto.createHash('sha256').update(restored).digest('hex')).toBe(capture?.sha256);
      expect(restored.length).toBe(capture?.byteLength);
    });

    it.each([
      ['manifest', undefined],
      ['manifest-type-xim', { type: 'XIM' }],
      ['manifest-q', { q: 'door' }],
    ] as const)('%s differs from the BBS in the description field and nowhere else', (name, opts) => {
      const capture = captures.find((c) => c.name === name);
      expect(capture?.jsonDigest).toBeDefined();
      const restored = Buffer.from(JSON.stringify(withRawDescriptions(opts)), 'utf-8');
      const { digest, doorCount } = jsonBodyDigest(restored);
      expect(digest).toBe(capture?.jsonDigest);
      if (capture?.doorCount) expect(doorCount).toBe(capture.doorCount);
    });

    it('and the classified description is actually what gets served', async () => {
      const res = await request(app).get('/api/door-repo/manifest?q=ALSTER');
      expect(res.status).toBe(200);
      const door = res.body.doors.find((d: { archiveName: string }) => d.archiveName === '!ALSTER.LHA');
      // The catalog's own column for this row is box art; the served
      // description is the door's own line, read out of the DIZ. NEWUSERS
      // arrives shouted in the DIZ and is de-shouted by the classifier.
      expect(raw.get('!ALSTER.LHA')).toMatch(/[_\\/]{3,}/);
      expect(door.description).toBe('Children - This tool starts only for Newusers /X');
    });
  });

  // The one deliberate divergence in the port. The BBS's ?q= filter also
  // searches installed_as - a per-node column this server's schema drops -
  // so a query that matches ONLY through that column returns one door there
  // and none here. Verified against the live catalog: 187-KB1.LZH is matched
  // by q=KICKBOX solely through installed_as. This test exists so the
  // divergence is a recorded decision rather than a surprise, and so it
  // fails loudly if a later phase ever restores the column.
  it('known divergence: ?q= no longer searches the per-node installed_as column', async () => {
    const capture = captures.find((c) => c.name === 'divergence-q-installed-as');
    expect(capture).toBeDefined();
    expect(capture?.doorCount).toBe(1);

    const res = await request(app).get('/api/door-repo/manifest?q=KICKBOX');
    expect(res.status).toBe(200);
    expect(res.body.doors).toHaveLength(0);
  });
});
