/**
 * The ETag Express would put on a given body.
 *
 * Two suites need it - tests/parity.test.ts, comparing this server against
 * the BBS captures, and tests/achievements/mount.test.ts, proving the same
 * mechanism where the numbers are known - and "how Express computes an
 * ETag" must not be written twice.
 *
 * It is not a reimplementation: `etag` IS the module res.send() calls
 * (Express's default `etag` setting is 'weak', whose generator is
 * `etag(body, { weak: true })`), so this compares like with like. It has no
 * type declarations of its own and adding `@types/etag` for one signature
 * would be a dependency for two lines, so the signature is written here and
 * the import is typed at this one site.
 *
 * WHY A TEST NEEDS THIS AT ALL: an ETag is derived from the response body.
 * Appending a single key to a JSON object therefore moves it, exactly as it
 * moves Content-Length - so a byte-parity comparison that lifts an added
 * key back out has to re-derive the ETag from the reconstruction rather
 * than compare the captured one against the live header.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const etag: (body: Buffer | string, options?: { weak?: boolean }) => string = require('etag');

export function weakEtag(body: Buffer): string {
  return etag(body, { weak: true });
}
