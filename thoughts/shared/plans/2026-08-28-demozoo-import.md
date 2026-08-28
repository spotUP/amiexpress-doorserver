---
date: 2026-08-28
topic: Import AmiExpress doors from Demozoo
tags: [import, demozoo, scraping, catalog]
status: draft
---

# Import AmiExpress doors from Demozoo

## Goal
Walk three Demozoo tag pages (`amiex`, `daydream-amiga`, `fame`),
find the productions we don't already have, and bring them into the
repository. For doors we already have, fill in any metadata that's
missing in our row but present in Demozoo (release group, release date,
credits, screenshots, scene.org download link). If Demozoo carries a
field we don't store, add the column.

## What Demozoo gives us

All three tag pages paginate (~7 pages each). Listing pages are HTML
with a `/productions/<id>/-name/` link per row plus the release group
and date. The detail page is the only place the **Filename** appears,
and it is the one field we need to match against our `archive_name`.

Demozoo publishes a JSON API at `/api/v1/`. Two endpoints matter here:

- `GET /api/v1/productions/?tag=<tag>&format=json` — paginated, gives
  `id`, `title`, `author_nicks`, `release_date`, `platforms`, `types`,
  `tags`, plus a `next` URL.
- `GET /api/v1/productions/<id>/?format=json` — same plus `credits`,
  `download_links`, `external_links`, `screenshots`. **No `filename`.**

The filename comes only from the HTML detail page (rendered by a
section labelled "Filename:"). That means every production we want to
import needs:

1. one API call to the list endpoint to enumerate,
2. one API call to the detail endpoint to harvest structured fields,
3. one HTML fetch of `/productions/<id>/` to grab the filename.

That's ~3 fetches per door. The robots.txt crawl-delay is **10s for
`User-agent: *`**, so a 200-door import is ~50 minutes at the floor
delay. We can be faster on consecutive detail pages because they're
different URLs and Demozoo's CDN tolerates burst — but we will be polite
(2s between requests, 10s every 50) and respect a 429 if it ever
shows up.

## What we have

`door_catalog` (after migration v8):

```
id, archive_name, archive_path, binary_name, door_type, name, version,
author, release_group, description, file_id_diz, doc_filename, doc_raw,
suggested_tooltypes, category, archive_size, junk_count, ads_stripped,
corpus_id, source, indexed_at, md5, sha256, requires_bbs
```

The public `/doors/:archiveName` payload (`web/src/api/types.ts Door`)
returns: archiveName, system, name, catalogName, nameSource, description,
descriptionSource, version, author, releaseGroup, releaseGroupFullName,
category, doorType, requiresBbs, size, md5, sha256, junkCount,
adsStripped, hasDoc, downloadUrl, votesUp, votesDown, indexedAt.

## Demozoo → schema mapping

| Demozoo | Our column | Notes |
|---|---|---|
| `title` | `name` | subject to `clean()` (existing) |
| `author_nicks[0].releaser.name` | `author` | if `is_group` true and short abbrev present, also fill `release_group` (abbrev) and let `release_group_full_name` come from `release_groups` table |
| filename from HTML | `archive_name` | UPPERCASE on Demozoo, we normalise to title-case (existing) |
| filename basename without ext | fallback `name` | only if classifier has nothing better |
| `release_date` (YYYY-MM-DD) | new column `release_date` (TEXT) | Demozoo distinguishes "release date" from "added to demozoo" — we want the former |
| `types[0].name` | `category` | "BBS Door" or "Tool" etc. |
| `platforms[].name` | new column `platform` (TEXT) | currently "Amiga OCS/ECS" for all of them; future-proofing |
| `download_links[]` | new column `download_url` (TEXT) | first `SceneOrgFile` link if any |
| `credits[]` | new column `credits` (TEXT, JSON) | array of `{nick, category, role}` |
| `external_links[]` | new column `external_links` (TEXT, JSON) | array of URLs |
| `screenshots[]` | new column `screenshots` (TEXT, JSON) | array of `{thumbnail_url, standard_url}` — at most a handful |
| tags like `fame`/`daydream-amiga` | already handled by `door_tags` | don't reinvent |

None of those new columns are required for the rest of the doorserver
to function — they're enrichment. They need a migration.

## File acquisition: the real question

Our existing import path is `door_submissions` → `approveSubmission` →
`INSERT INTO door_catalog`. That path **requires a file on disk** at
`archivesRoot/Submitted/<archive_name>` and computes size, md5, sha256,
files, and DIZ from the bytes. There is no `archive_path = NULL` path
today; every catalog row expects the archive to be sitting on disk and
a corpus scan to re-describe it from there.

Three options for new doors from Demozoo:

1. **Download from scene.org via `download_links[0].url` and place
   under `archivesRoot/Submitted/`.** Reuse the existing submission
   approval flow exactly. The scene.org link is the same one the
   detail page exposes. Cleanest — the importer becomes a script
   that calls `approveSubmission` after the file lands.
2. **Metadata-only stub: insert with `archive_path = NULL` and
   `source = 'demozoo'`, and let the corpus scan fill in size/digest
   later** when someone drops the file in. Requires a schema change
   (allow NULL `archive_path`) and a corpus-scan tolerant of a row
   that points at nothing.
3. **Manual queue: insert into `door_submissions` with a synthetic
   placeholder; admin approves once they've fetched the file.** Same
   end-state as #1, but keeps the human in the loop. Demozoo's
   download URL is one click away.

Recommended: **#1**. We already have scene.org URLs for every Demozoo
door in `download_links`. We download into `Submitted/`, call
`approveSubmission` with that file, and the existing flow handles
filename normalisation, LZX→LHA repack, classifier extraction, and
catalog insertion. The Demozoo script's only new job is "fill the
submission row from a remote URL".

If scene.org is down or a door has no `SceneOrgFile` link, fall back
to #3 (create a pending submission with the Demozoo URL in the note,
no file, so the admin sees it in the queue).

## Match strategy

For each Demozoo production, lower-case its `Filename` and compare
against our `archive_name` lowercased. That's a 1:1 match for most
doors because the filename IS the archive. Two failure modes:

- Filename is missing on the HTML page (some productions have only a
  download link, no separate "Filename:" line). Fall back to deriving
  one from `download_links[0].url` (last path segment, URL-decoded).
- Filename differs because Demozoo lists the **packed** name (e.g.
  `MSG-D34.LHA` packed by FAME 2.8) and we hold the **original** name
  (e.g. `SYSDL34.LHA`). When that happens, fall back to title + author
  fuzzy match and surface the candidates in a review file rather than
  auto-linking.

The fuzzy matcher should be conservative: prefer no match to a wrong
match. We will always log every Demozoo → our row decision (or
"unmatched") in `thoughts/shared/handoffs/<date>-demozoo-import.md`.

## Architecture

```
   ┌────────────┐   /api/v1/productions/?tag=amiex        ┌──────────┐
   │ Demozoo    │ ─────────────────────────────────────▶  │  scripts/│
   │ JSON API   │   /api/v1/productions/?tag=daydream-    │ demozoo  │
   │            │   /api/v1/productions/?tag=fame         │  -import │
   │  detail    │   /api/v1/productions/<id>/  (json)     │    .ts   │
   │  HTML      │   /productions/<id>/        (html,      │          │
   │            │     for the Filename)                   │          │
   └────────────┘                                          └────┬─────┘
                                                                │
                                              scene.org /        │
                                              download_links[]   ▼
                                                                │
   ┌──────────────────────┐    POST /admin/submissions  ┌──────────────┐
   │  doorserver          │ ◀────────────────────────── │  downloads   │
   │  (existing admin     │   (or direct DB insert via  │  .lha into   │
   │  flow)               │    better-sqlite3 if we're  │  archivesRoot│
   │                      │    a script on the same     │  /Submitted/ │
   │                      │    host)                     └──────────────┘
   └──────────────────────┘
```

## Implementation

### Phase 1 — schema additions

**`src/migrations.ts`** — two new migrations:

```ts
{
  version: 9,
  name: 'door_catalog.demozoo_enrichment',
  up: (db) => {
    if (!hasColumn(db, 'door_catalog', 'release_date')) {
      db.exec("ALTER TABLE door_catalog ADD COLUMN release_date TEXT");
    }
    if (!hasColumn(db, 'door_catalog', 'platform')) {
      db.exec('ALTER TABLE door_catalog ADD COLUMN platform TEXT');
    }
    if (!hasColumn(db, 'door_catalog', 'download_url')) {
      db.exec('ALTER TABLE door_catalog ADD COLUMN download_url TEXT');
    }
    if (!hasColumn(db, 'door_catalog', 'credits')) {
      db.exec('ALTER TABLE door_catalog ADD COLUMN credits TEXT');     // JSON
    }
    if (!hasColumn(db, 'door_catalog', 'external_links')) {
      db.exec('ALTER TABLE door_catalog ADD COLUMN external_links TEXT'); // JSON
    }
    if (!hasColumn(db, 'door_catalog', 'screenshots')) {
      db.exec('ALTER TABLE door_catalog ADD COLUMN screenshots TEXT');    // JSON
    }
  },
},
{
  version: 10,
  name: 'demozoo_imported',
  up: (db) => {
    // Production ids we have already processed. A re-run reads this
    // at startup and skips every id in it — no fetch, no insert,
    // no audit row. Makes the import safely resumable across
    // crashes, network blips, or a Ctrl-C.
    db.exec(`
      CREATE TABLE IF NOT EXISTS demozoo_imported (
        id          INTEGER PRIMARY KEY,
        imported_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`);
  },
},
```

**`src/schema.sql`** — add the same columns to the `CREATE TABLE` so a
fresh database carries them.

**`web/src/api/types.ts Door`** — add the new fields, all optional
(string | null). Don't break the public response shape.

**`src/public-routes.ts`** — include the new fields in the `Door`
payload if present.

**`src/admin-routes.ts` PATCH `/doors/:archiveName`** — accept the new
fields as overridable (so Demozoo enrichment writes flow through the
audit trail like any other admin edit).

### Phase 2 — scraper + importer

**`scripts/demozoo-import.ts`** — single-shot Node script. Lives next
to the other `scripts/*.ts` so the existing `tsx scripts/<name>.ts`
workflow keeps working. No long-running daemon.

Behaviour, in order:

1. **Resume-aware enumerate** — for each of the three tags, walk
   the paginated `?tag=…` JSON endpoint and collect every
   `{id, title, ...}`. Stop when `next` is null. **Skip any id
   already in `demozoo_imported`** (loaded into a Set at startup).
2. **Dedupe** — union the three sets by `id` (a door can carry all
   three tags).
3. **Detail fetch** — for each remaining `id`, GET the JSON detail
   + the HTML page in parallel (one setTimeout loop is fine, no
   need for `Promise.all` to flood Demozoo). Parse the HTML for the
   `Filename:` line with a single regex; if absent, derive from the
   first `download_links[0].url`. Respect crawl-delay 2s between
   requests, 10s every 50.
4. **Match** — load every `archive_name` from our `door_catalog`
   into a lowercased Set. Lowercase the Demozoo filename. **Exact
   match only** — no fuzzy. Anything that doesn't match goes to
   `unmatched` in the handoff for human review.
5. **For new doors** — download the scene.org file into
   `<archivesRoot>/Submitted/<archive_name>` with node's built-in
   `https`. Compute size, md5, sha256 of the downloaded bytes.
   Open the doorserver's SQLite at `cfg.dbPath` directly and
   **insert into `door_submissions`**, then call
   `approveSubmission(db, cfg, id, NULL)`. The `NULL` admin id
   causes the audit row to record `by 'system'`. On success,
   record the id in `demozoo_imported`.
6. **For existing doors** — read the current `door_catalog` row,
   diff against the Demozoo data, and PATCH any NULL fields the
   Demozoo source has values for. Use the existing admin PATCH so
   the audit trail is consistent. **Never overwrite a non-NULL
   with a Demozoo value** — human edits win. On success, record
   the id in `demozoo_imported` so the next run doesn't re-PATCH.
7. **Retry on transient errors** — a failed download, a 5xx from
   Demozoo, or a 429 is retried up to 3 times with exponential
   backoff (1s, 4s, 16s). Persistent failures are logged and
   skipped — the id is NOT added to `demozoo_imported`, so a
   re-run will pick it up.
8. **Write a handoff** — `thoughts/shared/handoffs/YYYY-MM-DD-demozoo-import.md`
   with: total scraped, per-tag counts, skipped (already imported)
   count, matched / new / unmatched breakdown, every "review
   needed" entry with title, author, filename, scene.org URL, and
   any error log for the persistent-failure cases.

### Phase 3 — backfill existing doors (optional first pass)

If a door is already in our catalog but is missing
`release_group`/`release_date`/etc., the same script will fill it
during the "existing doors" step. No separate run needed.

## Files to change

| File | Change |
|------|--------|
| `src/migrations.ts` | Add migration v9 for the new columns |
| `src/schema.sql` | Add new columns to the base `CREATE TABLE` |
| `src/admin-routes.ts` | Accept new fields in PATCH `/doors/:archiveName` |
| `src/public-routes.ts` | Include new fields in `/doors/:archiveName` payload |
| `web/src/api/types.ts` | Add new fields to `Door` (all optional) |
| `scripts/demozoo-import.ts` | **New.** The scraper + importer |
| `thoughts/shared/handoffs/<date>-demozoo-import.md` | **New.** Run report |

## Verification

1. `npm run typecheck` — passes
2. `npm test` — existing 321 tests still pass
3. Re-run the script on a fresh DB to confirm it's idempotent: a
   second pass should produce zero new rows and zero PATCH writes
   (because every field is now non-NULL and equal).
4. Open three doors in the admin UI that were imported from
   Demozoo — verify the new fields show up, the file lists and DIZ
   look right, and the audit trail has one `edit` entry per
   backfilled field.
5. Spot-check a door that was already in the catalog before the
   import: confirm no field changed and there's no new audit row.
6. Spot-check a "review needed" door from the handoff report: open
   the scene.org URL by hand, confirm the file matches, and decide
   whether to drop it in `Submitted/` for the script to pick up on
   a re-run.

## Open questions — resolved

1. **Importer admin identity.** `NULL`. Audit trail's `by` already
   falls back to `'system'` (`src/admin-routes.ts:1004`:
   `COALESCE(u.username, 'system')`). The script just passes
   `decided_by = NULL` and the audit row shows "by system" — no
   special user to seed or clean up.
2. **Match strategy.** Strict filename only. Lowercase the Demozoo
   `Filename:` and look it up in our `archive_name` Set. Anything
   that doesn't match goes to `unmatched.txt` in the handoff for
   human review. No fuzzy matching — false positives are worse than
   "review needed" rows.
3. **Re-runnability.** New migration v10 creates
   `demozoo_imported (id INTEGER PRIMARY KEY, imported_at INTEGER)`.
   The script reads the populated set at startup and skips those
   `id`s entirely (no fetch, no insert, no audit). Combined with
   the "never overwrite a non-NULL" rule in Phase 2 step 6, a
   re-run is safe: it picks up where it left off.
4. **`download_url` lifecycle.** Retry on failure. scene.org is
   stable; if a single download errors, log and continue. The
   `download_url` column is set once at import and not touched
   afterwards. No lifecycle code.
5. **`Tool`-type productions.** Import all productions on the three
   tag pages regardless of `types[].name`. The tags are the user's
   filter, not the type. `category` will record the Demozoo type
   ("BBS Door" / "Tool") so the data is preserved either way.

## Risk

- 3 fetches × 200 doors = 600 HTTP requests against a third-party
  service. Acceptable; 30 min at the rate-limit floor. If the import
  times out partway, the handoff + resume design picks up cleanly.
- A wrong `Filename` regex match would insert a door into the wrong
  row or skip a real one. The script's handoff report flags every
  match decision so a human can spot-check the suspect ones.
- Adding columns to `door_catalog` is a forward-only migration; it
  won't roll back. Reversibility is provided by the existing corpus
  re-scan, not by the importer.
