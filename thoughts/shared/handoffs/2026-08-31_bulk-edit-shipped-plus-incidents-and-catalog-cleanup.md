---
date: 2026-08-31
topic: Bulk-edit feature shipped end-to-end, two live infra incidents resolved, catalog duplicate/LZX cleanup completed
tags: [bulk-edit, admin, deploy, docker, buildkit, lzx, dedupe, incident]
status: final
---

# Session handoff: bulk-edit shipped, infra incidents fixed, catalog cleaned up

## Task(s)

**All primary work from this session's starting handoff is now complete:**
the 13-task bulk-edit implementation plan (`docs/superpowers/plans/2026-08-31-bulk-edit.md`)
was executed via subagent-driven-development end to end: every task
implemented, task-reviewed (several went through fix rounds), then a final
whole-branch review (Opus) found 4 Important + several Minor findings, all
addressed in one fix wave, re-reviewed clean, merged to `main`.

**Also resolved during and after shipping, all live-production work:**
1. A deploy failure corrupted the Hetzner host's Docker BuildKit cache,
   crash-looping the whole Docker daemon and taking every container on the
   box down repeatedly. Diagnosed and fixed (see Learnings).
2. Several real bugs found via live manual testing of the shipped feature,
   fixed and deployed same session (see Recent Changes).
3. The `.lzx` duplicate/collision problem flagged in the prior session's
   handoff (`2026-08-31_bulk-edit-plan-and-session-summary.md`, "Next Steps
   #2") was fully resolved: all 70 `.lzx`-named catalog rows and 9 other
   pre-existing duplicate-name pairs are gone. Zero duplicate archive names
   remain anywhere in the catalog.

**Nothing is left pending from this session.** The only standing item is
routine: a human should still click through the manual-verification
checklist in a browser at some point (list below), though extensive live
testing already happened during this session and found/fixed several real
bugs.

## Critical References

- **Plan:** `docs/superpowers/plans/2026-08-31-bulk-edit.md` — all 13 tasks
  complete.
- **Spec:** `docs/superpowers/specs/2026-08-31-bulk-edit-design.md`.
- The SDD ledger and per-task briefs/reports lived in
  `.claude/worktrees/bulk-edit/.superpowers/sdd/2026-08-31-bulk-edit/` —
  that worktree has been removed (merged + cleaned up per
  `finishing-a-development-branch`), so the ledger no longer exists on
  disk. This handoff is the durable record of what it contained.
- **Deploy:** `git push` → GitHub Actions `Deploy door server` workflow →
  Hetzner VPS via SSH, `docker compose up -d --build`. Confirm with
  `gh run watch <run-id> --exit-status`, then
  `curl https://doors.uprough.net/api/door-repo/health`.
- **`sqlite3` is not baked into the container** — reinstall every time
  after a redeploy/restart: `docker exec doorserver-doorserver-1 apk add
  --no-cache sqlite`. This came up probably a dozen times this session.
- **DB surgery pattern used all session:** never swap the whole
  `data/doors.db` file. Generate targeted SQL (`INSERT`/`UPDATE`/`DELETE`
  in an explicit transaction), `scp` it to the VPS, `docker cp` it into the
  container, `sqlite3 /data/doors.db '.read /tmp/x.sql'`. Every write
  tonight was preceded by a full DB backup (`docker cp ... doors.db.pre-*`)
  and, for file-touching operations, a backup of every archive file about
  to be modified/deleted. All backups are on the VPS at
  `/root/db-backups/` and were also pulled to a local, gitignored
  `db-backups/` directory in this repo (added to `.gitignore` this
  session — do not remove that entry, the directory holds a ~78MB DB dump
  and dozens of archive files that must never be committed).

## Recent Changes (this session, chronological)

### Bulk-edit implementation (13 tasks, all merged to `main`)

Backend: `batch_jobs`/`batch_job_items` schema (as migration **version 15**,
not 14 — see Learnings), a sequential job-runner with SSE progress,
`batch-tags`, `batch-delete` (real permanent delete, first one in this
codebase), job-tracked `batch-reextract`, job-tracked `batch-strip-preview`
+ `batch-strip-apply` (two-phase: preview → admin review → apply),
`?fields=archiveName` unpaged lookup for select-all-matching-filter.

Frontend: shift-range select with a `rangeBase` snapshot (the plan's own
literal algorithm couldn't shrink a selection — fixed during implementation,
verified against the plan's own manual-test narrative), select-all-matching
UI, a shared-SSE-connection `useJobProgress` hook (ref-counted singleton),
a rebuilt `BatchToolbar` (generic field editor, tags, delete, re-extract),
and `BatchStripReview` (the preview/apply review screen).

Two load-bearing preflight rulings held up under review: (1) the plan's
literal `previewStripOne()` extraction would have silently narrowed the
live single-door "Strip ads" panel's response shape — preserved the exact
original shape instead, verified field-by-field; (2) the plan's literal
`reextractOneDoor()` dropped an outer `try/catch`, which would have let an
exception crash uncaught instead of returning a clean 500 — restored it.

Final whole-branch review (Opus) found 4 Important issues, all fixed in one
wave: (1) the job runner had no rejection handler — a DB write failure
could crash the whole Node process and wedge a job at `status='running'`
forever, fixed with a top-level catch + `markJobFailed` + `.catch()`
backstops at all 3 job routes; (2) "Select all N matching" showed a lying
count under the "Needs a name" filter (button said 312, selected ~5,700) —
gated the button off under that filter; (3) job failures became invisible
the instant a job completed — added a minimal dismissable "N succeeded, M
failed" summary (deliberately NOT the full expandable per-archive error
list the spec described — that's real new scope, flagged as a future
task, not squeezed into the fix wave); (4) batch-strip's preview phase had
no progress indicator at all — added one.

### Live incidents (both resolved same session)

1. **BuildKit cache corruption crash-looped the whole Docker host.** A
   deploy's `docker compose up -d --build` step failed with a network EOF
   mid-`apk add` inside the build. This corrupted BuildKit's internal bbolt
   cache database (`/var/lib/docker/buildkit/cache.db`) — every subsequent
   `dockerd` startup panicked (`panic: page 1488 already freed`, a bbolt
   freelist double-free) and crashed, taking down **every container on the
   shared host** (doorserver, amiexpress-bbs, retroranks, devilbox,
   bratwurst, postgres — this box runs several unrelated services).
   systemd kept auto-restarting `docker.service`, which kept re-panicking.
   Fix: `systemctl stop docker`, move `cache.db` aside (not delete —
   `/var/lib/docker/buildkit/cache.db.corrupt-<timestamp>`), `systemctl
   start docker`. All 8 containers on the host came back via their own
   `restart: unless-stopped` policies. No application data was affected —
   BuildKit's cache is pure build-cache, unrelated to the `doorserver-data`
   volume. Root-caused via `journalctl -u docker`, not `dmesg` (no kernel
   OOM entries — this was **not** an OOM kill, a common wrong first guess
   given the "every container died at once" symptom).
2. **A batch-strip review bug reached production before the fix landed**
   (see next section) — this is process learning, not an incident: manual
   live testing surfaced it within minutes of the feature going live.

### Post-ship bug fixes found via live testing (all deployed)

- `BatchStripReview.tsx`: an archive whose *preview* failed to read was
  still forwarded into apply with `members: []`, which
  `stripArchiveOnServer` treats as "reviewed, nothing to strip" — falsely
  marking a corrupt-but-present archive `ads_stripped=1`. Fixed:
  `candidates.filter(c => !c.error)` before building `selections`.
- `useBatchTags()`'s cache invalidation covered `doorKeys` but not the
  separate `tagKeys` namespace `useDoorTags()`/`DoorDetail`'s tags panel
  reads from — a batch-added tag saved correctly but the detail dialog
  kept showing stale (empty) tags. Fixed by invalidating `tagKeys.all` and
  `tagKeys.door(name)` per affected archive in the same `onSuccess`.
- Six purely-synchronous batch actions (hide/restore/set-field/fix-casing
  /tags/delete) had **zero** visible feedback on success or failure — a
  click either worked or failed in total silence. Added a minimal toast
  stack (`ui.tsx`'s `ToastStack`) and wired success/error messages into
  all six.
- The tag input's `+tag` syntax never stripped the leading `+` — typing
  `+foo` created a tag literally named `"+foo"`, not `"foo"`. Fixed the
  parse in `BatchToolbar.tsx`.
- The batch-strip-preview progress bar only rendered once at least one SSE
  event had arrived for the job — the gap between clicking "Strip ads" and
  that first event (POST round-trip + however long the first archive takes
  to classify) showed nothing, looking hung on a large selection. Fixed:
  spinner now covers `batchStripPreview.isPending` too, with an indefinite
  "Starting strip preview..." label before real counts arrive.

### Catalog data cleanup (the `.lzx` problem from the prior handoff, fully resolved)

The prior session's handoff flagged 70 `.lzx`-named catalog rows and
explicitly warned not to bulk-repack/delete them without per-pair content
verification (the `GNT-ACT3.LZX` vs `GNT-ACT3.LHA` discovery — same
filename, genuinely different releases). This session did that
verification for all of them, plus 9 more duplicate-name pairs found with
other extensions:

- **26 of the 70** turned out not to be stale-metadata rows as first
  guessed, but **literal duplicate catalog rows** — the same physical file
  on disk, catalogued twice under two different IDs (one correctly named,
  one with a wrong/stale `archive_name`). Deleted the duplicate row after
  migrating any real curated data (tag/override edits) on it to the correct
  row — 6 of the 26 had real overrides that would otherwise have been lost.
- **1 was a true content-duplicate** (`Submitted/dtr-t98b.lzx`, byte-for-
  byte identical in file-list-and-sizes to the already-catalogued
  `AmiExpress/DTR-T98B.lha`) — deleted, row and file both.
- **43 were genuinely distinct content** (diffed every single one against
  its same-named sibling — 42 of 43 differ, matching the `GNT-ACT3`
  pattern, not a fluke). Repacked each to `.lha` in place using the app's
  own `repackLzxToLha()` (reused directly via `require()` against the
  compiled `dist/`, not reimplemented), with a **disambiguating filename**
  (`{base}_{OriginalFolderName}.lha`, e.g. `GNT-ACT3.LZX` in `AmiExpress/`
  → `GNT-ACT3_AmiExpress.lha`) so the repacked file's name can never
  collide case-insensitively with its distinct sibling — this database
  looks up doors by `archive_name COLLATE NOCASE` everywhere, so a naive
  rename would have made two *different* doors ambiguous to every
  single-door lookup route.
- **9 more pairs** with other extensions (`.lzh`, `.dms`, `.lha`) were
  found to have the exact same collision pattern, unrelated to LZX — all
  9 diffed as genuinely distinct (the `.dms` pair by MD5 hash, since DMS is
  a disk image, not a member archive — no extraction tool for it was
  available). Since these were already in readable/writable formats,
  no repack was needed — just the same disambiguating rename.

**Result: `SELECT COUNT(*) FROM door_catalog WHERE archive_name LIKE
'%.lzx'` = 0. `SELECT LOWER(archive_name), COUNT(*) ... GROUP BY ... HAVING
COUNT(*) > 1` = 0 rows anywhere in the catalog.** Catalog went from 5717 to
5690 doors (net -27, matching the 26+1 real deletions exactly — the 43
repacks and 9 renames didn't change the row count).

## Learnings

- **Migration version numbers are a merge hazard.** `main` had grown a
  competing `version: 14` migration (`door_catalog.classified_fp`) between
  when this branch forked and when it merged. Resolved by keeping `main`'s
  version 14 untouched and renumbering this branch's `batch_jobs` migration
  to **version 15** — migrations are tracked by version number in
  `schema_migrations`, so renumbering an *already-applied* migration is
  unsafe; only the new, unapplied one may move.
- **`dmesg`/kernel OOM logs are the wrong first place to look** when every
  container on a host dies simultaneously with no app-level error. Check
  `journalctl -u docker` first — a daemon-level crash (panic, OOM-killed
  dockerd itself, a corrupted internal DB) produces exactly this symptom
  and won't show up as a kernel-level OOM kill.
- **A same-basename `.lzx`/`.lha` pair is *never* safe to assume duplicate
  in this catalog** — confirmed again and again this session (43 + 8
  more genuinely distinct pairs, only 1 true duplicate out of 53 checked).
  Always diff member lists (or hash, for non-member formats like `.dms`)
  before merging or deleting anything based on a filename match.
- **`COLLATE NOCASE` lookups mean archive names must be globally unique
  case-insensitively**, not just per-folder. Any repack/rename/import that
  doesn't check this can silently make two distinct doors ambiguous to
  every single-door API route. This should probably become an actual
  `UNIQUE` constraint or an admin-facing validation at some point — it
  isn't one today, and this session found 79 catalog rows that had already
  violated it before any code enforced it.
- **The Docker BuildKit cache on this specific Hetzner host is fragile**
  under interrupted builds (a flaky `apk add` mid-build was enough to
  corrupt it). If a future deploy fails with a `buildkit`/`bbolt`-flavored
  error or every container on the host mysteriously restarts together,
  this is very likely the same failure mode — go straight to `journalctl
  -u docker` and the `cache.db` fix above rather than re-diagnosing from
  scratch.

## Artifacts

- This handoff.
- `db-backups/` (gitignored, local + on the VPS at `/root/db-backups/`) —
  every DB snapshot and archive-file backup taken during tonight's catalog
  surgery. Safe to delete once you're confident nothing needs rolling
  back, but not urgent — it's excluded from git and disk space on this
  machine isn't currently under pressure (freed from 402MB to ~9GB earlier
  this session via cache cleanup).
- Prior handoff this one supersedes for the `.lzx` topic:
  `2026-08-31_bulk-edit-plan-and-session-summary.md`.

## Next Steps (ordered, all low-priority — nothing blocking)

1. **Manual browser verification**, if not already done live during this
   session (most of it was, and found the bugs listed above — but a full
   pass through the plan's Task 9/10/11/12/13 manual-verification steps
   against the live site is still worth doing once, cold, without
   knowing what to expect).
2. **The full expandable per-archive failure list** the original spec
   described (Finding 3 from the final review) was deliberately scoped
   down to a flat "N succeeded, M failed" summary. If per-archive error
   detail turns out to matter in practice, that's a real, separate,
   small follow-up feature — the data is already served by `GET
   /admin/jobs/:id`'s `items[].error`, nothing new needed server-side.
3. **`fields=archiveName` doesn't apply the `name_source` ("Needs a
   name") filter** — a known, narrow limitation (the final review's
   Finding 2 fix just hides the "select all matching" button under that
   filter rather than fixing the underlying derivation). A real fix
   would need the lightweight endpoint to run the same expensive
   post-fetch name-source derivation the main paginated listing does.
4. **`openDb()` sets no `journal_mode=WAL`/`busy_timeout`** — noted
   during the bulk-edit review as the reason a transient `SQLITE_BUSY`
   was plausible under concurrent job writes. Not urgent now that the
   job runner has proper failure handling (Finding 1's fix), but still
   worth doing as defense-in-depth.
5. **Submitted/Phantasm `requires_bbs` backlog** — carried over,
   untouched this session (see the prior handoff for details; still
   large, still needs a new signal source or manual curation).

## Other Notes

- `.env` and `logs/dev-server.log` remain untracked, present since before
  this session, not created or touched by it (same note as every prior
  handoff — still true).
- This session ran the bulk-edit plan almost entirely through
  `superpowers:subagent-driven-development` — every task had its own
  fresh implementer + independent reviewer, several went through fix
  rounds, and the final whole-branch review ran on the most capable
  available model. That process caught real, non-obvious bugs (the two
  preflight rulings, the job-runner rejection handler, the lying
  select-all count) that a single pass almost certainly would have missed.
