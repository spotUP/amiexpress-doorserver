---
date: 2026-08-23
topic: Split the door repository out of amiexpress-web into a standalone door server
tags: [door-repo, doorserver, architecture, catalog, doorman, doorrepo-c, deployment]
status: final
---

# Door server split - design

## Problem

The door repository is a service that happens to live inside a BBS. Its API
(`/api/door-repo/*`), its catalog (3301 entries, 58406 archive-file rows), its
174 MB archive corpus and its curation tooling all sit inside amiexpress-web
and are mounted only when that one process runs with `DOOR_REPO_ROLE=owner`.

Four consequences, all of them the reason for this work:

1. **Other BBSes depend on the wrong thing.** A sysop pointing DOORREPO or
   DOORMAN at the repo is depending on this BBS being up, on this BBS's
   deploy schedule, and on this BBS's release quality.
2. **Deploys are coupled.** Editing repo code redeploys the BBS; editing BBS
   code invalidates nothing about the catalog but rebuilds the image anyway.
   An archive stream and a user session share a process and an event loop.
3. **Data ownership is muddled.** `door_catalog` lives in the BBS database
   next to users and messages, and carries `installed` / `installed_as` /
   `install_dir` columns that describe THIS node - a per-node fact stored in
   what is supposed to be a shared catalog.
4. **Weight.** ~1000 lines of repo routes/manifest/CORS plus the whole
   `dev/scripts/door-corpus/` toolchain sit in the BBS tree.

## What is being built

A new git repository, `amiexpress-doorserver`: a small Express + better-sqlite3
service that owns the catalog, the archive corpus, the curation API and the
corpus tooling. amiexpress-web keeps the two clients (DOORMAN, the DoorRepo C
door), a record of what this node installed, and a proxy so nothing already
deployed breaks.

**The read API does not change in this work.** Location changes; behaviour does
not. That is the entire safety argument: two live clients exist, one of them
(`doorrepo.amiga`) is a 68K binary shipped to other people's machines.

## Non-goals

- Fixing the live download corruption. It travels with the archive route. The
  split isolates it in a server that does nothing else, which makes it easier
  to find; it does not fix it.
- Serving archives from Caddy's `file_server` instead of Node. A real
  improvement, deliberately deferred: reproducing `x-archive-md5`, the
  `HEAD`/`Range` behaviour and the catalog-name to file mapping in Caddy would
  split one contract across two implementations, and the live Caddyfile is not
  in version control.
- LZX extraction, DOORMAN feature parity, authentication for reads, rate
  limiting (rejected for this project generally).
- Any redesign of the manifest or `list.txt` formats.

## Architecture

```
                      amiexpress-doorserver (new repo, own container)
                      +--------------------------------------------+
   DoorRepo C door -->| GET  /manifest /list.txt /diz /doc /files   |
   (RepoHost=...)     |      /archive /health        (public)       |
                      | POST /admin/*                (Bearer key)   |
   DOORMAN consumer ->|                                             |
                      | doors.db: door_catalog, door_catalog_files  |
                      | Archives/: ~174 MB corpus                   |
                      +--------------------------------------------+
                                       ^
                                       | HTTP (DOOR_SERVER_URL)
                                       |
   legacy clients --> amiexpress-web /api/door-repo/*  (thin proxy)
                      bbs db: door_installs (this node only)
                      DOORMAN owner screens -> admin API
```

### Component 1: the door server

- **Runtime.** Node + Express + better-sqlite3, one process, no BBS imports.
- **State.** One sqlite file (`doors.db`) and one archives root, both from
  config (`DOORSERVER_DB`, `DOOR_ARCHIVES_ROOT`). No filesystem assumption
  inherited from the BBS layout - the current `resolveArchiveRoot()` fallback
  chain (`DOOR_ARCHIVES_ROOT` -> `<BBS_DATA_DIR>/Archives` -> a hardcoded
  `/Users/spot/...` dev path) collapses to: configured value, or fail loudly
  at startup.
- **Read endpoints**, carried over verbatim from
  `web/backend/src/server/door-repo.routes.ts`:

  | Endpoint | Behaviour that must not change |
  |---|---|
  | `GET /manifest` | JSON; `ETag: "<revision>"`; 304 via Express `req.fresh` computed BEFORE `buildManifest()`; `?type=` and `?q=` filters |
  | `GET /list.txt` | ISO-8859-1, CRLF, revision-keyed cache |
  | `GET /diz/<archive>` | raw `file_id_diz` as Latin-1 bytes |
  | `GET /doc/<archive>` | raw `doc_raw`, no transformation (control bytes, ANSI, form feeds) |
  | `GET /files/<archive>` | `FILES\|<count>\|<junk>` header then `<size>\|<isJunk>\|<path>`, CRLF, Latin-1, `\|` in paths escaped to `!` |
  | `GET /archive/<archive>` | single `fs.openSync` for both `Content-Length` and body (TOCTOU rule), `stream.pipeline`, `x-archive-md5` / sha256 headers from the mtime+size cache |
  | `GET /health` | `{ status, revision, doors }` using `getDoorCount()`, never `buildManifest()` |

  Every response keeps `X-Door-Repo-Revision`. The revision stays the catalog
  fingerprint `c<count>-t<max(indexed_at)>`, never the git SHA - a deploy must
  not invalidate a good client cache, and a dev server with no `/app/.git-sha`
  must still report an honest revision.

  Archive-name resolution keeps `candidateArchiveNames()` (the catch-all router
  tries spelling variants and prefers one that exists in the catalog).

- **Admin endpoints**, new, all requiring `Authorization: Bearer <key>`:

  | Endpoint | Replaces |
  |---|---|
  | `POST /admin/entries` | `upsertCatalogEntry()` |
  | `DELETE /admin/entries/:id` | `deleteCatalogEntry()` |
  | `POST /admin/entries/:id/strip` | `canStripArchiveOnServer()` + `stripArchiveOnServer()` |
  | `PATCH /admin/entries/:id/junk-count` | `updateJunkCount()` |
  | `PUT /admin/entries/:id/files` | `upsertArchiveFiles()` |
  | `DELETE /admin/entries/:id/files` | `removeArchiveFiles()` |
  | `POST /admin/reindex` | corpus builder entry point |

  `markInstalled()` / `markUninstalled()` have NO admin equivalent: they are
  per-node facts and move to the BBS (see Component 2). The `installed`,
  `installed_as` and `install_dir` columns are dropped from the server's
  catalog table.

- **Auth.** Keys come from config (`DOORSERVER_ADMIN_KEYS`, comma separated,
  one per curator, each with a label for the audit line). If no key is
  configured the admin router refuses every request rather than mounting open.
  Reads are anonymous. Constant-time compare. Each accepted write logs
  `<key-label> <action> <entry-id>`.

- **Curation tooling.** `dev/scripts/door-corpus/*` moves into the server repo
  as its CLI (`npm run catalog:build`, `catalog:retype`, `catalog:match`,
  and the junk-fingerprint / scene-strip data files). It talks to `doors.db`
  directly on the server host - the admin API exists for remote clients, not
  for the batch builders.

### Component 2: what amiexpress-web keeps

- **`door_installs`** - one table describing this node only:

  ```sql
  CREATE TABLE door_installs (
    id              TEXT PRIMARY KEY,
    catalog_id      TEXT,
    archive_name    TEXT NOT NULL,
    command         TEXT NOT NULL UNIQUE,
    install_dir     TEXT NOT NULL,
    door_type       TEXT,
    name            TEXT,
    md5             TEXT,
    installed_at    INTEGER NOT NULL,
    source_url      TEXT,
    source_revision TEXT
  );
  CREATE INDEX idx_door_installs_archive ON door_installs(archive_name);
  ```

  `catalog_id` is the remote row id and is allowed to go stale (the server may
  delete or re-index a row); `archive_name` is the durable join key for
  "is this catalog row installed here". `source_url` + `source_revision`
  record which repo and which catalog revision it came from.

  This replaces a workaround rather than adding a concept: DOORMAN's consumer
  mode already synthesizes a local catalog row on install
  (`Doors/door-manager/app.ts:474`) purely so `markInstalled()` has something
  to write to.

- **The proxy.** `/api/door-repo/*` forwards to `DOOR_SERVER_URL`, preserving
  method, path, query, `If-None-Match`, `Range`, and streaming the body
  through without buffering. Response `X-Door-Repo-Revision`, `ETag`,
  `Content-Type`, `Content-Length`, `x-archive-md5`, `x-archive-sha256` and
  status (including 304 and 404 bodies) pass through unchanged.
  `door-repo-cors.ts` stays in front of it - the CORP policy per path is
  still the BBS's answer for requests arriving at the BBS host.

  If `DOOR_SERVER_URL` is unset the path 404s exactly as it does today when
  `DOOR_REPO_ROLE` is not `owner`. `DOOR_REPO_ROLE` loses its "serve the API"
  meaning; it keeps its client meaning inside `resolveDoorRepoMode()`.

  The sqlite-backed handlers are DELETED, not left as a fallback. Two
  implementations of one contract is how the duplicated
  `Cross-Origin-Resource-Policy` header happened.

- **DOORMAN.** The owner-mode screens stay. Their dependency object
  (`svc?.upsertCatalogEntry` / `deleteCatalogEntry` / `stripArchiveOnServer` /
  `updateJunkCount` / `removeArchiveFiles`, `app.ts:1296-1855`) gains a second
  implementation backed by the admin API, selected in
  `Doors/door-manager/repoDataSource.ts` - already the one place that reads
  `DOOR_REPO_ROLE` / `DOOR_REPO_URL`. Consumer mode is untouched. Owner mode
  additionally needs an admin key (`DOOR_REPO_ADMIN_KEY`); without one, the
  curation footer keys are hidden rather than failing on use.

- **The DoorRepo C door.** No change. Same paths, same `RepoHost=` config, same
  binary. Whether it points at the BBS host (proxy) or the new host (direct) is
  a one-line config choice for whoever runs it.

### Component 3: the shared contract

`docs/DOOR-REPO-API.md` moves to the server repo and stays the human contract.
The machine contract is the manifest type: today
`Doors/door-manager/repo-types.generated.ts` is generated from
`web/backend/src/doors/door-repo-manifest.ts` by `scripts/gen-repo-types.ts`,
with `repo-types-generated-staleness.test.ts` failing the build when they
drift.

After the split the generator lives in the server repo and emits a
`contract/` module; amiexpress-web keeps its committed generated mirror. The
staleness test splits in two: the server repo asserts its own generated file
matches its source, and amiexpress-web asserts its vendored copy matches the
contract version it declares (a `contractVersion` string in the generated
header, echoed by `/health`). A client whose contract version is older than
the server's minimum is told so by `/health`, not by a parse failure.

## Data flow

**Browse (consumer).** DOORMAN/DoorRepo -> `GET /list.txt` or `/manifest`
(with `If-None-Match`) -> server reads `doors.db` -> client merges local
`door_installs` rows to mark what is installed here.

**Install.** Client `GET /files/<archive>` (pick program, plan junk deletion)
-> `GET /archive/<archive>` -> extract -> write `Commands/BBSCmd/<CMD>.info`
-> BBSCmd freshness signal makes the command live without a reconnect.

Who records the install differs by client, and this is deliberate:
DOORMAN runs inside the backend and writes the `door_installs` row itself.
The DoorRepo C door has no database access at all - it keeps its own
`install index` text file in `DownloadDir` (`flow.h`'s install index) and the
BBS learns about the door only from the `.info` it wrote. So `door_installs`
is DOORMAN's record, not a complete inventory, exactly as `door_catalog`'s
`installed` column is today. Reconciling the two is out of scope here; the
existing `match-installed-doors` tooling is what fills the gap.

**Curate.** DOORMAN owner screen -> `POST /admin/...` with the Bearer key ->
server writes `doors.db` and (for strip) rewrites the archive on disk ->
`indexed_at` changes -> revision changes -> every client's next conditional
GET returns 200 instead of 304.

## Error handling

- **Server unreachable.** Read paths surface "repo unavailable" to the client;
  they do not fall back to stale data (there is none by design - "install
  state only" was the chosen data split). The C door already handles a failed
  fetch; DOORMAN's consumer mode already has a `FetchManifestResult` error
  shape.
- **Proxy failure.** 502 with a plain-text body in the same
  `NOT FOUND: <name>\r\n` register the API already uses for 404, so a C client
  parsing text sees something predictable.
- **Admin auth failure.** 401, no detail, logged with the source address.
- **Missing archive file on disk with a catalog row present.** Unchanged from
  today: 404 through `sendNotFound`, and the mismatch is a curation bug the
  reindex CLI reports.
- **Startup with no DB or no archives root.** Fail loudly and exit; do not
  silently serve an empty catalog. An empty catalog would publish a valid
  revision and poison every client's cache.

## Testing

**Parity harness first, and it is the gate.** Before any data moves: capture
responses from the current BBS-served API for a fixed sample (an entry with a
doc, one without, one with junk files, one with a `|` in a path, a Latin-1
heavy diz, a large archive, a nonexistent name), then assert the new server
returns identical status, headers and bytes - including `If-None-Match` 304,
`HEAD`, and a `Range` request. The sample is committed as fixtures so the
harness runs in CI with no live server.

Suites that move to the server repo, unchanged where possible:
`web/backend/tests/api/door-repo-routes.test.ts`,
`tests/doors/strip-archive-on-server.test.ts`,
`tests/doors/delete-catalog-entry.test.ts`,
`tests/doors/resolve-archive-path.test.ts`, plus the manifest/list.txt/
checksum suites.

Suites that stay in amiexpress-web:
`tests/doors/doorman-repo-e2e.test.ts` and the consumer-mode suites (they
exercise the client), plus new ones: proxy pass-through (headers, 304, Range,
502), `door_installs` read/write, and DOORMAN's admin-API client.

New tests, each written to fail first: proxy preserves `x-archive-md5`; proxy
returns 404 when `DOOR_SERVER_URL` is unset; admin route refuses when no key
is configured; admin route refuses a wrong key; owner-mode DOORMAN hides
curation keys without a key.

## Deployment

Second container on the existing Hetzner host:

- Image built from the new repo, its own `deploy-doorserver.yml` with the same
  serialized-`concurrency` shape as `deploy-hetzner.yml`.
- Volume `doorserver-data` holding `doors.db` and `Archives/`.
- Caddy vhost `doors.<domain>` -> container port; the BBS keeps
  `/api/door-repo/*` as the proxy path.
- **Disk.** The host sits near 80% and the corpus is ~174 MB. Archives MOVE to
  the new volume; they are not duplicated. `docker builder prune -f` before
  the first build, as with every deploy here.
- Health: `GET /health` for the container healthcheck, matching the BBS's
  existing `curl -f http://localhost:<port>/health` pattern.
- Verification after deploy follows the project rule that a green workflow can
  lie: check the container's image build time and the reported revision, not
  just the workflow status.

## Migration and cutover

Ordered, each step independently revertible:

1. **Stand up the server repo.** Skeleton, contract module, read routes ported,
   suites moved. Green against a COPY of `database.sqlite`.
2. **Parity harness passes** against that copy. No data has moved yet.
3. **Migrate data.** `ATTACH` the BBS database and
   `INSERT INTO door_catalog SELECT ...` / `door_catalog_files` into
   `doors.db` - never a SQL text dump, because `doc_raw` carries control
   bytes. Drop `installed` / `installed_as` / `install_dir` on the way in.
   Move the archives to the new volume.
4. **Deploy the server**, verify `/health` and a real archive GET with its
   checksum header over HTTPS.
5. **BBS switches to the proxy.** Old handlers deleted, `DOOR_SERVER_URL` set.
   Verify with the C door end to end (browse, doc, install).
6. **`door_installs` lands** in the BBS, backfilled from the existing
   `door_catalog` rows where `installed = 1`.
7. **DOORMAN owner mode switches** to the admin API.
8. **Drop `door_catalog` / `door_catalog_files` from the BBS database** - last,
   after a live confirmation, and after a database backup.

Rollback before step 8 is: unset `DOOR_SERVER_URL`, restore the deleted
handlers from git, and the BBS serves the catalog it still has.

## Open risks

- **The download corruption moves with the archive route.** `-D-CALC.LHA`
  produced the same wrong digest twice and `-J-LCV30.LHA` two different ones -
  a race, still unexplained, `KeepFailedDownloads=yes` armed. After the split
  it will be reproducible in a process that serves nothing else.
- **`HEAD` / `Range` behaviour on `/archive/` is known to be inconsistent**
  with GET today. The parity harness captures current behaviour, including the
  inconsistency; fixing it is separate work, and doing it during the move would
  destroy the parity argument.
- **Three doorrepo commits are unpushed** (`5273075ed`, `614631462`,
  `05f82761d`) and one docs commit (`d67fc7837`). They should land before the
  tree starts moving.
