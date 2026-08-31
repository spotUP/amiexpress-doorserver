---
date: 2026-08-31
topic: Bulk-edit feature ready to implement + this session's data-quality/bug-fix work
tags: [bulk-edit, admin, requires-bbs, lzx, repack-lzx, amigaguide, batch-jobs]
status: final
---

# Session handoff: bulk-edit plan ready, plus a full session of data/bug fixes

## Task(s)

**Primary, not yet started:** Implement the bulk-edit feature for the admin
door table. Full spec + 13-task TDD implementation plan already written and
committed — see Critical References. **This is the actual ask for the next
session**: open the plan, pick an execution mode (subagent-driven or inline,
per the plan's own execution-handoff prompt at its end), and work through
the 13 tasks in order.

**Secondary, everything else below:** a long session of data-quality fixes
and real bugs found/fixed in the door corpus and its curation tooling,
already shipped and live. Documented here for context and because two of
them left genuine open threads (see Next Steps #2, #3).

## Critical References

- **Spec:** `docs/superpowers/specs/2026-08-31-bulk-edit-design.md` — read
  this first for the *why* (problem statement, what's in/out of scope).
- **Plan:** `docs/superpowers/plans/2026-08-31-bulk-edit.md` — read this
  for the *how* (13 tasks, each with failing-test-first steps, exact code,
  exact file paths). Has its own "Global Constraints" section (batch-delete
  cap/confirm, job sequentiality, etc.) that applies to every task.
  **Two things already caught and fixed in the spec during brainstorming,
  both worth re-reading before starting Task 4 and Task 6/7:**
  - `DELETE /doors/:archiveName` (`src/admin-routes.ts:590`) is a **soft
    hide**, not a real delete — there is no existing permanent-delete route
    anywhere to mirror. Task 4 defines real delete semantics from scratch
    (5 `catalog_id`-keyed tables + `door_not_junk` + the row + the file).
  - Batch strip is a **two-phase** flow (preview → admin review/deselect →
    apply), not one fire-and-forget job — a one-shot "strip whatever each
    archive's classifier flags" would defeat the exact safety net the
    single-door strip-preview/strip flow exists for (see Learnings below,
    the `ami-stripper.ts` "*" incident).
- **Deploy:** `git push` → GitHub Actions `Deploy door server` workflow.
  Confirm with `gh run watch <run-id> --exit-status`, then
  `curl https://doors.uprough.net/api/door-repo/health`. The live container
  loses its `sqlite3` CLI on every redeploy/recreate (baked-in `lha`/`unlzx`
  survive, `sqlite3` doesn't) — reinstall with
  `ssh root@doors.uprough.net "docker exec doorserver-doorserver-1 apk add --no-cache sqlite"`
  whenever you need to query the live DB directly.
- **DB push pattern used all session:** never swap the whole `data/doors.db`
  file to live (risks clobbering independent live edits). Generate targeted
  `INSERT ... ON CONFLICT` / `UPDATE` SQL from the local DB, `scp` it,
  `docker cp` into the container, `sqlite3 /data/doors.db '.read /tmp/x.sql'`.
  See any commit below for the exact incantation if needed again.

## Recent Changes (this session, chronological, all shipped + live)

1. **`a58f997` fix(strip):** a bare `"*"` learned junk pattern would flag
   every file in every future archive as junk — `analyzeArchive()` merged
   DB-learned patterns without the same match-everything filter the seed
   JSON already had. Fixed with a shared `isMatchAllGlob()` guard at both
   write time (both `/learn` routes — the public DOORMAN one had *no* guard
   at all) and read time.
2. **`d88e553` fix(submissions):** `deriveMetadata()` silently returned
   empty metadata for `.lzx` archives — the `kind==='lha'/'zip'` ternary had
   no `.lzx` branch, even though `sniffArchive()` correctly detects it and
   `readLzxContents()` already exists. Found while re-extracting 42 doors
   with broken `archive_path` (see below) — most of them were `.lzx`.
3. **`e115bf3` + `c98023c` + `f34fd21` fix(requires-bbs), three commits:**
   - Merged `/X` and `AmiExpress` into one bare `"AmiExpress"` value (same
     BBS, was fragmenting the filter into `/X 3.x`, `/X 2.x`, `AmiExpress
     4.x`, etc. — 751 rows collapsed).
   - Added a bare-BBS-mention fallback (`BARE_BBS_RE` in
     `src/describe.ts`) for descriptions/DIZs that name a BBS with **no
     version number** ("for AmiExpress", "for /X") — the versioned regex
     alone missed almost all of these. Backfilled 2069 previously-empty
     `requires_bbs` rows (scoped to only-currently-empty, never overwrote
     an existing value — a full unconditional re-derive would have wrongly
     changed 138 rows and flip-flopped 32 more on real ambiguity, checked
     before deciding this).
   - Dropped the version suffix for **every** BBS name (not just
     AmiExpress) and renamed the canonical `S!X` label to **`System-X`**
     (S!X is the door-file-naming convention; System-X is the real BBS
     name). Backfilled 98 `S!X`→`System-X` + 181 `DayDream ...`→`DayDream`
     + 208 `FAME ...`→`FAME` + 43 `CNet ...`→`CNet`.
   - Current live `requires_bbs` facet: `AmiExpress 2502, FAME 208,
     DayDream 181, System-X 98, Mystic 87, Tempest 58, CNet 43, Oblivion
     22, Aquila 6, Impulse 1`.
4. **`f5551df` + `5684706` feat/refactor(demozoo):** extracted the
   tag→BBS and group-name→BBS inference out of `scripts/demozoo-import.ts`
   into a new shared `src/demozoo-bbs.ts` (decoupled from the
   `DemozooDetail` interface — takes `tags: string[]`/`groupName: string`
   directly), then added `scripts/backfill-requires-from-demozoo.ts`,
   which reuses it against already-catalogued rows that have a
   `demozoo_url` but were never run through this inference (the
   sync/CSV-import paths that *attach* `demozoo_url` never called it, only
   fresh imports did). Backfilled 261 rows, 0 errors, live.
5. **Two real bugs found and fixed in `src/repack-lzx.ts`** while chasing a
   user-reported "GNT-ACT3.LZX can't be stripped" bug:
   - **`7acc942`:** it built its `lha c` invocation as a raw shell string
     (`sh -c "lha c ... <filenames>"`), escaping only double-quotes. A
     1990s Amiga filename can contain almost any byte — a backtick or
     `$(...)` corrupts the command or executes as a substitution. Fixed by
     calling `lha` directly via `spawnSync` with an argv array (no shell).
   - **`6f96bf7`:** even after that fix, a filename starting with `-`
     (`-BRD-.TXT`, a real member of `AHEVSTAT.LZX` and a dozen others) gets
     read by `lha`'s own argument parser as an option flag. Same guard
     `src/lha-member-delete.ts` already applies for the same binary
     (`m.startsWith('-') ? './'+m : m`), now applied here too.
   - Repacked 33 genuinely-standalone `.lzx` archives to `.lha` on
     **live only** (see Learnings — this did not touch the local dev
     mirror). 70 `.lzx`-named catalog rows remain — see Next Steps #2, this
     is a real open thread, not "still to do the same thing again."
6. **`03dc94d` fix(guide):** the web AmigaGuide viewer (`GuideView.tsx`)
   rendered raw, unprocessed node content — literal `@{"text" link
   target}` markup, `@{b}`/`@{i}` tags, all untouched. The stripping logic
   already existed (`AmigaGuideParser.processInlineFormatting`) but was
   only wired into `renderNode()`, an ANSI-terminal rendering path with no
   caller anywhere in this repo. Added `stripInlineMarkup()` as new,
   separate logic (deliberately did not touch
   `processInlineFormatting()`/`renderNode()` — those are ported verbatim
   from `amiexpress-web` per the file's own "keep the two in step" header
   comment, for a real terminal consumer neither of them has here).
7. **`e3cedaf` + `1380d6c` + `95d8474` docs:** the bulk-edit spec (with one
   correction mid-review) and implementation plan — see Critical
   References.

Earlier in the session (before this handoff's scope, already handed off in
`2026-08-31_diz-sweep-complete-and-ui-cleanup.md`): fixed 42 doors with a
broken `archive_path` (`Archives/AmiExpress/...`, `Conf2/Upload/...`
prefixes that didn't resolve on disk — confirmed live 404s), which is what
first surfaced the `.lzx` metadata bug in point 2 above.

## Learnings

- **A same-basename-different-extension pair is NOT necessarily the same
  door.** While investigating GNT-ACT3.LZX (reported: "can't be stripped —
  no LZX writer exists"), found the same door apparently already existed
  as `GNT-ACT3.LHA` in the same folder — looked like a stale duplicate left
  over from an earlier repack. **It wasn't.** `diff`-ing the extracted
  contents showed genuinely different files (different DIZ, different
  member lists — `ZOOACTIVITY300.LZX` nested inside the `.LHA` one, ad-
  randomizer junk in the `.LZX` one). Two unrelated releases that happen to
  share a filename. **Do not assume the 70 remaining `.lzx`-named rows with
  a same-basename `.LHA`/`.lha` sibling are safe to delete/merge without
  checking each pair's actual content** — see Next Steps #2.
- **The local dev DB/archives mirror can silently diverge from live.**
  The 33-archive LZX repack this session ran directly against the live
  container (via a script copied in over SSH, since that's where the real,
  current archive files live — the local mirror had already been shown
  earlier this session to differ from live for some files). This was never
  mirrored back to local: **local `data/doors.db` currently still shows
  103 `.lzx`-named rows; live shows 70.** Everything else (the
  `requires_bbs` work) *was* kept in sync both ways and verified matching
  (confirmed again while writing this handoff). If a fresh session touches
  anything archive-file-related, verify against live directly, don't trust
  local.
- **`DELETE /doors/:archiveName` is a soft hide**, not a real delete —
  easy to misread from the route name alone (this session did, initially,
  while researching the bulk-edit spec, and had to correct it). No
  permanent-delete exists anywhere in this codebase today.
- **The batch-hide/batch-restore/batch-patch response shape
  (`{ ok: true, results: { archiveName, ok, error? }[] }`) is the
  established convention** — the bulk-edit plan follows it exactly for
  every new batch route rather than inventing a different shape.
- **`sqlite3` is not baked into the container image**; `lha`/`unlzx` are.
  `apk add --no-cache sqlite` every time you need it after a
  redeploy/restart, every session so far has needed this at least once.

## Artifacts

- `docs/superpowers/specs/2026-08-31-bulk-edit-design.md` — the design.
- `docs/superpowers/plans/2026-08-31-bulk-edit.md` — the implementation
  plan, 13 tasks, ready to execute.
- This handoff.
- Earlier handoff covering the session's first half:
  `thoughts/shared/handoffs/2026-08-31_diz-sweep-complete-and-ui-cleanup.md`.

## Next Steps (ordered)

1. **Implement the bulk-edit plan.** Open
   `docs/superpowers/plans/2026-08-31-bulk-edit.md`, start at Task 1. The
   plan's own final section offers subagent-driven vs. inline execution —
   ask the user which, same as this session did before running out of
   turns to start it.
2. **The 70 remaining `.lzx`-named catalog rows** (`SELECT count(*) FROM
   door_catalog WHERE archive_name LIKE '%.lzx'` on live = 70 as of this
   handoff) each share a base filename with an existing `.LHA`/`.lha` row.
   Given the GNT-ACT3 discovery above, **do not bulk-repack or bulk-delete
   these** — for each pair, extract both (`unlzx`/`lha xq` into separate
   temp dirs) and `diff -rq` before deciding anything. Some may be genuine
   stale duplicates from an incomplete earlier repack pass (safe to
   dedupe); some may be unrelated releases sharing a name (both entries
   are real, maybe one needs renaming to disambiguate rather than
   deleting). No count of "how many of each" is known yet.
3. **Submitted/Phantasm `requires_bbs` backlog is still large.** As of
   this handoff: Submitted 668/1604 filled (936 still empty), Phantasm
   450/987 filled (537 still empty). Two backfill passes already ran
   (bare-mention regex, demozoo-tags) and are exhausted for now — closing
   more of this gap needs either a new signal source or manual curation,
   not a third pass of the same two approaches.
4. **Top Authors residual noise** (flagged earlier this session, not
   reinvestigated): a handful of names in the Top Authors stat turned out
   to be 2-3 distinct causes on inspection (handle truncation, DIZ-banner-
   vs-real-coder confusion, one unexplained non-DIZ source) rather than a
   clean "add to `release_groups`" fix. Low priority; see the session's
   first-half handoff for the specific names and what was found.

## Other Notes

- `.env` and `logs/dev-server.log` are untracked in the working tree,
  present since before this session, not created or touched by it.
- Every commit in "Recent Changes" above shipped with its own regression
  test (fail-before-fix, pass-after, confirmed by literally reverting and
  re-running for each one this session) — `npm run test:ci` was green
  (342 passing) before every push.
