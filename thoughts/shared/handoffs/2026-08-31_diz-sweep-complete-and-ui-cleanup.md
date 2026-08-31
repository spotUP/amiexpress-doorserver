---
date: 2026-08-31
topic: DIZ-extraction sweep completion + catalog UI/stats cleanup
tags: [diz-extraction, requires-bbs, stats, top-authors, ads-stripped, deploy]
status: final
---

# Session handoff: DIZ-extraction sweep complete, five UI/data-quality fixes shipped

## Task(s)

1. **Finish the autonomous DIZ-extraction sweep** started in a prior (compacted)
   session: for every door lacking a manual description edit, extract
   name/description/version/author/releaseGroup/requiresBbs from its
   FILE_ID.DIZ (or extracted doc text) via a `Workflow` pilot script, apply
   locally, push to the live DB, repeat until the candidate queue is empty.
   **Status: DONE.** True-remaining candidate count is 0 (query below).

2. **Four UI/data-quality bugs the user spotted from screenshots** of the live
   site, root-caused and fixed one at a time. **Status: all shipped and live.**

3. **A fifth bug the user found just as this handoff was being written**:
   `TON-VCV1.LHA` has no usable description even though its `file_id_diz` is
   clear. **Status: root-caused, NOT fixed — scoped as next-session work
   below.** This is a genuinely different bug from #1: the sweep's `WHERE`
   clause only picked up rows where `description` was NULL/empty, but this
   row's `description` is 130 chars of garbage banner-art text, not empty —
   so the sweep correctly skipped it by its own logic, and never should have
   left garbage there in the first place. See "Next Steps" for the query that
   finds the ~30 highest-confidence sibling rows.

## Critical References

- `scripts/apply-diz-extraction.ts` — applies one round's JSON of
  `{id, name, description, version, author, releaseGroup, requiresBbs,
  confidence}` objects to `door_catalog`, and unconditionally writes an
  `admin_audit` row with `detail LIKE '%diz-extraction-workflow%'` per
  archive **even when nothing was touched** (this is what makes the
  candidate query idempotent across re-runs — see the `apply-diz` audit-log
  fix that had been sitting uncommitted since the prior session; it's
  committed now, see Recent Changes).
- Candidate-generation query (the one to re-run for the DIZ sweep, or adapt
  for the garbage-description sweep — see Next Steps):
  ```sql
  SELECT dc.id, dc.archive_name, dc.file_id_diz, dc.doc_raw
  FROM door_catalog dc
  WHERE dc.file_id_diz IS NOT NULL AND trim(dc.file_id_diz) != ''
  AND (dc.description IS NULL OR trim(dc.description) = '')
  AND dc.id NOT IN (
    SELECT catalog_id FROM door_catalog_overrides WHERE field = 'description'
  )
  AND dc.id NOT IN (
    SELECT target FROM admin_audit WHERE detail LIKE '%diz-extraction-workflow%'
  )
  ORDER BY dc.id
  ```
  Confirmed **0 rows** as of this handoff.
- Workflow script used for every round (read-only, don't need to touch it
  again unless the extraction prompt itself needs changing):
  `diz-extract-pilot-wf_06b1eed6-016.js` (session-scoped path, will not exist
  in a fresh session — re-author from scratch or find the nearest prior
  `Workflow` script referenced in git history / thoughts if reusing the
  pattern).
- `src/describe.ts:438` — `normaliseRequirement()`, the BBS-version-string
  canonicalizer (just patched, see below).
- `src/public-routes.ts` — `/facets` (line ~445) and `/stats` (line ~479) routes;
  both now have the fixes described below.
- `release_groups` table (675 rows, `abbreviation` → `full_name`) — the
  curated group-name lookup now used to filter the Top Authors stat. **Not
  exhaustive** — several real groups (Noisy, Splash, PHUN, Quantum) aren't in
  it and still leak into Top Authors. If asked to improve this further, that
  table is the right place to add rows, not a code-level blocklist.
- `door_catalog.ads_stripped` (0 = needs review, 1 = reviewed/stripped) —
  5560 rows still need review vs 372 done, as of this handoff.
- Deploy is `git push` → GitHub Actions `Deploy door server` workflow (Docker
  build, SSH to `doors.uprough.net`, container `doorserver-doorserver-1`).
  Health check: `curl https://doors.uprough.net/api/door-repo/health`.
  Confirm every deploy with `gh run watch <run-id> --exit-status`, not just
  "it pushed" — this was a hard-won lesson in an earlier session (JWT-secret
  deploy-workflow bug, see `2026-08-30-session-end.md`).

## Recent Changes (this session, chronological)

1. **DIZ-extraction rounds 46–59** (continuing from a prior session's
   round 45): each round was 30 candidates (3 batches of 10) run through the
   `Workflow` tool, applied via `apply-diz-extraction.ts`, pushed to the live
   SQLite DB (WAL-checkpoint → scp → integrity-check → container
   stop/swap/start → health-check), then the candidate queue was regenerated
   and the loop repeated. Queue went 419 → 0 over these 14 rounds. Two
   transient `Workflow` launch failures from malformed JSON in the `args`
   payload (my own typos) were caught and retried within the same round.
   A handful of pure-ANSI-art DIZ fields (no readable text) were paraphrased
   as `"ANSI decorative art, no readable text"` instead of being extracted
   verbatim — flagged inline at the time, not silently done.

2. **`fix(requires-bbs)` — commit `8c3a3d3`**: `/X 3.x` and `/X 3.xx` (and
   siblings) showed as separate buckets in the "Any BBS version" filter/stat
   because `normaliseRequirement()` only lowercased `X`→`x`, never collapsed
   repeated-x wildcard runs. Patched the function (`X+` → `x`, regex now
   `/X+/gi`) for future imports, **and** ran a narrow 12-statement `UPDATE`
   against the 139 already-stored rows with a collapsible x-run (deliberately
   *not* the existing `scripts/backfill-requires.ts`, which re-derives the
   whole column from every DIZ unconditionally and would have touched 887
   rows with no way to know which were admin-corrected — no override table
   exists for `requires_bbs` the way `door_catalog_overrides` exists for
   `description`).
   Same commit also relabeled the "Any system"/"By System" facet from
   *system* to **"Any collection"/"By Collection"**: it was never a BBS
   platform, just `archive_path`'s top-level directory (`Submitted`,
   `Phantasm`, `Archives`, `Conf2` are staging/mirror folders, not door
   software) — confirmed via two parallel research subagents plus direct DB
   queries. The genuine "which BBS software" data already lives correctly in
   `requires_bbs`.
   Also folded in `scripts/apply-diz-extraction.ts`'s uncommitted audit-marker
   write (from the prior session — makes the script idempotent, see Critical
   References above).

3. **`fix(stats)` — commit `98c4c1b`**: "Top Authors" was dominated by
   release-group names (Food 121, Demonic Productions 59, Excessive Force
   Crew 39, etc.) — confirmed the DIZ credit convention in this corpus is
   overwhelmingly group credit ("coded by X" / "X Presents"), not individual
   attribution, and free text gives no structural way to tell a handle from a
   group name. Filtered the `byAuthor` stats query with
   `NOT EXISTS (SELECT 1 FROM release_groups rg WHERE rg.full_name = author
   COLLATE NOCASE)`. Confirmed live: those five names are gone from the
   top-10; **Noisy/Splash/PHUN/Quantum still show** (not in the lookup table
   — see Next Steps if asked to chase further).

4. **`fix(stats)` — commit `dab8343`**: the `/stats` API route has no auth
   check (always public) but the "Stats" button that opens `StatsPanel` was
   nested inside the `admin ? (...)` block in `Browse.tsx`, so signed-out
   visitors had no way to reach it. Moved the button next to "Send in a
   door", outside the conditional. `StatsPanel` itself never referenced
   `admin`/auth internally — it was just unreachable.

5. **`feat(browse)` — commit `e3e898d`**: "Strip Ads" (the ad-file
   preview/removal workflow) was only reachable by already knowing which
   door needed it, opening its detail dialog, clicking the admin-only Edit
   tab, then finding the button. Added a header toggle **"Needs ad review"**
   (mirrors the existing `guessedOnly`/"Needs a name" pattern exactly) that
   filters the browse list to `ads_stripped = 0`. New backend query param
   `unstripped=1` → real `WHERE ads_stripped = 0` clause (this one IS a
   stored column, unlike `name_source` which is derived and filtered in
   application code). The per-file review UI itself is unchanged and still
   lives in the Edit tab — it's inherently per-archive (preview candidate ad
   files, toggle selection, "learn this pattern", mark-not-junk, strip) and
   wasn't a good fit to relocate; only *discovery* of which door needs it is
   now top-level.

All five commits: typechecked (backend `npx tsc --noEmit`, frontend
`cd web && npx tsc --noEmit`), web bundle rebuilt (`cd web && npm run build`),
pushed individually, and **each deploy watched to completion**
(`gh run watch <id> --exit-status`) before moving to the next fix — all four
`Deploy door server` runs succeeded, live health checked green after each.

## Learnings

- **Don't push a whole DB-file swap when a targeted SQL patch will do.**
  Earlier rounds of the main DIZ sweep pushed the entire local
  `data/doors.db` to live (WAL-checkpoint → scp → swap). For a 26-row
  fix that carries real clobber risk if live picked up any independent
  admin edit since the local copy was last pulled — a full swap can't
  tell "live changed this row after I copied it" from "my copy is
  correct". Generated the exact `INSERT ... ON CONFLICT` statements for
  just the 26 `door_catalog_overrides` rows + their `admin_audit` rows
  instead, applied over SSH via `sqlite3` inside the container — same
  approach the release-group backfill used in the prior session. Row
  counts were compared before pushing (`door_catalog` 5932/5932 match,
  `door_catalog_overrides` diff was exactly the expected ~26) to confirm
  no drift either way.
- **`backfill-requires.ts` is not safe for a targeted fix.** Its own doc
  comment says "safe to re-run" and that's true for its *intended* purpose
  (bulk re-derive), but it blindly overwrites `requires_bbs` for every row
  from the DIZ with no override-awareness — 887 rows would have changed for
  what should have been a 139-row fix. When only a subset of rows need
  touching, write the narrow `UPDATE`, don't reach for the sledgehammer
  script just because it exists and claims to be safe.
- **A column being non-NULL doesn't mean it holds a real value.** The DIZ
  sweep's exclusion filter (`description IS NULL OR trim = ''`) is correct
  for finding *missing* descriptions, but it can't find *garbage*
  descriptions (banner-art fragments that got extracted by some earlier,
  cruder heuristic). These are two different bugs requiring two different
  detection queries.
- **`release_groups` (675 rows) is a useful but incomplete lookup.** Good
  for a clean, zero-risk exclusion filter; not exhaustive of every group
  name that appears organically in this corpus's own `author`/`release_group`
  columns. Cross-referencing against `door_catalog.release_group`'s own
  distinct values did NOT help extend coverage — that column stores
  different (usually abbreviated) forms than the full names leaking into
  `author`.
- **Confirm every deploy, don't assume push = live.** This project's CLAUDE.md
  rule ("Before iterating on a fix, confirm the previous fix deployed") was
  followed literally this session: `gh run watch` + live `curl`/facet-query
  checks after all 4 code deploys, not just after the DB-only pushes.

## Artifacts

- This handoff.
- No new `thoughts/shared/research/` or `thoughts/shared/plans/` docs this
  session — all fixes were small enough to root-cause and ship same-turn.
- No PR — direct pushes to `main` (pre-release project, standing permission
  per user's prior feedback to commit/push freely).

## Next Steps (ordered)

1. **Garbage-description sweep (the TON-VCV1.LHA bug). DONE 2026-08-31.**
   Ran the narrow verbatim-prefix query below: got 30 rows, hand-reviewed
   each DIZ. 5 were false positives (already-correct short descriptions
   that happen to equal the whole DIZ text — `iurem`, `mst_fr10`,
   `t_enigma`, `thrashtp`, `tstat` — left untouched). The other 25, plus
   `ton_vcv1` itself (confirmed NOT actually matched by this query — its
   garbage fragment starts mid-DIZ after a banner header, not at offset 0,
   so the "verbatim prefix" heuristic has a blind spot for garbage that
   isn't anchored at the start; only caught it because the user had
   already named it), got real name+description extracted from their DIZ
   text and applied as `name`/`description` overrides (52 fields, 26
   rows) via `apply-diz-extraction.ts` locally, then pushed directly to
   the live container as raw `INSERT ... ON CONFLICT` SQL (not a full
   DB-file swap — see Learnings) after reinstalling `sqlite3` in the
   container (`apk add --no-cache sqlite`, lost again on next container
   recreate, same as the prior session's note). Verified live via
   `/api/door-repo/doors/TON-VCV1.LHA` (now shows `"name":"VirusClean"`)
   and `PRAGMA integrity_check` (ok). `author`/`version`/`requiresBbs`/
   `releaseGroup` were deliberately left untouched on all 26 rows — those
   fields weren't garbage (base columns already had reasonable values),
   only `name`/`description` were.
   Did **not** widen the net beyond this query + the one manually-flagged
   exception — the ~2695-row fuzzy heuristic mentioned below is still
   unverified and untouched.
   Original query, for reference:
   ```sql
   SELECT id, archive_name, description, file_id_diz
   FROM door_catalog
   WHERE description IS NOT NULL AND trim(description) != ''
   AND file_id_diz IS NOT NULL AND trim(file_id_diz) != ''
   AND file_id_diz LIKE substr(description,1,40) || '%';
   ```
   This finds rows (30 as of this handoff, `ton_vcv1` among them) where
   `description` is a verbatim prefix of `file_id_diz` — i.e., some prior
   process took "the first N characters of the DIZ" as the description
   without checking whether that prefix was actual prose or ASCII-art
   banner. These are near-certain garbage. A looser letter-density heuristic
   suggested up to ~2695 rows might be low-quality, but that number is
   **not trustworthy** (the ratio calc was crude and likely has many false
   positives from legitimately terse/punctuated real descriptions) — don't
   quote it as a real count without redoing the heuristic properly first.
   Recommended approach: run the same `Workflow`-based extraction pattern
   used for the main sweep, but seed the candidate query with the 30
   verbatim-prefix rows first (cheap, high-confidence), verify results look
   right, THEN decide whether/how to widen the net for the fuzzier
   population.
2. **Top Authors residual noise — INVESTIGATED 2026-08-31, turned out NOT
   to be the clean "add to release_groups" fix originally assumed.**
   Checked each name's actual DIZ credit line:
   - `Noisy` → real handle is "Noisy Belch" (`bv`/`lgb_bo16`/`lgc_bb02` etc.,
     e.g. `"BelchVIEW v1.8b by Noisy Belch/LOGIC"`) — an individual scener,
     truncated by the author-extraction regex at the first word boundary.
     Not a group at all.
   - `Splash` → real handle, `"GlobalDupe 1.4 ... By Splash"`, world-release
     credited separately to group `MGS!` in the same banner. Not a group.
   - `PHUN` → genuinely a group banner ("PHoney Underground Nation") that
     got extracted as `author` instead of the real coder credited later in
     the same DIZ ("Code by Rex"). This one IS the group-leak bug.
   - `Quantum` → DIZ for this row (`q-clct_1.lha`, `q-daa_10.lha`) carries
     no credit line at all; where `author = 'Quantum'` actually came from
     is unclear (not the DIZ text) — unresolved.
   Conclusion: this is at least two, probably three, distinct root causes
   (handle-truncation regex bug, DIZ-banner-vs-real-coder confusion, and an
   unknown non-DIZ source for at least one name), not one lookup-table gap.
   Given the mixed causes, did **not** implement a fix — a real fix needs
   per-row triage of `author`'s actual provenance, not a `release_groups`
   INSERT. Left as-is; if revisited, start by checking whether `author` is
   ever populated from something other than `analyseDoor()`'s DIZ parse
   (e.g. a filename heuristic or demozoo import) for rows like `q-clct_1`.
   The junk single-character entries (`|`, `:`, `The`, `[tHE`) are a
   separate, still-unexamined regex bug in `AUTHOR_RE`/`splitBannerCredit`
   (`src/describe.ts` ~line 482) over-matching stray banner punctuation.
3. **`.env` and `logs/dev-server.log` are untracked** in the working tree
   (present at start of this session too, not created by me). Not committed,
   not touched — just flagging so a fresh session doesn't mistake them for
   new/unexplained files.

4. **New bug, reported but not investigated**: viewing/reading the file
   `INFINITE.IP` inside archive `SS_CD13.LHA` (catalog id `ss_cd13`, door
   name "CDDoor - A VERY configurable CD-Server") produced repeated browser
   console errors:
   ```
   GET https://doors.uprough.net/api/door-repo/events net::ERR_HTTP2_PROTOCOL_ERROR 200 (OK)
   ```
   `/api/door-repo/events` is a Server-Sent-Events endpoint
   (`src/public-routes.ts:709`, `subscribe(cfg, req, res)`) that the frontend
   opens via `new EventSource(...)` in `web/src/api/queries.ts:273` (backs
   `useLiveRevision()` — the mechanism that live-updates the catalog when
   another admin/curator changes something). `ERR_HTTP2_PROTOCOL_ERROR` on a
   long-lived streamed response under HTTP/2 is a known class of issue with
   reverse-proxy/HTTP2 handling of SSE (buffering, chunked-response framing).
   **Not yet established whether this is:**
   (a) a genuine bug in the file-viewer action for that specific file/archive
   that happens to also disrupt the SSE connection, or
   (b) an unrelated, pre-existing SSE/HTTP2 reconnect issue that was simply
   visible in the console at the time and has nothing to do with
   `INFINITE.IP` specifically.

   **INVESTIGATED 2026-08-31 — leans strongly toward (b), could not
   reproduce.**
   - The live archive's own member listing (`lha l SS_CD13.LHA`) shows
     `INFINITE.IP` as a genuine 0-byte member (ratio shows `******` —
     division-by-zero in `lha`'s own display for a zero-size file, not
     evidence of corruption beyond that).
   - Calling `extractFile()` directly against the real archive for this
     member returns instantly (2 ms, empty buffer) — no hang, no error.
     Rules out "this member's extraction blocks the event loop long enough
     to starve the SSE connection."
   - More importantly: **the public Files tab only lists 9 members, not
     10** — `INFINITE.IP` is silently dropped by the `lha.js` reader
     (`LHA.read()` in `src/archive-reader.ts:140`, likely because of its
     degenerate zero-length header) before `door_catalog_files` is ever
     populated (`src/admin-routes.ts:399-404`). There is **no "View
     contents" button for this file in the UI at all** — a user cannot
     click their way into viewing it through the file-viewer action. This
     substantially undercuts hypothesis (a): whatever the user saw, it
     wasn't a click on a "view `INFINITE.IP`" button, because that button
     doesn't exist.
   - Live-reproduction attempt: opened the door's detail dialog on the
     live site, cycled through About / Files / Guide tabs, and left an
     idle SSE connection open past its 25s keepalive interval (40s+
     wait). Console stayed clean throughout (`list_console_messages`
     returned nothing for `error`/`warn`); the single `/api/door-repo/events`
     connection (`reqid=7`) never reconnected or errored the whole time.
   - Conclusion: couldn't reproduce, and the one lead that could have
     explained it (this specific file's extraction) is ruled out. Most
     likely a one-off client/network-layer blip (Chrome's h2 connection
     churn, a mobile network handoff, a transient proxy hiccup) rather
     than a reproducible server bug. Not spending further time on it
     without a second occurrence to anchor on — if it recurs, the next
     useful data point would be the Caddy access/error log
     (`/etc/caddy/Caddyfile` on `doors.uprough.net`, bare
     `reverse_proxy 127.0.0.1:3010` with no explicit `flush_interval`)
     at the timestamp of the next occurrence, not more client-side
     guessing.
   `door_catalog_files` has no row for `INFINITE.IP` under `ss_cd13` (checked
   directly — table may simply not enumerate every member, or the file
   listing works from a different mechanism at view-time). Start here: (1)
   confirm whether the events endpoint errors ONLY when this specific file is
   opened, or continuously/independent of it — reload the page with dev
   tools open and watch for the same error absent any file-view action; (2)
   if the errors ARE isolated to viewing this file, check whatever route
   handles the file-content-view request (grep for the file-viewing endpoint
   used by `DoorDetail.tsx`'s file-view action — likely
   `/admin/doors/:archiveName/files/:path` per the pattern seen in
   `web/src/components/DoorDetail.tsx`'s `viewKeptFile`/similar code) for
   anything that could cascade into disrupting the SSE connection (e.g. a
   server-side error/crash-and-restart during that request); (3) if isolated
   reproduction fails, treat it as an SSE/HTTP2 infra issue independent of
   this file and investigate the reverse-proxy config in front of
   `doors.uprough.net` (buffering settings for streamed responses under h2).

## Other Notes

- Full round-by-round detail for the earlier part of the DIZ sweep (before
  round 46) lives only in this session's own prior-session summary /
  transcript, not restated here — if it's ever needed, the session's
  `.jsonl` transcript is the source of truth, not this handoff.
- User confirmed mid-session they want the sweep and fixes pushed without
  per-step review ("keep pushing through... no need to report", later "this
  has taken far too long... finish this now do the remaining ones in one
  sweep") — that urgency applied to the DIZ sweep specifically, not a
  standing instruction for future sessions to skip review on unrelated work.
