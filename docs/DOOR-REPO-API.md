# Door Repo API

> This API is served by the `amiexpress-doorserver` repository.
> `amiexpress-web` proxies `/api/door-repo/*` for compatibility.

A public, read-only HTTP API for browsing and downloading the AmiExpress door
catalog. It is designed to be usable from a real Amiga running an AmigaDOS
TCP/IP stack, not just from a modern HTTP client.

This document is the complete public reference. Every byte-exact example in
it was captured by executing the real server code against the real door
catalog (3301 doors at the time of writing) -- nothing here is invented.
Where the exact revision string differs between a local run and a live
deployment, that is called out explicitly.

## 1. Overview

The door repo is the catalog of door archives (games, utilities, BBS door
programs) available for an AmiExpress sysop to browse, search, and download
onto a real or emulated Amiga BBS. It is served over plain HTTP by the
amiexpress-web backend.

- **Base URL:** `https://bbs.uprough.net`
- **Plain HTTP is live and permanent for `/api/door-repo/*`.** Every endpoint
  under this prefix also answers on `http://bbs.uprough.net` (no TLS
  required). This is deliberate: classic AmigaDOS TCP/IP stacks (AmiTCP,
  Miami, Roadshow) and 68020+ door clients frequently have no practical way
  to do TLS, so plain HTTP is a first-class, permanently supported access
  path for this API, not a legacy fallback. The production reverse proxy
  (Caddy) carries an explicit exemption for the `/api/door-repo/` path
  prefix from its site-wide automatic HTTPS redirect, confirmed live by
  direct measurement (see the note below).
- **Every other path on this host still redirects plain HTTP to HTTPS.**
  Only `/api/door-repo/*` is exempted. Do not assume plain HTTP works
  against any other endpoint on `bbs.uprough.net` -- it does not, and is not
  expected to.
- **The API is live on `bbs.uprough.net`.** Measured directly against the
  live host on 2026-08-17:

  ```
  curl -s -o /dev/null -w '%{http_code}' http://bbs.uprough.net/api/door-repo/health
  -> 200
  curl -s http://bbs.uprough.net/api/door-repo/health
  -> {"status":"ok","revision":"a2d8b215ec846fc13b80cb037b9df0c541b848fc","doors":3301}
  curl -s -o /dev/null -w '%{http_code}' http://bbs.uprough.net/health
  -> 301   (an unrelated, non-door-repo path -- still redirects, as expected)
  curl -s -o /dev/null -w '%{http_code}' https://bbs.uprough.net/health
  -> 200
  curl -s -o /dev/null -w '%{http_code}' https://bbs.uprough.net/api/door-repo/health
  -> 200
  ```

- **This API is only served by a door-repo OWNER deployment; a consumer
  deployment does not serve it at all.** amiexpress-web is deployed by many
  independent sysops, and every one of those deployments runs the same
  backend code -- but the door-repo API is mounted only when that specific
  box has `DOOR_REPO_ROLE=owner` set (see `deploy/README.md`, "Door repo:
  owner vs. consumer"). On any other (consumer) deployment the `/api/door-repo/*`
  paths simply do not exist: there is no custom "disabled" response, no
  distinguishing header, nothing that advertises the feature is off. A `404`
  from an arbitrary amiexpress-web install is therefore normal and expected
  most of the time -- most deployments are consumers, not owners -- and does
  not by itself indicate a bug.

  A `404` on `/api/door-repo/*` can happen for two different reasons that
  produce the *same* generic response, and this API gives a client no way to
  tell them apart from the response alone:

  1. **This deployment is not a door-repo owner** (the common case: most
     amiexpress-web installs are consumers). The router is never mounted, so
     every path under the prefix 404s via Express's own default "no route
     matched" handler.
  2. **This deployment is supposed to be the owner but something is broken**
     (a genuine deployment regression on a box you already know is meant to
     serve this API, e.g. `bbs.uprough.net` itself).

  Both cases produce the identical body shown below -- there is no way to
  distinguish "not an owner" from "owner, but broken" over HTTP. If you are
  specifically checking `bbs.uprough.net` (the canonical owner host
  documented here) and see this response, that is a regression worth
  reporting; against any other, unknown amiexpress-web install, treat it as
  "this box doesn't serve the repo," not as evidence of anything broken.
  Real captured example (an unrecognized path under the prefix, captured
  2026-08-17 against `bbs.uprough.net` -- the router IS mounted here, so this
  specifically shows Express's own fallback for a path the router itself
  does not define; a not-mounted-at-all consumer deployment produces the
  same shape of response for every path under the prefix, health included):

  ```
  curl -s http://bbs.uprough.net/api/door-repo/totally-bogus-endpoint-xyz
  -> <!DOCTYPE html>
     <html lang="en">
     <head>
     <meta charset="utf-8">
     <title>Error</title>
     </head>
     <body>
     <pre>Cannot GET /api/door-repo/totally-bogus-endpoint-xyz</pre>
     </body>
     </html>
  status: 404
  Content-Type: text/html; charset=utf-8
  ```

  The one reliable tell that distinguishes this generic 404 from this API's
  own `NOT FOUND: <name>` plain-text 404 (section 5, unknown archive name)
  is the `X-Door-Repo-Revision` header: this API's own responses always
  carry it (including its own 404s), while Express's generic fallback 404
  never does, confirmed by direct comparison of the two response headers
  above and in section 5.
- **Read-only.** There are no write endpoints and no authentication. Every
  request in this document is a `GET`.
- **Curation happens in git, not over the API.** The catalog contents
  (which archives exist, their metadata, their categorization) are curated
  in the amiexpress-web git repository. This API only ever reflects what has
  already been committed there -- it has no mechanism to add, edit, or
  remove catalog entries.

- **Readable from a browser.** Every endpoint below answers with
  `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy:
  cross-origin`, so a web client on any origin may fetch and read it. This
  grants nothing a `curl` could not already do -- the catalog is public,
  read-only and unauthenticated either way; it only stops the browser
  refusing to hand the reply to its own script.

  Credentials are deliberately NOT permitted (no
  `Access-Control-Allow-Credentials`): there is no session here to carry, and
  a wildcard origin combined with credentials is invalid per the Fetch spec.
  Send no cookies and no `Authorization`.

  These response headers are listed in `Access-Control-Expose-Headers`, so
  script can read them:

  | Header                  | Why a client wants it                    |
  |-------------------------|------------------------------------------|
  | `Content-Length`        | download progress                        |
  | `X-Archive-MD5`         | digest verification (section 9)          |
  | `X-Archive-SHA256`      | digest verification (section 9)          |
  | `X-Door-Repo-Revision`  | update detection (section 7)             |

  A plain `GET` is a "simple request" and never preflights. A CONDITIONAL
  fetch does, because `If-None-Match` is not CORS-safelisted -- `OPTIONS` is
  answered with `204` and allows `If-None-Match`, `If-Modified-Since`,
  `Range` and `Content-Type`.

### Endpoints at a glance

| Method | Path                              | Purpose                                   |
|--------|------------------------------------|--------------------------------------------|
| GET    | `/api/door-repo/manifest`          | JSON manifest of the catalog (filterable)  |
| GET    | `/api/door-repo/list.txt`          | Plain-text, byte-exact index (filterable)  |
| GET    | `/api/door-repo/archive/:name`     | Download one archive by its archive name   |
| GET    | `/api/door-repo/diz/:name`         | Raw `FILE_ID.DIZ`, newlines intact         |
| GET    | `/api/door-repo/files/:name`       | What is inside the archive, + ad count     |
| GET    | `/api/door-repo/doc/:name`         | The door's own documentation, raw bytes    |
| GET    | `/api/door-repo/health`            | Lightweight liveness + door count          |

## 2. Quick start (Amiga, 68020+)

The simplest integration path for a 68K client with no JSON parser is:

1. Fetch `list.txt` over plain HTTP.
2. Parse the header line to learn the format version, revision, and door
   count.
3. Pick a row (by name, by `doorType`, or by searching descriptions).
4. Fetch the corresponding archive by `archiveName`.
5. Compute MD5 (or SHA256) over the downloaded bytes and compare against the
   value in the row you picked.

A literal AmiTCP-style `wget` fetch of the index:

```
wget http://bbs.uprough.net/api/door-repo/list.txt -O T:doorrepo.txt
```

The exact first line of a real response, captured from the running server
against the current catalog:

```
DOORREPO|1|unknown|3301
```

(The revision field reads `unknown` here because this was captured from a
local development build with no baked-in git SHA -- see section 7. A live
deployment reports its actual git commit SHA in that field instead.)

Then fetch one archive by name (using a real row from that same catalog,
`AETRIV10.LHA`, a trivia door):

```
wget http://bbs.uprough.net/api/door-repo/archive/AETRIV10.LHA -O T:AETRIV10.LHA
```

And verify it against the MD5 published for that row (`52ee1086c055fc1c82407dc0961ab04d`,
taken directly from the real `list.txt` row for this archive -- see section 3
for the full row).

## 3. `list.txt` format

`GET /api/door-repo/list.txt` -- also accepts the `?type=` and `?q=` filters
described in section 8.

This is the format intended for AmigaDOS-side clients that have no JSON
parser. It is byte-exact and deliberately simple to parse with `RANDOM` file
I/O or a plain text-file line reader.

- **Encoding:** ISO-8859-1 (Latin-1), one byte per character. The response's
  `Content-Type` header is `text/plain; charset=ISO-8859-1`.
- **Line endings:** CRLF (`\r\n`) throughout, including a trailing CRLF after
  the last data row.
- **Header line** (always the first line):

  ```
  DOORREPO|1|<revision>|<count>
  ```

  where `1` is the fixed literal format version number for this line shape,
  `<revision>` is the repo revision string (see section 7), and `<count>` is
  the number of data rows that follow.

- **Data rows** (one per door, in `archive_name` ascending order,
  case-insensitive):

  ```
  <archiveName>|<doorType>|<archiveSize>|<md5>|<name>|<description>|<author>|<releaseGroup>|<junkCount>|<hasDoc>
  ```

  Fields 7-10 were appended on 2026-08-18. Per the append-only promise
  below, the header's version number stays `1`: a client that reads only the
  first six fields is correct and unaffected, and a client that wants the
  new fields reads them by position after the sixth.

| Field         | Type                     | Notes                                                                 |
|---------------|--------------------------|------------------------------------------------------------------------|
| `archiveName` | string                   | The archive's filename, e.g. `AETRIV10.LHA`. Also the download key for section 5. |
| `doorType`    | string                   | e.g. `XIM`, `DD`, `REXX`. See section 8 for the `?type=` filter.       |
| `archiveSize` | integer                  | Archive size in bytes. `0` if unknown.                                 |
| `md5`         | string, or empty         | Lowercase hex MD5 of the archive file, recorded when the server indexed that archive (see "Digest freshness" below). Empty string when no digest has been recorded and one could not be computed on request; such a row still appears in the listing, and only the download in section 5 fails. |
| `name`        | string, possibly empty   | Door name from the catalog metadata.                                   |
| `description` | string, possibly empty   | See truncation/collapsing rules below.                                 |
| `author`      | string, possibly empty   | Author from the catalog metadata; empty when unknown (never the literal `null`). Truncated to 48 characters. One of the six fields `?q=` searches (section 8). |
| `releaseGroup`| string, possibly empty   | Release group, same rules as `author`; truncated to 32 characters. Also searched by `?q=`. |
| `junkCount`   | integer                  | How many files inside the archive are flagged as ads/junk. `0` means the archive is clean. This is the live per-file count, the same number `GET /files/<archive>` reports in its header line (section 6). |
| `hasDoc`      | `0` or `1`               | `1` when `GET /doc/<archive>` will return documentation for this door, `0` when the catalog holds none. Exactly one byte, so a C client tests it without parsing. |

`junkCount` and `hasDoc` exist so a client can decide what to OFFER before
it fetches anything. Both the reference C door and DOORMAN gate their
per-entry action keys on them: no `[V]iew doc` on a door with no
documentation, no strip/clean action on an archive with nothing to strip.
Without them a text-mode client had to issue a per-entry request to `/doc`
or `/files` just to find out whether a key was worth showing.

Field-level rules, applied identically to all five text fields
(`archiveName`, `name`, `description`, `author`, `releaseGroup`) unless
noted otherwise:

- **Pipe escaping:** any literal `|` character inside a text field is
  replaced with `!` before the row is assembled, so the pipe-delimited
  fields never get corrupted by a pipe that was part of the original text.
- **Line collapsing (all five text fields):** CR, LF, and TAB runs inside
  `archiveName`, `name`, `description`, `author`, and `releaseGroup` are
  each collapsed to a single space, so a raw newline anywhere in the source metadata can never split
  one data row into two physical lines -- which would desync the header's
  `<count>` from the real number of data lines and break a naive
  line-by-line parser. Verified against the live catalog on 2026-08-17: none
  of the 3301 current `name` or `archiveName` values contain an embedded
  CR/LF/TAB, so this rule is currently latent (it protects against future
  catalog content, not a problem seen in the corpus today).
- **Length caps: `description` 120, `author` 48, `releaseGroup` 32.**
  `archiveName` and `name` have no length cap -- the real catalog's longest `name` value observed is
  44 characters (verified directly against the live manifest on
  2026-08-17), well short of anything that would threaten line-based
  parsing once the line-collapsing rule above has already removed the only
  thing that could split a row into two lines. `description` alone is
  truncated to at most 120 characters after escaping and collapsing, since
  it is free-text (drawn from `FILE_ID.DIZ` content) with no realistic upper
  bound otherwise. `author` and `releaseGroup` are capped well above the
  real corpus maxima (28 and 7 characters, measured against the live catalog
  on 2026-08-18) purely to bound the row length against future content.
- **Bytes outside ISO-8859-1 are replaced with '?'.** Source metadata is
  stored as Unicode text and can contain characters with no ISO-8859-1
  representation (accented letters in decomposed form, stray symbols,
  emoji). Each such character becomes exactly one `?` in the output --
  never a multi-byte fallback, silent truncation, or dropped character.

Real example of the pipe-escaping and truncation rules, captured end to end
for archive `24STDCAL.LHA`. The catalog's raw description contains literal
pipe characters (it is ASCII-art box-drawing that uses `|` for vertical
lines):

```
raw description (as returned by GET /manifest, unescaped):
|NEW    ____________   ____________  BRINGS| |ORDER  \    \      \  \           \    YOU| |       /     \     /\ /    \      /\      |
```

The corresponding `list.txt` row (pipes replaced with `!`, then truncated to
120 characters -- note the row is cut off mid-description because the
description field alone exceeds 120 characters after escaping):

```
24STDCAL.LHA|XIM|62882|f44bbb901422c344fd5c2ecb4dea88fd|.------------------------------------------.|!NEW    ____________   ____________  BRINGS! !ORDER  \    \      \  \           \    YOU! !       /     \     /\ /    \ |||5|1
```

(re-captured 2026-08-18 against the ten-field row: this archive has no
recorded `author` or `releaseGroup`, so fields 7 and 8 are empty, and it
contains 5 ad files and documentation)

Real example of the `?` substitution rule, captured for archive `H26VL.LHA`.
Its catalog `name` field is Unicode text using combining diacritics (an "a"
followed by a standalone COMBINING DIAERESIS character, U+0308, twice --
this is valid Unicode but has no single-byte ISO-8859-1 representation):

```
name field from GET /manifest (Unicode, unescaped): "Cp_na<U+0308>ha<U+0308>_Du!!"
```

(shown here as `<U+0308>` for two literal COMBINING DIAERESIS characters,
to keep this document itself pure ASCII -- the real JSON response contains
the actual Unicode code point at each position, not this escape notation)

The corresponding `list.txt` row substitutes `?` for each out-of-range
character:

```
H26VL.LHA|XIM|41974|ca325b47ec3561ca892cb1c2b15ec979|Cp_na?ha?_Du!!|___/   __/___  ___/  ___/___ O\____   /    \-\____   /    \-------------O /    _/    //  /     /    //   iN 1994|Dux/Humane&Vanity||4|1
```

(also re-captured 2026-08-18: `author` is `Dux/Humane&Vanity`, no
`releaseGroup`, 4 ad files, documentation present)

### Append-only format-evolution promise

`list.txt` and the JSON manifest (section 4) will only ever grow new fields
by appending them. A client parsing `list.txt`:

- **MUST split each data row on `|` and read fields by position, ignoring
  any field it does not recognize.** A row carries at least six fields; the
  2026-08-18 revision appended four more (fields 7-10), and a later revision
  may append further ones. Existing fields never change position, meaning,
  or type, so reading only the first six is always valid.
- **MUST ignore any trailing fields it does not recognize.** A client
  written against the six-field row keeps working byte-for-byte against a
  ten-field row.
- **MUST NOT require a fixed field count.** Rejecting a row because it has
  more fields than expected is the one way to break under this promise.
- **MUST treat the header line's version number (`DOORREPO|1|...`) as the
  authority for what fields to expect.** Appending a new trailing field never
  bumps this number -- a conforming parser ignores fields it does not
  recognize, per the previous two rules. The number is bumped only when a
  field is removed or an existing field's position, meaning, or type changes
  (see section 10).

## 4. JSON manifest

`GET /api/door-repo/manifest` -- also accepts `?type=` and `?q=` (section 8).

Returns a `DoorRepoManifest` JSON object:

```json
{
  "formatVersion": 1,
  "revision": "<repo revision string>",
  "generatedAt": "<ISO 8601 timestamp>",
  "doors": [ /* array of door objects */ ]
}
```

Each entry in `doors` has this shape:

| Field          | Type             | Notes                                                          |
|----------------|------------------|------------------------------------------------------------------|
| `archiveName`  | string           | Download key for section 5.                                     |
| `doorType`     | string           | e.g. `XIM`, `DD`, `REXX`.                                        |
| `name`         | string or null   |                                                                    |
| `author`       | string or null   |                                                                    |
| `releaseGroup` | string or null   |                                                                    |
| `category`     | string or null   |                                                                    |
| `description`  | string or null   | Raw text, not escaped or truncated (unlike the `list.txt` field). |
| `fileIdDiz`    | string or null   | Raw FILE_ID.DIZ contents, if any, newlines included.             |
| `archiveSize`  | integer or null  | Bytes.                                                            |
| `md5`          | string or null   | Lowercase hex, recorded when the server indexed that archive (see "Digest freshness" below). `null` when no digest has been recorded and one could not be computed on request. |
| `sha256`       | string or null   | Lowercase hex. `null` under the same condition as `md5`.         |
| `junkCount`    | integer          | Files inside the archive flagged as ads/junk; `0` for a clean archive. Live per-file count, matching `GET /files/<archive>`'s header line. Added 2026-08-18. |
| `hasDoc`       | boolean          | `true` when `GET /doc/<archive>` will return documentation. Added 2026-08-18. |

### Digest freshness

The `md5` and `sha256` values are recorded when the server indexes an archive,
not recomputed on every request (recomputing them for the whole catalog would
stall the server). They therefore describe the archive as it was at index time.

For a client this has one practical consequence: if a checksum you compute over
a downloaded file disagrees with the digest in the listing, the cause may be a
stale server-side digest -- an archive replaced without re-indexing -- and not
a corrupted transfer. The recommended handling in section 9 still applies
(discard the file, retry once, treat a second mismatch as fatal and do not
install); a persistent mismatch on an otherwise healthy download is worth
reporting to the repo owner rather than retrying indefinitely.

Real full response, captured for one door (`AETRIV10.LHA`, filtered with
`?q=AETRIV10` for brevity -- the unfiltered response is the same shape with
3301 entries in `doors`):

```json
{
  "formatVersion": 1,
  "revision": "unknown",
  "generatedAt": "2026-08-17T10:16:09.642Z",
  "doors": [
    {
      "archiveName": "AETRIV10.LHA",
      "doorType": "XIM",
      "name": "*** /X Door Trivia ***",
      "author": null,
      "releaseGroup": null,
      "category": null,
      "description": null,
      "fileIdDiz": "*** /X Door Trivia ***\n",
      "archiveSize": 16080,
      "md5": "52ee1086c055fc1c82407dc0961ab04d",
      "sha256": "d918a826c5ea694ba2aca4a5e18f464f5947c59d85e6d1e15cc14341e805b367",
      "junkCount": 0,
      "hasDoc": true
    }
  ]
}
```

Real response headers for the unfiltered `GET /manifest` (values other than
`content-length` and `generatedAt` are stable across requests until the
catalog changes):

```
X-Door-Repo-Revision: unknown
ETag: "unknown"
Content-Type: application/json; charset=utf-8
```

### ETag / conditional GET

Every `/manifest` response carries a strong `ETag` header whose value is
exactly the repo revision, quoted: `ETag: "<revision>"`. Conditional GET
follows standard HTTP semantics (RFC 7232) in full:

**This documented ETag contract applies to `/manifest` only.** Other
endpoints (`/list.txt`, `/health`, the `404` error bodies, and any other
response produced by a plain `res.send()`) may carry an incidental,
auto-generated weak `ETag` header from the underlying web framework's
default behavior -- a content hash of that specific response body, computed
independently of the repo revision. It is not part of this API's documented
contract, is not guaranteed to be present (the successful `/archive/:name`
download in section 5, for example, currently carries none at all), and
must not be relied on for change detection or conditional requests. Use the
revision-comparison approach from section 7 for every endpoint other than
`/manifest`.

- Send `If-None-Match: "<revision>"` (or the value from a previous `ETag`
  header) on a repeat request. If the revision has not changed, the server
  responds `304 Not Modified` with an empty body.
- A weak validator (`If-None-Match: W/"<revision>"`) still matches -- this
  server's ETags are strong, but RFC 7232's weak-comparison rule for
  `If-None-Match` means a weak candidate from an intermediate cache or proxy
  is honored.
- A comma-separated list of candidates is honored: a match anywhere in the
  list triggers `304`.
- The wildcard `If-None-Match: *` always matches (any current
  representation) and triggers `304`.
- `Cache-Control: no-cache` on the request forces revalidation and returns
  `200` even when `If-None-Match` would otherwise match exactly -- this is
  the standard end-to-end-reload override (RFC 9111).

Real captured 304 response (second request, `If-None-Match` set to the ETag
from the first response):

```
status: 304
X-Door-Repo-Revision: unknown
ETag: "unknown"
body: (empty)
```

## 5. Archive download

`GET /api/door-repo/archive/:archiveName`

`:archiveName` is the exact `archiveName` value from a manifest or
`list.txt` row (e.g. `AETRIV10.LHA`). Matching is case-insensitive.

On success (`200`), the response is the raw archive bytes with these
headers:

| Header               | Meaning                                                        |
|-----------------------|------------------------------------------------------------------|
| `Content-Length`      | Exact byte count of the archive, taken from the same file handle that streams the body (no size/body mismatch is possible). **Always present on every archive response** -- this endpoint never uses chunked transfer encoding, so a client can always allocate a fixed-size buffer up front from this header rather than growing a buffer as data arrives. |
| `Content-Type`        | Always `application/octet-stream`.                               |
| `X-Archive-MD5`       | Lowercase hex MD5 of the archive bytes.                          |
| `X-Archive-SHA256`    | Lowercase hex SHA256 of the archive bytes.                       |
| `X-Door-Repo-Revision`| The repo revision, same value as `/manifest` and `/health`. Present on every `/api/door-repo/*` response, including error responses. |

Real captured headers for `GET /api/door-repo/archive/AETRIV10.LHA`:

```
status: 200
Content-Length: 16080
Content-Type: application/octet-stream
X-Archive-MD5: 52ee1086c055fc1c82407dc0961ab04d
X-Archive-SHA256: d918a826c5ea694ba2aca4a5e18f464f5947c59d85e6d1e15cc14341e805b367
X-Door-Repo-Revision: unknown
```

Note these are the exact same `md5`/`sha256` values published for this
archive in section 4's manifest entry and section 3's `list.txt` row -- all
three sources are backed by the same checksum computation.

### 404: unknown or unavailable archive

If `:archiveName` does not match any catalog entry, or the catalog entry
exists but its archive file is not currently present/readable on the
server, the response is `404` with a plain-text body:

```
NOT FOUND: <archiveName>\r\n
```

Real captured example for a nonexistent archive name:

```
status: 404
Content-Type: text/plain; charset=utf-8
body: "NOT FOUND: DOES_NOT_EXIST_XYZ.LHA\r\n"
```

A malformed or path-traversal-shaped `:archiveName` (e.g. a URL-encoded
`../../etc/passwd`) behaves identically: it simply fails to match any
catalog entry and 404s the same way, with the same body shape. The archive
name is never used to build a filesystem path directly -- it is only ever
used as a lookup key into the catalog, and the catalog's own stored path is
what gets opened.

### Archive-name characters, encoding, and quoting

Real catalog `archiveName` values are drawn from decades of Amiga filenames
and are not limited to letters, digits, and `.`/`-`/`_`. A scan of the real
catalog (3301 rows) found these additional characters in real archive
names: `!`, `$`, `&`, `^`, `~`. For example (all real, current rows):
`BR&IB20.LHA`, `C&N-CS13.LHA`, `H&V-CL20.LHA` (13 rows contain `&`), and
`5D^AMU20.LHA`, `5D^DC007.LZH` (105 rows contain `^`).

- **No percent-encoding is required to put any of these characters in the
  URL path segment.** Per RFC 3986, a path segment (`pchar`) may contain any
  "unreserved" character (letters, digits, `-`, `.`, `_`, `~`) or "sub-delim"
  character unencoded, and sub-delims include `!`, `$`, and `&`. `^` is
  technically outside both of those sets in the strict grammar, but this
  server accepts it unencoded in practice (verified below) -- if a client's
  own HTTP library or URL builder insists on strict RFC 3986 conformance and
  refuses to send `^` unencoded, percent-encode it as `%5E` (see below; the
  server accepts both forms identically).
- **Percent-encoding is always accepted too**, for any client whose HTTP
  library encodes reserved-looking characters automatically or as a matter
  of policy. `&` as `%26`, `^` as `%5E`, `!` as `%21`, `$` as `%24`, `~` as
  `%7E` (though `~` never needs it) all resolve to the same catalog row as
  the unencoded form.
- **Lookup is case-insensitive** (already noted above): `br&ib20.lha`
  matches the same row as `BR&IB20.LHA`.
- **Shell quoting is a separate, more common trap than URL encoding.** In a
  Unix-like shell (and in AmigaDOS scripts using certain command
  interpreters), an unquoted `&` backgrounds the preceding command instead
  of being passed through as a literal character in the URL -- this breaks
  the naive `wget url -O file` form from section 2 for any archive name
  containing `&`. Always quote the full URL in shell commands.

Real verification, captured against the live local server for a real
archive name containing `&` (`BR&IB20.LHA`, real md5
`dd34a36330090277a50f0966bbc59ffc`) and one containing `^`
(`5D^AMU20.LHA`, real md5 `bbb870130cb379b737c08209b99976ca`) -- all four
requests below returned `200` with the expected `X-Archive-MD5`:

```
GET /api/door-repo/archive/BR&IB20.LHA              (unencoded)     -> 200, md5 dd34a36330090277a50f0966bbc59ffc
GET /api/door-repo/archive/BR%26IB20.LHA             (percent-encoded) -> 200, md5 dd34a36330090277a50f0966bbc59ffc
GET /api/door-repo/archive/br&ib20.lha               (lowercase)     -> 200, md5 dd34a36330090277a50f0966bbc59ffc
GET /api/door-repo/archive/5D^AMU20.LHA              (unencoded)     -> 200, md5 bbb870130cb379b737c08209b99976ca
GET /api/door-repo/archive/5D%5EAMU20.LHA            (percent-encoded) -> 200, md5 bbb870130cb379b737c08209b99976ca
```

A correctly quoted shell example for an `&`-bearing archive name (note the
double quotes around the URL, required so the shell does not interpret `&`
as a background-job operator):

```
wget "http://bbs.uprough.net/api/door-repo/archive/BR&IB20.LHA" -O T:BRandIB20.LHA
```

## 5b. `FILE_ID.DIZ` and archive contents

Both endpoints were added after the first release of this document. They are
**additive**: nothing above changed, so a client written against the earlier
version keeps working untouched.

### `GET /api/door-repo/diz/<archiveName>`

The entry's `FILE_ID.DIZ` exactly as it appears in the archive — **newlines
preserved**. `Content-Type: text/plain; charset=ISO-8859-1`.

This exists because `list.txt` cannot carry it. That format is one row per
line, so it collapses every newline to a space (see "Newline collapsing"
above) — which is correct for a tabular format but destroys multi-line DIZ
art before any client sees it. The art also survives in `/manifest`'s
`fileIdDiz`, but the manifest is a multi-megabyte JSON document; a door on a
real Amiga can neither parse nor hold it. This endpoint is a few hundred
bytes and needs no parser at all.

Render it **line for line, without re-wrapping**. The art only means anything
if its own line breaks and column alignment are preserved; clip lines that
are wider than your display rather than flowing them onto the next row.

`404` when the archive is unknown **or** has no DIZ — the two are deliberately
not distinguished, and an empty `200` is never returned, so "no art" is a
single case to handle.

```
GET /api/door-repo/diz/-D-DOR11.LHA HTTP/1.0

______    ________.  /\    ______.__________
\____ \/\/  _  /  |_/\/\/\/ ___/ |  \  __  /
|:  /   //    /\  | \_ \\  /  \     \\/  \/
|______/_______/_____/___\____/__|___/____\
+-------------(bRinGs  ToDaY)-----------mk-+
      dOOR-mENU v.1.1 by vASCAL/dLT
```

### `GET /api/door-repo/files/<archiveName>`

What is inside the archive, and how much of it is advertising. Same charset
and CRLF line endings as `list.txt`, so one reader serves both.

```
FILES|<totalFiles>|<junkFiles>
<sizeBytes>|<isJunk 0|1>|<path>
...
```

`isJunk` marks a file the repo has identified as an ad/BBS stamp rather than
part of the door — the same classification the owner's own tooling uses. A
client can show it (this repo's own doors flag those rows) or ignore it.

Paths are sorted ascending. Any `|` inside a path is replaced with `!`, the
same escaping rule `list.txt` uses, so the three fields can never be split
incorrectly. An entry with no indexed contents returns `200` with
`FILES|0|0`, not a 404; an unknown archive returns `404`.

```
FILES|15|2
61|0|Children
50|0|FILE_ID.DIZ
2|1|LE-window5.exe
```

### `GET /api/door-repo/doc/<archiveName>`

The door's own documentation, exactly as it sits in the archive. 3216 of the
3301 catalogued doors have one.

Served as **raw bytes with no transformation**, `Content-Type: text/plain;
charset=ISO-8859-1`. Amiga door docs are Latin-1 and routinely contain form
feeds, ANSI art and other control bytes; anything that "cleaned them up"
would destroy what the reader is trying to look at. Render it the same way
you would a text file on the Amiga: line for line, clipped rather than
re-wrapped.

The source filename travels in an `X-Doc-Filename` response header rather
than the body, so the body stays byte-exact.

`404` when the archive is unknown or has no doc.

## 6. Health check

`GET /api/door-repo/health`

A lightweight liveness endpoint. Unlike `/manifest`, it does not compute or
touch archive checksums -- it only counts catalog rows -- so it is safe to
poll frequently (e.g. from a monitoring script) without triggering a
re-hash of the whole archive corpus.

Real captured response:

```
status: 200
X-Door-Repo-Revision: unknown
Content-Type: application/json; charset=utf-8

{
  "status": "ok",
  "revision": "unknown",
  "doors": 3301
}
```

| Field      | Type    | Notes                                                         |
|------------|---------|-----------------------------------------------------------------|
| `status`   | string  | Always the literal `"ok"` when the endpoint responds at all.    |
| `revision` | string  | Same value as `X-Door-Repo-Revision` and `/manifest`'s `revision` field. See section 7. |
| `doors`    | integer | Total row count in the catalog, ignoring any filters (this endpoint takes no `?type=`/`?q=` parameters). |

`revision` reads `"unknown"` here for the same local-development reason
given throughout this document -- see section 7.

## 7. Update detection

Every `/api/door-repo/*` response carries an `X-Door-Repo-Revision` header,
and `/health` and `/manifest` both surface the same value in their JSON
bodies (`revision`). This value changes exactly when the deployed catalog
changes (it is the deployed image's git commit SHA in a live deployment; see
the caveat below for local development).

Two ways to detect that the catalog has changed since you last fetched it:

1. **Plain-text / header-based clients:** remember the `<revision>` field
   from the `list.txt` header line (or the `X-Door-Repo-Revision` header on
   any response) and compare it to the value on your next fetch. A changed
   value means the catalog changed; re-fetch `list.txt` (or `/manifest`) in
   full.
2. **JSON / HTTP-aware clients:** use conditional GET against `/manifest` as
   described in section 4 -- send `If-None-Match` with the last-seen `ETag`
   and treat a `304` as "no change, nothing to re-fetch."

Local development caveat: the revision string is read from a file
(`/app/.git-sha`) written into the server's container image at build time.
A local development server with no such file falls back to the literal
string `"unknown"` -- which is what every example in this document shows,
since they were all captured from a local run. A live deployment always
reports its real git commit SHA in this field instead.

## 8. Filters

Both `GET /manifest` and `GET /list.txt` accept the same two optional query
parameters, and they compose (both may be given together):

| Parameter | Behavior                                                                                   |
|-----------|-----------------------------------------------------------------------------------------------|
| `?type=`  | Exact, case-sensitive match against `doorType` (e.g. `XIM`, `DD`, `REXX`).                    |
| `?q=`     | Case-insensitive substring match against `archiveName`, `name`, `author`, `releaseGroup`, and `description`. Matches if the substring appears in *any* of those fields. **Does not** search `installed_as` (the BBS's per-node install-target column) -- this server's schema has no such column, since it describes one node's local installation rather than anything in the shared catalog. |

Real example: `GET /api/door-repo/manifest?type=DD` against the live
catalog returned 10 doors; one of them (picked here for a clean,
human-readable `name` field -- the actual first row in `archiveName` order
is a different, ASCII-art-named entry):

```json
{
  "archiveName": "AVH-BC01.LHA",
  "doorType": "DD",
  "name": "AVH-BaudCheck v0.1",
  "author": null,
  "releaseGroup": "AVH",
  "category": "DD-Reference",
  "archiveSize": 9256,
  "md5": "d184a28e733083b9de6b2f9352065abc",
  "sha256": "d219ce1b071797e47a13725eb498b946d12647b61eb67e9e9c49ecd1a4f5624a",
  "junkCount": 4,
  "hasDoc": true
}
```

(`description` and `fileIdDiz` omitted above for brevity -- they are present
in the real response and are ASCII-art banner text, unrelated to the filter
demonstration.)

Real example: `GET /api/door-repo/list.txt?type=DD` against the same
catalog produced the header line:

```
DOORREPO|1|unknown|10
```

Real example: `GET /api/door-repo/manifest?q=trivia` matched exactly one
door, `AETRIV10.LHA` (the same door used throughout sections 2-5) -- `q`
matched because the substring `trivia` appears in its `name` field
(`*** /X Door Trivia ***`).

## 9. Checksum verification walkthrough

Every archive is published with both an MD5 and a SHA256 checksum, computed
over the exact bytes of the archive file. **MD5 is the minimum a client
should verify** -- it is fast to compute even on 68K hardware and is
sufficient to catch a truncated or corrupted download. **SHA256 is also
available** for any client or workflow that wants stronger integrity
verification.

Steps:

1. Fetch the archive's row from `list.txt` (or its entry from `/manifest`)
   and note its `md5` field. **`list.txt` carries no `sha256` field** -- a
   64-character digest on every row would grow the catalog every client
   downloads by roughly a third, for a value only a downloading client
   needs. Get SHA256 either from `/manifest`, or -- the cheaper route for a
   text-mode client -- from the `X-Archive-SHA256` response header that
   `GET /archive/<archiveName>` sends with the bytes themselves (section 5).
2. Fetch `GET /api/door-repo/archive/<archiveName>`.
3. Compute MD5 (and/or SHA256) over the full response body.
4. Compare against the value from step 1. They must match exactly
   (lowercase hex, both sides).

**On a mismatch: discard the downloaded file and retry the download once.**
A single mismatch is most often a transient transfer error (a dropped or
corrupted TCP segment on a lossy link), not a corrupted archive on the
server -- re-fetching usually resolves it. **If the retry also mismatches,
treat that as fatal: do not install or execute the archive.** A second
consecutive mismatch against the same catalog-row checksum points at either
a genuinely corrupted archive on the server or a systematic
transfer/storage problem on the client side, and installing an unverified
archive on a BBS is not a risk worth taking either way.

As a cross-check, the archive download response also carries the same
checksums as response headers (`X-Archive-MD5`, `X-Archive-SHA256`; section
5), computed independently at download time from the same file. If a
client's locally computed checksum, the catalog-row checksum, and the
download's response-header checksum ever disagree, that indicates either a
corrupted download in transit or a stale/inconsistent catalog entry on the
server -- worth reporting either way.

For the worked example used throughout this document (`AETRIV10.LHA`):
catalog-row `md5` = `52ee1086c055fc1c82407dc0961ab04d`, and the same value
was independently returned in the `X-Archive-MD5` header on the actual
archive download in section 5. Both were captured from the same live run of
the real server, confirming they agree in practice, not just in
specification.

## 10. Stability promise

- **`formatVersion`** (in the JSON manifest) and the leading version number
  in the `list.txt` header line (`DOORREPO|1|...`) are bumped only when the
  format changes in a way a naive parser could not safely ignore. As of this
  writing, both are `1`.
- **Fields are append-only.** New fields may be added -- to the end of each
  `list.txt` data row, or as new keys in each JSON door object -- without a
  version bump, as long as existing fields keep their position, name,
  meaning, and type. A conforming parser MUST ignore trailing fields (or
  unrecognized JSON keys) it does not know about, exactly as instructed in
  section 3.
- **No field is ever removed or repurposed without a major version bump.**
  Removing a field, changing what an existing field means, or changing an
  existing field's type is a breaking change and will always come with an
  incremented `formatVersion` / header version number, announced ahead of
  the change taking effect on the live API.
- **Endpoint paths and HTTP semantics (status codes, header names, the
  read-only nature of the API) are considered stable** and are not expected
  to change independent of a documented, versioned format change.
