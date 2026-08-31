---
date: 2026-08-31
topic: Full bulk-edit feature for the admin door table (selection UX + batch actions)
tags: [admin, browse, batch, bulk-edit, sse, jobs]
status: final
---

# Bulk edit - design

## Problem

A bulk-edit UI was partially wired up (`web/src/components/BatchToolbar.tsx`,
`web/src/pages/Browse.tsx`, `POST /admin/doors/batch-hide|batch-restore|batch-patch`
in `src/admin-routes.ts`) but is unusable in practice:

1. **Selection is single-row only.** `Browse.tsx`'s `toggle()` flips exactly
   one row per click. There is no shift-click range select, and `toggleAll()`
   only ever covers the current page (`data?.rows`, capped at `PER_PAGE = 50`)
   - never the full set of rows matching the active filter.
2. **The toolbar exposes almost nothing.** `batch-patch` already accepts any
   of the 11 fields in `OVERRIDABLE_FIELDS` (`src/effective.ts`) - name,
   description, version, author, release_group, category, door_type,
   requires_bbs, binary_name, suggested_tooltypes, file_id_diz - generically,
   but `BatchToolbar.tsx` hardcodes exactly one of them (category) plus a
   fixed fix-casing sentinel. Ten of eleven fields are batch-editable
   server-side today and unreachable from the UI.
3. **No batch tag, strip, or re-extract.** Each of these exists as a
   single-door route (`PATCH /doors/:archiveName/tags`, `POST
   /doors/:archiveName/strip`, `POST /doors/:archiveName/reextract`) with
   no plural counterpart.
4. **No permanent delete at all, single or batch.** `DELETE
   /doors/:archiveName` (`src/admin-routes.ts:590`) is a soft hide - it
   writes to `door_hidden`, exactly what `POST .../restore` and the
   existing `batch-hide`/`batch-restore` routes already cover. There is no
   route anywhere that removes a `door_catalog` row and its archive file
   for good. "Bulk delete" therefore needs new single-item semantics
   defined from scratch, not a plural wrapper around something that exists.

## What is being built

- A real multi-select model in `Browse.tsx`: shift-click range select,
  cmd/ctrl-click (already implicit in a checkbox, kept as-is), and a
  "select all N matching filter" control that goes beyond the current page.
- Two new synchronous batch routes (`batch-tags`, `batch-delete`), following
  the exact transaction-per-item pattern `batch-hide`/`batch-restore` already
  use.
- A new async job subsystem for the archive-file-touching batch actions
  (`batch-reextract`, and `batch-strip-preview`/`batch-strip-apply`), whose
  per-item cost (shelling out to `lha`/`unlzx`, re-reading and re-parsing an
  archive) is too high to run synchronously inside one HTTP request at bulk
  scale. Progress is pushed over the **existing** live-revision SSE
  connection (`src/public-routes.ts`'s `subscribe()`), not a new stream.
- A rebuilt `BatchToolbar` exposing a generic field-set control, tag
  add/remove, delete (capped + confirmed), re-extract (job-tracked with a
  progress bar), and strip as a **preview-review-apply** flow rather than a
  single fire-and-forget action - the admin sees and can deselect every
  flagged file across every selected archive before anything is deleted.

**Out of scope:** bulk rescan (`POST /doors/:archiveName/rescan` re-derives
from a *changed* file on disk - re-extract already covers "re-read the DIZ
I already have"), a job-history panel beyond the one active job a client
reconnects to, and any change to what `batch-patch` itself accepts (it
already accepts the full field list; this work is UI-only for that route).

## Selection model (`web/src/pages/Browse.tsx`)

Replace the bare toggle with an anchor-tracked selection:

```ts
const [selected, setSelected] = useState<Set<string>>(new Set());
const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
const [selectAllMatching, setSelectAllMatching] = useState(false);
```

`DoorTable`'s checkbox `onClick` (not `onChange`, so the event carries
modifier keys) becomes:

- **Plain click:** toggle just this row; set it as the new anchor.
- **Shift-click:** select every row between `anchorIndex` and this row's
  index in the *currently rendered* page order (does not reach across
  pages - only the visible 50 rows have a defined order to range over);
  anchor is unchanged, so repeated shift-clicks extend/shrink from the
  same origin, matching spreadsheet/Finder behavior.
- **Cmd/Ctrl-click:** unchanged from today - toggles one row without
  touching the rest of the selection (this already works; a checkbox
  click never clears siblings).

"Select all N matching" appears in the header row, next to the existing
select-all-on-page checkbox, once every row on the current page is selected
and the filtered total exceeds the page size. Clicking it:

1. Sets `selectAllMatching = true` and fetches every matching `archiveName`
   via the existing `GET /doors` list endpoint with the current filter
   params and a page size covering the full result set (a plain string
   array response - `archiveName` only, not full `Door` objects, added as
   a `?fields=archiveName` mode on the existing route rather than a new one).
2. Merges the result into `selected`.

`selectAllMatching` is cleared by any subsequent plain/shift click (falls
back to page-local selection) or by `onClear`.

## Fast synchronous batch actions (`src/admin-routes.ts`)

`batch-patch` needs no backend change - it already accepts arbitrary
`OVERRIDABLE_FIELDS`. Two new routes, same shape as the existing
`batch-hide`:

**`POST /admin/doors/batch-tags`**
```
{ archiveNames: string[], add: string[], remove: string[] }
```
Per archive: adds each tag in `add` (idempotent - a tag a door already has
is a no-op) and removes each in `remove`, reusing the same `door_tags`
table writes `PATCH /doors/:archiveName/tags` already does. One audit-log
entry per archive, `action: 'edit-tags'`, matching the single-door route.

**`POST /admin/doors/batch-delete`** - genuinely permanent, no
single-door precedent to reuse (see problem statement, point 4), so this
defines that behavior for the first time:
```
{ archiveNames: string[], confirm: string }
```
- 400 if `archiveNames.length > 200` ("split into smaller batches").
- 400 if `confirm !== String(archiveNames.length)` - a server-side
  backstop, not merely a client-side dialog: the count must be typed back
  correctly regardless of what UI sent the request.
- Otherwise, per archive, inside one transaction: delete its rows from
  `door_catalog_files`, `door_catalog_overrides`, `door_hidden`,
  `door_tags`, `door_votes` (all keyed by `catalog_id`) and
  `door_not_junk` (keyed by `archive_name`), then the `door_catalog` row
  itself, then `fs.unlinkSync` the archive file at its resolved
  `archive_path`. `admin_audit` and `learned_junk_patterns` are NOT
  touched - an audit trail and a corpus-wide pattern list both outlive
  the row that happened to trigger them. Reports `{ deleted: string[],
  failed: { archiveName, error }[] }` - a missing file or an
  already-deleted row fails that one item, not the batch.

Both new routes: transaction-wrapped, per-item try/catch so one bad name
in a large batch doesn't fail the rest, response shape `{ ok: true,
succeeded: string[], failed: { archiveName, error }[] }` - consistent
with each other and with `batch-hide`'s existing response shape.

## Async job subsystem (new)

**Schema** (new migration):
```sql
CREATE TABLE batch_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('strip-preview', 'strip-apply', 'reextract')),
  result_json TEXT, -- strip-preview only: {archiveName, stripped: {path, reason}[]}[]
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  total INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE batch_job_items (
  job_id TEXT NOT NULL REFERENCES batch_jobs(id),
  archive_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ok', 'error')),
  error TEXT,
  PRIMARY KEY (job_id, archive_name)
);
```

**`POST /admin/doors/batch-reextract`**
```
{ archiveNames: string[] }
```
Inserts a `batch_jobs` row (`status: 'running'`) and one `batch_job_items`
row per archive (`status: 'pending'`), returns `{ jobId }` immediately
(no cap here - a job just takes longer, it doesn't block a request), then
processes items **sequentially** in the background (not `Promise.all` -
these shell out to `lha`/`unlzx`; this session already found two real bugs
in that exact code path, and running many instances concurrently is new
risk for no real speed benefit on a background job nobody's blocked on).
After each item: update its `batch_job_items` row, update the job's
`completed`/`failed_count`, and broadcast an SSE event. Matches today's
single-door `POST /doors/:archiveName/reextract`, which also applies
directly with no review step - re-extraction has no false-positive
concept the way strip does.

**Batch strip is two phases, not one job** - the single-door flow
(`strip-preview` then `strip` with an explicit, admin-reviewed `members`
list) exists specifically so a bad classifier match doesn't silently
delete a real file. A batch version that skipped straight to "strip
whatever each archive's classifier flags" would defeat that safety net at
bulk scale - exactly the shape of bug this session already found and
fixed for a single learned pattern (`docs` note: the `ami-stripper.ts`
"*"-glob incident). So:

**Phase 1 - `POST /admin/doors/batch-strip-preview`**
```
{ archiveNames: string[] }
```
Job-tracked like re-extract (still worth async - reading and classifying
hundreds of archives isn't instant), but read-only: runs the existing
`analyzeArchive()` per archive, no writes. On completion the job's result
is `{ archiveName, stripped: {path, reason}[] }[]` - every file each
archive's classifier flagged, stored on the job row (a `result_json`
column on `batch_jobs`, or a `batch_strip_candidates` table keyed by
`job_id` - either is fine, whichever reads more naturally against the
per-item schema already in place for the other jobs).

**Review screen** - once phase 1's job is `done`, the toolbar shows every
flagged file across every selected archive, grouped by archive, each
pre-checked (matching what opening a single door's strip-preview shows
today) with a per-file uncheck. A "confirm and strip N files across M
archives" button.

**Phase 2 - `POST /admin/doors/batch-strip-apply`**
```
{ jobId: string, selections: { archiveName: string, members: string[] }[] }
```
Takes the *admin-confirmed* member list per archive (never re-derives it
from the classifier) and runs the existing per-door `stripArchive()` /
strip logic against exactly those members, sequentially, as a second
job-tracked phase with its own progress bar and SSE events. An archive
the admin fully unchecked (empty `members`) is skipped, not force-stripped
with nothing.

**SSE integration** (`src/public-routes.ts`): the existing
`clients: Set<Response>` / `subscribe()` pair already pushes
`event: revision` to every open browser tab. Add a second event type on
the same connections:
```
event: job
data: {"jobId":"...","status":"running","completed":12,"total":50,"failedCount":1}
```
No new connection, no new keepalive logic - `broadcastJobEvent(job)` just
writes to the same `clients` Set `subscribe()` already maintains.

**`GET /admin/jobs/:id`** - current row + item list, for a client that
reconnects after a refresh: it opens the SSE connection as always (that
part needs no change) and separately fetches this endpoint once to seed
its progress bar with whatever happened while it was gone, then continues
from live `job` events.

## Frontend (`BatchToolbar.tsx` rebuild, `Browse.tsx` wiring)

- **Set field:** a field dropdown (the 11 `OVERRIDABLE_FIELDS`) next to a
  value input. `requires_bbs`, `category`, `door_type` reuse the same
  `<Select>` option lists the filter bar already builds from `/facets`;
  everything else is a plain text input. One "Apply" button, same
  `batch-patch` call, generic field name instead of hardcoded `category`.
- **Hide / Restore / Fix casing:** unchanged one-click shortcuts - kept as
  they are today, since they're the two most common single-purpose
  actions and a menu of one item each isn't an improvement.
- **Tags:** an add/remove tag picker reusing whichever tag-input component
  `DoorDetail.tsx`'s per-door tag editor already renders.
- **Delete:** a red button opens a confirm dialog showing the count and a
  text input the admin must fill with that exact count before "Delete" is
  enabled - client-side friction matching the server's own `confirm` check
  in section above, not a replacement for it.
- **Re-extract:** button fires the job endpoint; on receiving `{ jobId }`,
  the toolbar's action row is replaced by a progress bar (`completed /
  total`, failed count) driven by `job` SSE events already arriving on the
  tab's existing connection, with a collapsed "N failed" link that expands
  to the specific archive/error pairs from `batch_job_items`. Disappears
  (or shows a dismissable "done" state) once `status` is `done`/`failed`.
- **Strip:** button fires `batch-strip-preview` and shows the same
  progress bar while phase 1 runs. On completion, the toolbar is replaced
  by the review screen: every flagged file across every selected archive,
  grouped by archive, pre-checked, each with its classifier reason (same
  `reason` value the single-door strip-preview already shows) and a
  per-file uncheck. "Confirm and strip" fires `batch-strip-apply` with
  exactly the checked set and shows a second progress bar for phase 2.
  "Cancel" abandons the job with no writes made.

## Testing

- **Backend:** one test file per new route (`batch-tags`, `batch-delete`,
  `batch-strip-preview`, `batch-strip-apply`, `batch-reextract`, plus the
  `?fields=archiveName` list mode), mirroring the existing
  `batch-hide`/`batch-restore` tests already in `tests/admin-routes.test.ts`
  - happy path, one bad archive name doesn't fail the others, the delete
  cap/confirm rejection, `batch-strip-apply` skipping an archive whose
  `members` list is empty rather than force-stripping it, and (for the
  three job routes) that the job row reaches `status: 'done'` with correct
  `completed`/`failed_count` after processing a small fixture batch.
- **Frontend:** this repo has no component/unit test infra for `web/`
  today (Jest's config covers only `src/`/`tests/`) - verified manually
  instead, same as every other UI change in this project: start the dev
  server, exercise shift-click range select, "select all matching",
  each new toolbar action, and a strip/re-extract job's progress bar and
  failure list, against real catalog data.

## Rollout

Same pattern as everything else pushed this session: typecheck + full
test suite green, push to `main`, watch the `Deploy door server` GitHub
Actions run to completion, confirm `/api/door-repo/health` and one
exercised action against the live site before calling a phase done. No
data migration needed beyond the two new tables (empty on creation - no
existing rows to backfill).
