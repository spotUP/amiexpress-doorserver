# amiexpress-doorserver

The AmiExpress door repository, as a standalone service: catalog, archive
corpus, curation API.

Split out of amiexpress-web (design:
`docs/superpowers/specs/2026-08-23-door-server-split-design.md`) so other
BBSes can depend on the repository without depending on one BBS's uptime,
deploy schedule or database.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `DOORSERVER_DB` | yes | path to `doors.db` |
| `DOOR_ARCHIVES_ROOT` | yes | directory holding the archive corpus |
| `PORT` | no | listen port, default 3010 |
| `DOORSERVER_ADMIN_KEYS` | no | `label:key,label:key` - curation keys (phase 3) |

Missing or non-existent paths are a startup failure, never a default.

`express` is pinned to an exact version (`5.1.0`, no `^`) rather than a
range. The BBS runs 5.1.0 and Express itself owns response bytes a later
task's parity harness compares byte-for-byte against BBS captures (e.g. the
HTML 404 page's `Content-Length` on an unmatched route) - a range bump that
silently picks up a patch release would drift that comparison out from
under the harness with no code change to point at. Lift the pin
deliberately (bump the version, re-run the parity harness, note why in the
commit), not via a routine `npm update`.

## Commands

| Task | Command |
|---|---|
| dev server | `npm run dev` |
| build | `npm run build` |
| type-check | `npm run typecheck` |
| test | `npm test` |
| test (CI) | `npm run test:ci` |
| parity vs the BBS | `npm run test:parity` |

`npm run test:parity` compares this server byte-for-byte against fixtures
captured from the BBS-hosted door-repo API (`tests/fixtures/parity/`, see
`tests/parity.test.ts`). It needs `PARITY_DB` (a copy of the BBS's
`database.sqlite`) and `PARITY_ARCHIVES` (the archive corpus directory) -
`test:parity` defaults them to the paths used to capture the committed
fixtures, but they can be overridden. **The suite SKIPS itself, rather than
failing, when those two are unset** - which is also true of a plain `npm
test`/`npm run test:ci`. A skipped parity run is not a passing one; run
`npm run test:parity` explicitly whenever `src/` changes anything the
BBS-hosted API also serves.
