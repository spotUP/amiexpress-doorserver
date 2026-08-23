/**
 * door-repo routes: read-only HTTP API over the door catalog, for both
 * modern (web) consumers and legacy AmigaDOS door-repo clients.
 *
 *   GET /manifest              JSON DoorRepoManifest; ETag + RFC 7232
 *                              conditional GET (via Express's built-in
 *                              freshness check, see the handler below).
 *   GET /list.txt              byte-exact ISO-8859-1/CRLF plain-text index.
 *   GET /archive/:archiveName  streams the archive file + its checksums.
 *   GET /health                { status, revision, doors } — lightweight;
 *                              uses getDoorCount(), never buildManifest(),
 *                              so a liveness poll never re-hashes the
 *                              whole archive corpus.
 *
 * All four thin-wrap Task 1/2 building blocks (door-repo-manifest.ts,
 * door-repo-checksums.ts) and door-catalog.service.ts — no new DB access
 * or business logic lives here.
 *
 * Security: the archive endpoint resolves the requested file ONLY through
 * getCatalogEntryByArchive() (a parameterized `WHERE archive_name = ?`
 * lookup) followed by resolveArchivePath() on the catalog row's own
 * archive_path column. The raw :archiveName URL parameter is NEVER
 * path-joined onto a directory, so an encoded traversal payload
 * (`..%2F..%2Fetc%2Fpasswd`) just fails the catalog lookup and 404s like
 * any other unknown name — it can't reach the filesystem.
 */
import express, { NextFunction, Request, Response } from 'express';
import * as fs from 'fs';
import { pipeline } from 'stream';
import { buildManifest, renderListTxt, renderListTxtCached } from './manifest';
import { getArchiveChecksums } from './checksums';
import { getArchiveFiles, getCatalogEntryByArchive, getCatalogRevision, getDoorCount, resolveArchivePath } from './catalog';
import type { ServerConfig } from './config';

function parseManifestQuery(req: Request): { type?: string; q?: string } {
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  return { type, q };
}

function sendNotFound(res: Response, archiveName: string): void {
  res
    .status(404)
    .set('Content-Type', 'text/plain')
    .send(`NOT FOUND: ${archiveName}\r\n`);
}

/**
 * Handles a mid-stream fs.createReadStream error so it never hangs the
 * request. Extracted as a standalone, exported function (rather than an
 * inline arrow in the pipeline callback) specifically so it can be
 * unit-tested directly against fake Response objects — reproducing a real
 * mid-stream failure end-to-end over HTTP is racy (the moment any bytes
 * are written, the client has already committed to the declared
 * Content-Length, so a truncated response reads as a protocol violation,
 * not a clean "request finished").
 */
export function handleArchiveStreamError(res: Response, archiveName: string): void {
  if (res.headersSent) {
    res.end();
  } else {
    sendNotFound(res, archiveName);
  }
}

/**
 * Streams an already-open archive fd to `res` and reports failure via
 * `handleArchiveStreamError`. Uses stream.pipeline() rather than a plain
 * `.pipe()` specifically because pipe() does NOT destroy the source when
 * the destination closes early — verified with a standalone Node probe
 * (see task-3-report.md): with a real fs.ReadStream(fd) piped via
 * `.pipe(res)`, destroying `res` mid-transfer (a client aborting the
 * download) leaves the source stream — and its fd — untouched, a leak on
 * every interrupted download on a public endpoint. pipeline() destroys
 * BOTH ends on any termination (success, error, or the other side closing
 * early), and destroying a real fs.ReadStream always closes its fd via
 * _destroy(), independent of the `autoClose` option — so this deliberately
 * does NOT pass `autoClose: false` and does NOT close the fd itself in the
 * callback: pipeline has already done that by the time the callback runs
 * (same probe), and closing it again would double-close.
 *
 * `onDone` is test-only instrumentation (the production call site never
 * passes it) — pipeline's own completion is otherwise only observable via
 * the callback closure, and tests need a race-free way to know the fd has
 * already been closed before asserting on it.
 */
export function streamArchive(
  fd: number,
  res: Response,
  archiveName: string,
  onDone?: (err: Error | null) => void
): void {
  const stream = fs.createReadStream('', { fd });
  pipeline(stream, res, (err) => {
    if (err) {
      handleArchiveStreamError(res, archiveName);
    }
    if (onDone) onDone(err ?? null);
  });
}

// Per-entry routes are dispatched from the RAW request URL rather than
// declared as ':archiveName' params.
//
// Express decodes a route parameter as UTF-8 before the handler runs, and
// throws URIError on a percent-escape that is not valid UTF-8 — which turned
// into a 500. Catalog archive names are Latin-1 (Amiga scene releases:
// "$CP-BU\xDF1.LZX"), so a correct client percent-encoding that name as %DF
// got a 500 instead of its download. That affected GET /archive too, and had
// been there since before /diz existed.
//
// Decoding here instead: try UTF-8 (what a modern client sends), fall back to
// Latin-1 (what a name like the above requires), and try the other spelling
// against the catalog before giving up. Nothing can throw out of this path, so
// a malformed escape is a 404 like any other unknown name — never a 500.
function decodePercentLatin1(encoded: string): string {
  return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_full, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)));
}

/** Every decoding worth trying for a percent-encoded archive name, most
 *  standard first, with duplicates removed. */
export function candidateArchiveNames(encoded: string): string[] {
  const out: string[] = [];
  try {
    out.push(decodeURIComponent(encoded));
  } catch {
    /* not valid UTF-8 — the Latin-1 reading below is the whole point */
  }
  const latin1 = decodePercentLatin1(encoded);
  if (!out.includes(latin1)) {
    out.push(latin1);
  }
  return out;
}

export function createRouter(cfg: ServerConfig): express.Router {
  const doorRepoRouter = express.Router();

  // GET /manifest — JSON manifest with ETag / If-None-Match support.
  //
  // Conditional-GET (304) handling is delegated to Express's own freshness
  // primitive, `req.fresh` — backed by the `fresh` npm module, which already
  // implements RFC 7232 correctly: weak comparison (a `W/"<rev>"` validator
  // from a cache/proxy matches our strong `"<rev>"` ETag), comma-separated
  // candidate lists, the `*` wildcard, AND (the part a hand-rolled
  // `if (ifNoneMatch === etag)` shortcut would miss) RFC 9111's
  // `Cache-Control: no-cache` end-to-end-reload override, which must force
  // revalidation even when If-None-Match would otherwise match exactly.
  // Verified directly (see task-3-report.md) before relying on it, both for
  // the implicit form (inside res.json()/res.send()) and this explicit one.
  //
  // The ETag is just the revision string — getCatalogRevision() alone, no
  // catalog access. So: compute it, set the headers, and check `req.fresh`
  // BEFORE calling buildManifest() at all. A 304 must never pay for
  // building (and, transitively, checksumming) the full manifest just to
  // throw the result away.
  doorRepoRouter.get('/manifest', (req: Request, res: Response) => {
    const revision = getCatalogRevision(cfg);

    res.set('X-Door-Repo-Revision', revision);
    res.set('ETag', `"${revision}"`);

    if (req.fresh) {
      res.status(304).end();
      return;
    }

    const manifest = buildManifest(cfg, parseManifestQuery(req));
    res.json(manifest);
  });

  // GET /list.txt — byte-exact ISO-8859-1/CRLF plain-text index.
  doorRepoRouter.get('/list.txt', (req: Request, res: Response) => {
    // Served from the revision-keyed cache: the bytes only change when the
    // catalog does, and every door start asks for this exact resource.
    const query = parseManifestQuery(req);
    const body = renderListTxtCached(cfg, query);

    res.set('X-Door-Repo-Revision', getCatalogRevision(cfg));
    res.set('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.send(body);
  });

  // GET /archive/:archiveName — stream the archive + checksum headers.
  //
  // The declared Content-Length and the streamed bytes MUST come from the
  // same open of the file. Doing an independent fs.statSync(path) for the
  // size and a later, separate fs.createReadStream(path) for the body is a
  // TOCTOU: if the file's size changes between those two opens (a
  // re-indexed/replaced archive), the declared Content-Length no longer
  // matches the byte count actually streamed and HTTP/1.1 framing corrupts
  // for that connection. So: open once (fs.openSync), size via fstatSync on
  // that fd, and stream from that same fd via streamArchive() (see its own
  // doc comment for why that's stream.pipeline()-based, not a plain
  // .pipe(), and who owns closing the fd).
  //
  // Checksums are a separate concern: getArchiveChecksums() does its own
  // independent statSync+readFileSync via the Task 1 cache module. That's
  // fine — they're metadata headers, not wire framing, and re-reading lets
  // us keep reusing the existing cached-by-mtime+size implementation as-is.
  function handleArchiveRequest(res: Response, archiveName: string): void {
    res.set('X-Door-Repo-Revision', getCatalogRevision(cfg));

    const entry = getCatalogEntryByArchive(cfg, archiveName);
    if (!entry) {
      sendNotFound(res, archiveName);
      return;
    }

    const absPath = resolveArchivePath(cfg, entry.archive_path);

    let fd: number;
    try {
      fd = fs.openSync(absPath, 'r');
    } catch {
      sendNotFound(res, archiveName);
      return;
    }

    let size: number;
    try {
      size = fs.fstatSync(fd).size;
    } catch {
      fs.closeSync(fd);
      sendNotFound(res, archiveName);
      return;
    }

    let checksums: { md5: string; sha256: string };
    try {
      checksums = getArchiveChecksums(absPath);
    } catch {
      fs.closeSync(fd);
      sendNotFound(res, archiveName);
      return;
    }

    res.set('Content-Length', String(size));
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Archive-MD5', checksums.md5);
    res.set('X-Archive-SHA256', checksums.sha256);

    streamArchive(fd, res, archiveName);
  }

  // GET /health — { status, revision, doors }. Uses getDoorCount(), NOT
  // buildManifest(): buildManifest computes md5+sha256 for every catalog row
  // (~3300 archives), which is far too expensive to pay on every liveness
  // poll — a monitor hitting this endpoint would re-hash the whole repo on
  // the first request after any archive touch.
  // GET /diz/:archiveName — the entry's FILE_ID.DIZ as raw text, newlines
  // intact.
  //
  // Why this exists as its own endpoint rather than a list.txt field: the
  // list.txt contract deliberately collapses every newline to a space (see
  // docs/DOOR-REPO-API.md, "Newline collapsing"), because the format is one
  // row per line and a raw newline would split a row. That is the right call
  // for a tabular format, but it means multi-line FILE_ID.DIZ art cannot be
  // reconstructed by any list.txt client. The art survives only in
  // GET /manifest's fileIdDiz — and the manifest is ~2 MB of JSON, which a
  // C89 door on a real Amiga can neither parse nor hold.
  //
  // So: one small, plain-text, per-archive read. This is ADDITIVE. Every
  // existing endpoint and the byte-exact list.txt spec are untouched, which
  // keeps the published contract's append-only promise intact for clients
  // already written against it.
  //
  // 404 (not an empty 200) when the entry exists but has no DIZ, so a client
  // can tell "no art for this door" from "art that happens to be empty".
  // Lookup is the same parameterized getCatalogEntryByArchive() the archive
  // route uses, so an encoded traversal payload just fails the lookup — the
  // raw parameter never reaches the filesystem.
  function handleDizRequest(res: Response, archiveName: string): void {
    res.set('X-Door-Repo-Revision', getCatalogRevision(cfg));

    const entry = getCatalogEntryByArchive(cfg, archiveName);
    if (!entry || !entry.file_id_diz) {
      sendNotFound(res, archiveName);
      return;
    }

    // ISO-8859-1 for the same reason list.txt uses it: DIZ art is Latin-1
    // high-bit box drawing, and declaring UTF-8 would mangle it.
    res.set('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.send(Buffer.from(entry.file_id_diz, 'latin1'));
  }

  // GET /files/:archiveName — the archive's contents, one file per line.
  //
  // Mirrors what DOORMAN shows in its own info pane (getArchiveFiles(), rendered
  // as "N files / N ad files" plus the listing), so a client that is not sitting
  // on the catalog database can show the same thing.
  //
  // Format, deliberately trivial to parse in C89 — no JSON, no quoting rules:
  //
  //   FILES|<count>|<junkCount>
  //   <size>|<isJunk 0|1>|<path>
  //   ...
  //
  // Line ending is CRLF and the charset is ISO-8859-1, matching list.txt so a
  // client needs one reader for both. Paths cannot contain a pipe (they come
  // from archive listings and are filtered the same way list.txt escapes its
  // fields), and any that did would be escaped to "!" the same way.
  function handleFilesRequest(res: Response, archiveName: string): void {
    res.set('X-Door-Repo-Revision', getCatalogRevision(cfg));

    const entry = getCatalogEntryByArchive(cfg, archiveName);
    if (!entry) {
      sendNotFound(res, archiveName);
      return;
    }

    const files = getArchiveFiles(cfg, entry.id);
    const junk = files.filter((f) => f.is_junk).length;

    const lines: string[] = [`FILES|${files.length}|${junk}`];
    for (const f of files) {
      const safePath = String(f.path).replace(/\|/g, '!');
      lines.push(`${f.size}|${f.is_junk ? 1 : 0}|${safePath}`);
    }

    res.set('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.send(Buffer.from(lines.join('\r\n') + '\r\n', 'latin1'));
  }

  // GET /doc/<archiveName> — the door's own documentation, raw.
  //
  // DOORMAN offers "V=View doc" for entries that carry one; this exposes the
  // same doc_raw so a client that is not sitting on the catalog database can
  // too. 3216 of 3301 catalog entries have one.
  //
  // Served as raw bytes with no transformation. Amiga door docs are Latin-1 and
  // routinely contain form feeds, ANSI art and other control bytes; anything
  // that "cleaned them up" would corrupt the very thing the reader wants to see.
  // The filename is exposed in a header rather than the body so the body stays
  // byte-exact.
  //
  // 404 when the archive is unknown or has no doc — as with /diz, "none" and
  // "unknown" are one case for the client to handle.
  function handleDocRequest(res: Response, archiveName: string): void {
    res.set('X-Door-Repo-Revision', getCatalogRevision(cfg));

    const entry = getCatalogEntryByArchive(cfg, archiveName);
    if (!entry || !entry.doc_raw) {
      sendNotFound(res, archiveName);
      return;
    }

    if (entry.doc_filename) {
      res.set('X-Doc-Filename', String(entry.doc_filename).replace(/[^\x20-\x7e]/g, '_'));
    }
    res.set('Content-Type', 'text/plain; charset=ISO-8859-1');
    res.send(Buffer.from(entry.doc_raw, 'latin1'));
  }

  doorRepoRouter.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') {
      next();
      return;
    }
    const match = /^\/(diz|archive|files|doc)\/(.+)$/.exec(req.url.split('?')[0]);
    if (!match) {
      next();
      return;
    }

    const kind = match[1];
    const names = candidateArchiveNames(match[2]);
    // Prefer a spelling that actually exists in the catalog; otherwise use the
    // first, so the 404 body echoes what the client most likely meant.
    const name = names.find((n) => getCatalogEntryByArchive(cfg, n)) ?? names[0];

    if (kind === 'diz') {
      handleDizRequest(res, name);
    } else if (kind === 'files') {
      handleFilesRequest(res, name);
    } else if (kind === 'doc') {
      handleDocRequest(res, name);
    } else {
      handleArchiveRequest(res, name);
    }
  });

  doorRepoRouter.get('/health', (req: Request, res: Response) => {
    const revision = getCatalogRevision(cfg);
    const doors = getDoorCount(cfg);
    res.set('X-Door-Repo-Revision', revision);
    res.json({ status: 'ok', revision, doors });
  });

  return doorRepoRouter;
}
