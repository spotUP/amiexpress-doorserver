# Releases API

> Served by the `amiexpress-doorserver` repository as a third surface beside the
> door repo and the achievements API. It is not proxied by any BBS.

A read-only HTTP API over the AquaScan BBS file listing (all release types,
1988–2026, 299,437 entries). No archives live here — only the listing:
filename, flag, size (or nuke reason), date, and what the extractor read out
of each entry's description block.

## Base

- `https://doors.uprough.net/releases/v1` (and plain HTTP, same paths)

Every response carries `X-Releases-Contract` (currently `1`) and
`X-Releases-Revision` (`r<count>-t<max-id>`), errors included. CORS is open
(`Access-Control-Allow-Origin: *`, no credentials), like the door repo.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{status, contractVersion, revision, files}` |
| GET | `/list` | paged rows with filters (below) |
| GET | `/list.txt` | first 500 rows in house text format (Latin-1, CRLF) |
| GET | `/dump` | every matching row as NDJSON, slim columns, resumable (below) |
| GET | `/files/:id` | one full row incl. `rawDesc`, or 404 `{error:"not_found"}` |

### Bot recipe (full pull + stay current)

No auth. Poll `GET /health` and compare `revision`; when it moves:

1. Full pull: `GET /dump` — one JSON object per line, slim columns (no art
   block). For the art too, add `?fields=` naming `rawDesc`, or fetch
   `/files/:id` per row.
2. Broken pull: resume with `?since=<last id seen>` (add `?limit=` to chunk).
3. Stay current: `GET /list?since=<last id seen>` — ascending ids only.
4. A mid-stream failure cannot become a status code on `/dump`; a short
   stream (fewer lines than `X-Releases-Total`) means resume with `?since=`.

`GET /list` query: `q` (filename + description substring), `flag` (`N`/`P`/`D`/…),
`dir` (dir number), `from`/`to` (`YYYY-MM-DD` on the entry date), `order`
(`asc`/`desc` by id), `limit` (default 100, max 500), `offset`,
`since` (only `id` greater than this — forces ascending order, ignores offset),
`fields` (comma list of row keys; unknown names ignored, `id` always kept).
Answers `{contractVersion, revision, total, offset, limit, rows[]}`.

`GET /list.txt` takes the same filters and answers:

```
RELEASE|1|<revision>|<count>
<id>|<filename>|<flag>|<sizeBytes>|<dateIso>|<description>
```

Pipe → `!`, one row per line, description capped at 120 chars, append-only
field promise identical to `list.txt`.

## Field notes

- `flag` is stored as listed. `D` means nuked/deleted — then `sizeBytes` is
  null and `sizeNote` holds the reason (`>NUKED<`, `DELETED`, `RENAMED`,
  `>>OLD<<`, …). `N`/`P` meanings are unconfirmed and stored raw.
- `dateIso` is the entry-line date (`MM-DD-YY`, pivot YY≥80 → 19YY).
- `dlCount` (`d/L tIMES:`) exists on newer entries only; `uploader`
  (`Name >>note<<` trailer) is best-effort. A `DL's: NN` stamp burned into
  art lines at a fixed column is stripped (columns restored) and counted
  when no `d/L` line exists.
- `description`/`version`/`author` come from `contract/describe.ts` over the
  entry's description lines — the same extractor as doors, so fixes land here too.
- `rawDesc` (on `/files/:id` only, not the list) is the description block verbatim,
  art included — the file_id equivalent. The web UI renders it as-is.

## Configuration

`RELEASES_DB` — path to `releases.db` (directory must exist; file is created).
Unset = surface off, door repo unaffected. Populated offline:

```
npx tsx scripts/import-bbs-filelist.ts --db <releases.db> --file <list.txt>
```

Re-runs upsert on `(dir_no, file_no, filename)` — dir 66 was captured twice
with different files reusing numbers, so the key includes the filename.
