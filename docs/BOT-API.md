# Bot API — Up Rough Door Repository + BBS file listing

> Integration brief for an agent implementing chat bots. Two read-only JSON
> surfaces, no auth, no keys, CORS open (`*`). If it is not on this page, do
> not call it: `/admin/*` needs a curator login, `/achievements/*` and
> `/requests/*` need board keys, and the Amiga byte-exact formats
> (`list.txt`, `index.tsv`, `catalog.txt`) are for BBS clients, not bots.

Bases (HTTPS; plain HTTP serves the same paths):

- Doors: `https://doors.uprough.net/api/door-repo`
- Releases (BBS file listing): `https://doors.uprough.net/releases/v1`
- Integrations (external scene APIs for chats): `https://doors.uprough.net/api/integrations/v1`

Every releases response carries `X-Releases-Contract: 1` and
`X-Releases-Revision: r<count>-t<max-id>` (poll `/health` and compare
`revision` to stay current). Door responses carry `{revision}` in list
bodies. Errors are JSON: `{error: "<code>"}` with 404 for unknown
doors/files (`no such door`, `not_found`).

## Question → calls

| User asks | Call |
|---|---|
| Find doors about X | `GET /doors?q=X` (searches archive name, door name, author, group, description, DIZ) |
| Filter doors | `GET /doors?type=&system=&requires=&category=` — valid values come from `GET /facets` (never invent them) |
| Tell me about door Y | `GET /doors/<ARCHIVE>` (full detail: DIZ, doc, guide nodes, files, votes, tags, screenshots) |
| Surprise me / random door | `GET /doors/random` (same body as detail, hidden doors excluded) |
| Download link for a door | `downloadUrl` field (e.g. `/api/door-repo/archive/FOO.LHA`), or `GET /archive/<ARCHIVE>` directly |
| Door stats / "how many" | `GET /stats` (totals, top groups/authors, types, sizes, indexed-over-time) |
| Find files in the BBS listing | `GET /list?q=X` (filename + description substring) |
| Filter listing | `GET /list?flag=&group=&dir=&from=&to=` (`flag`: N/P/D/…; `from`/`to`: `YYYY-MM-DD`) |
| Tell me about file N | `GET /files/<id>` (full row incl. verbatim `rawDesc` art block) |
| Surprise me / random file | `GET /random` (same body as `/files/:id`) |
| Listing stats | `GET /stats` (flags, top groups/**uploaders**/authors, sizes, months) |
| Fun facts / first DIZ / records | `GET /facts` (date span, first art-DIZ **with `rawDesc`**, peak year/month, DMS→LHA crossover year, weekday counts, biggest/longest/most-downloaded, median size) |
| All files for offline use | `GET /dump` (NDJSON, slim columns; resume broken pulls with `?since=<last id>`); doors equivalent: `GET /export.csv` |
| Tell me about / find prod X | `GET /api/integrations/v1/answer?q=X` (fans out to Pouët, Demozoo, AsciiArena, Internet Archive, demoparty.net, artpacks, radio + keyed/custom sources when configured) |
| Surprise me (scene) | `GET /api/integrations/v1/answer?q=X&mode=random` (one random hit per source that offers it) |
| Latest scene arrivals | `GET /api/integrations/v1/answer?q=X&mode=latest` |
| Is this download link alive | `GET /api/integrations/v1/check?url=<https-url>` (`{url, ok, status}` — HEAD-checked; private hosts refused) |
| Which sources are up | `GET /api/integrations/v1/status` (per-source `ok`, `latencyMs`, `detail`; keyed sources report `no api_key stored` when dark) |

## Shapes (trimmed)

`GET /doors?q=chat` → `{revision, total, page, perPage, sort, dir,
rows: [{archiveName, system, name, catalogName, nameSource, description,
descriptionSource, version, author, releaseGroup, releaseGroupFullName,
category, doorType, requiresBbs, size, md5, sha256, junkCount, adsStripped,
hasDoc, downloadUrl, votesUp, votesDown, tags, indexedAt, releaseDate,
platform, credits, externalLinks, screenshots, demozooUrl}]}`

`GET /doors/<ARCHIVE>` → the row above, plus `{fileIdDiz, docFilename, doc,
suggestedTooltypes, docFormat ("amigaguide"|"text"), guide: {nodes[]},
files: [{path, size, isJunk, junkReason}]}`.

`GET /list` → `{contractVersion, revision, total, offset, limit,
rows: [{id, dirNo, fileNo, filename, flag, sizeBytes, sizeNote, dateIso,
dlCount, uploader, description, version, author, releaseGroup,
releaseGroupFull, rawDesc}]}`. `GET /files/<id>` and `GET /random` return
one such row.

## Field notes (quote these to users when relevant)

- `name` is the display name; `nameSource: "archive"` means it was guessed
  from the filename. `descriptionSource` is `"edited"` (human) or `"diz"`.
- `flag: "D"` on a release means nuked: `sizeBytes` is null and `sizeNote`
  holds the reason (`>NUKED<`, `DELETED`, …).
- `dateIso` is the BBS entry (upload) date, `YYYY-MM-DD`. A few are capture
  typos (one file claims 2038); `/facts` reports `futureCount`.
- `uploader` exists on ~3% of entries (`Sent by:` credits, name trailers).
  Never present bracket art (`[-nick-]`) as uploaders — those are
  courier/greet credits. The stats uploader chart covers the named subset
  only; say so.
- `rawDesc` is the description block verbatim, art included — large. Prefer
  `description` for summaries; fetch `rawDesc` only to show the text.
- Score for votes is `votesUp - votesDown`.
- Hidden/removed doors are invisible: no list, detail 404s. Do not reveal
  their existence.

## Integrations field notes (quote these to users when relevant)

- `/answer` returns `{query, mode, results, sources, stale}`. Every result
  carries `source` (Pouët, Demozoo, AsciiArena, Internet Archive,
  demoparty.net, artpacks, radio, or a custom name) — always attribute.
- `sources[]` says who answered (`ok`, `ms`) and who did not (`detail`).
  When a source is down, say so with attribution ("Pouët is down, here's
  Demozoo") — never present another source's hits as its own.
- `stale: true` means everything failed and this is the last-known answer.
  Say so.
- Keyed sources (ModArchive, TMDB, OMDb) are dark until the curator stores
  a key in the admin panel; `/status` reports `no api_key stored`. Custom
  curator sources appear with their own names.
- AsciiArena links go to the on-site viewer (`html_url`) — never paste
  `text` art into chat; auto-detected (`manual: false`) bounds are
  approximate anyway.
- Demozoo `?q=` matches broadly (a `?` title means the query hit comments
  or credits, not the title) — prefer the top hits, link `demozoo_url`.
- Artpack hits are ZIP download links (raw bytes, CP437-safe because they
  are never transcoded), not viewable text.
- Radio answers "what is playing" only when the curator configured a
  station; otherwise it contributes nothing.

## Pagination, sorting, limits

- Doors list: `?page=` (1-based), `?per_page=` (max 200, default 50);
  `?sort=name|archive|size|author|group|type|category|requires|version|indexed|votes`
  with `?dir=asc|desc`. Unknown sort keys fall back safely.
- Releases list: `?offset=` + `?limit=` (default 100, max 500);
  `?sort=filename|group|flag|size|date|dir|file|version|author|downloads|uploader|id`
  with `?order=asc|desc` (default `id` asc). `?since=<id>` pages deltas
  (forces id-ascending, ignores offset/sort). `?fields=a,b` trims columns
  (`id` always kept).
- Page, don't scrape: bulk needs are covered by `/dump` and `/export.csv`.

## Worked examples

```bash
# doors about trading, newest first
curl 'https://doors.uprough.net/api/door-repo/doors?q=trade&sort=indexed&dir=desc'

# full detail incl. DIZ text
curl 'https://doors.uprough.net/api/door-repo/doors/ACC-V103.LHA'

# random door for "surprise me"
curl 'https://doors.uprough.net/api/door-repo/doors/random'

# listing search + range + sort
curl 'https://doors.uprough.net/releases/v1/list?q=tracker&from=1995-01-01&to=1996-12-31&sort=date&order=desc'

# headline facts (first DIZ, peaks, records)
curl 'https://doors.uprough.net/releases/v1/facts'

# scene-wide answer with attribution
curl 'https://doors.uprough.net/api/integrations/v1/answer?q=revision'

# is a download link alive before handing it out
curl 'https://doors.uprough.net/api/integrations/v1/check?url=https://files.scene.org/'
```
