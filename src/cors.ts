/**
 * Cross-origin access for this server's door-repo API.
 *
 * The BBS-hosted API (amiexpress-web, docs/DOOR-REPO-API.md section 1)
 * already sends these headers, and a client (UHC Tools' `uhcsearch`) has
 * been built and tested against that host purely because this one — the
 * host that does not depend on the BBS being up, which is the entire
 * reason it exists — blocked it. This makes the two hosts behave
 * identically for the headers listed below: every /api/door-repo endpoint
 * here is already public, read-only and unauthenticated, and answers the
 * same bytes to curl, to a 68K door, and to a browser. The only thing this
 * changes is whether a BROWSER is willing to let its own JavaScript read a
 * reply it already received.
 *
 * Mirrors, header value for header value, four things
 * amiexpress-web/web/backend/src/server/door-repo-cors.ts sends (checked
 * against that source, not just recalled): Access-Control-Allow-Origin,
 * Access-Control-Expose-Headers, the absence of
 * Access-Control-Allow-Credentials, and the 204/empty-body OPTIONS
 * preflight shape (Allow-Methods/Allow-Headers/Max-Age). Its
 * path-matching helper (isDoorRepoPath) is NOT ported: that exists there
 * because the BBS serves many things and only some are the door repo.
 * Here every path under the router is the door repo, so this middleware
 * is simply mounted in front of the whole router (app.ts).
 *
 * Cross-Origin-Resource-Policy: cross-origin IS also sent, matching the
 * BBS (helmet sets it there; this server has no helmet, so it is set here
 * explicitly). It is load-bearing, not decorative: without it, a browser
 * page running under COEP (Cross-Origin-Embedder-Policy) cannot load this
 * catalog, or an archive download, as a subresource — and browser clients
 * are exactly who a CORS-enabled host exists for.
 *
 * Cross-Origin-Resource-Policy is set ONLY here, deliberately. This host's
 * Caddy config carries no `header` directives for this path prefix — Caddy
 * and Express each setting CORP previously produced two conflicting header
 * values on the same response, which browsers reject outright (a full day
 * lost to that before it was traced to the duplicate). Do not add a CORP
 * header anywhere else (Caddy, another Express middleware) without
 * removing this one first.
 *
 * Cross-Origin-Opener-Policy is deliberately NOT sent, unlike some
 * same-origin-hardened hosts. COOP governs top-level browsing contexts
 * (window/tab isolation) and has no effect on a JSON or plain-text API
 * response — adding it here would be cargo-culting a header that does
 * nothing for this endpoint shape.
 *
 * Four things have to be right together, or it still looks like "CORS is
 * broken" from the browser:
 *   1. Access-Control-Allow-Origin: * — permission to read the response.
 *      Deliberate and unrestricted: this is a public, read-only catalog,
 *      and the entire point is that anyone can build a client against it.
 *      No allowlist.
 *   2. NO Access-Control-Allow-Credentials — a wildcard origin combined
 *      with credentials is invalid per the Fetch spec and browsers reject
 *      the response outright. There is no session here to carry.
 *   3. Cross-Origin-Resource-Policy: cross-origin — permission to load the
 *      response as a subresource from a COEP-enabled page (see above).
 *   4. A preflight OPTIONS request must be answered directly (204, empty
 *      body) rather than falling through to the router, which has no
 *      OPTIONS handler and would 404 it.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Response headers a cross-origin client may read. Content-Length is not
 * CORS-safelisted either, and a downloader wants it for progress.
 * X-Door-Repo-Total is not sent by any endpoint yet (paging arrives later)
 * — exposing it now is harmless and saves a second edit when it does.
 */
export const DOOR_REPO_EXPOSED_HEADERS = [
  'Content-Length',
  'X-Archive-MD5',
  'X-Archive-SHA256',
  'X-Door-Repo-Revision',
  'X-Door-Repo-Total',
];

/**
 * Request headers a preflight may ask for. A plain GET is a "simple
 * request" and never preflights, but a conditional fetch does:
 * If-None-Match is not CORS-safelisted, and revalidating against
 * X-Door-Repo-Revision/ETag is exactly what a well-behaved client does.
 */
export const DOOR_REPO_ALLOWED_REQUEST_HEADERS = ['If-None-Match', 'If-Modified-Since', 'Range', 'Content-Type'];

export function doorRepoCors(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', DOOR_REPO_EXPOSED_HEADERS.join(', '));
    // Load-bearing for a browser page running under COEP — see the module
    // doc comment. Set ONLY here: Caddy sets none for this path prefix on
    // purpose, to avoid the duplicate-header conflict described above.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', DOOR_REPO_ALLOWED_REQUEST_HEADERS.join(', '));
      res.setHeader('Access-Control-Max-Age', '86400');
      res.status(204).end();
      return;
    }

    next();
  };
}
