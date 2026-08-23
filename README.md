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

## Commands

| Task | Command |
|---|---|
| dev server | `npm run dev` |
| build | `npm run build` |
| type-check | `npm run typecheck` |
| test | `npm test` |
| test (CI) | `npm run test:ci` |
