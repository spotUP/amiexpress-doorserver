---
date: 2026-09-09
topic: Separate releases DB + API from AquaScan BBS file listing
tags: [releases, filelist, aquascan, parser, api, describe]
status: draft
---

# Releases DB + API from `BBS_filelist (1).txt`

## 1. Source facts (measured 2026-09-09)

- File: `/Users/spot/Downloads/BBS_filelist (1).txt`, 179 MB, 2,413,857 lines, UTF-8.
- Header (AquaScan banner + dir index table) already removed by owner; file starts at dir 1.
- **299,437 `[ File #N ]` entries**, ~68 `Scanning dir N from top... Ok!` markers for 66 dirs
  (extra markers = All/Upload/Hold passes — parser must tolerate `N > 66` and repeats).
- Entry grammar (stable 1988 → 2026):
  ```
  ornament date line:  ¸,ø*... 12-12-88        (duplicates entry date, parse entry line only)
  [ File #N ]  +  ·===· border
  FILENAME  FLAG  SIZE  DATE  first-desc-words...
    continuation lines (leading spaces, same paragraph)
  [ End of File List ]                          (per dir, then prompts + next Scanning dir)
  ```
- Flags observed: `P` 245,037 / `N` 23,517 / `D` 6,177 / `F` 12 / `O` 9. **Meanings unconfirmed** —
  guess P=public, N=new, D=deleted/hidden; F/O unknown. Owner to confirm; stored raw regardless.
- Date on entry line is `MM-DD-YY`; == ornament date (spot-checked). Century pivot needed
  (`20xx` dir exists; assume YY >= 80 → 19YY else 20YY — owner to confirm).
- Descriptions are three shapes, all already handled by `contract/describe.ts`:
  1. single-line prose (`Better Dead than Alien! Kool game!`),
  2. wrapped multi-line prose (`Double Dragon - Just like the arcade! / Graphics could be...`),
  3. inline ASCII-art DIZ (`Prism2v2.Device for WiFi! Updated December 2019`,
     `HACKER 100% (With NTSC intro-fix)`, full box art like AMIX520).
- Dir → board/year mapping lived ONLY in the removed header table. Reconstructed below
  from the pre-removal read — **owner must verify**, then it ships as a committed seed.

## 2. Dir context — DROPPED per owner (only releases matter)

No board/year columns. The removed header table was the only board/year source, and the
owner confirmed it is not needed. Store `dir_no` + `file_no` for identity only; extra
`Scanning dir` markers past #66 (All/Upload/Hold passes) are tolerated by the parser.
(Reference: reconstructed table lived here in draft v1; deleted 2026-09-09.)

## 2b. Flags + dates (owner answers 2026-09-09 + own research)

- AmiExpress E sources contain NO AquaScan flag definitions (third-party door; only two
  passing mentions: `axcommon.e:315`, `deployment/read_me.txt:35`). Semantics below are
  measured from the data itself:
  - `D` = **deleted/nuked** (6,177). Size field carries the reason instead of bytes:
    `>NUKED<` 2,683 / `DELETED` 1,507 / `------` 343 / `>>OLD<<` 274 / `>DUPE<` 108 /
    `*LAME!*` 111 / `RENAMED` 330 / `ONLINE!`, `OFFLINE`, `AMINET`, `*DUPE!*`,
    `*FAKE!*`, `>FAKE<`, `>Nuked<`, `nUKED!!`, `CORRUPT`, `VIRUS`, … (full histogram
    in P1 test). Only ~20 D rows have a real byte size.
  - `F` = 12 rows, normal sizes — almost certainly caller-flagged for download
    (transcript menu: `(F/R) Flag`). Store raw.
  - `O` = 9 rows, size always `CORRUPT` — unknown, store raw.
  - `N` (23,517) vs `P` (245,037): same year spread (both peak 1995–1997), so NOT
    session-relative newness; per-file stored attribute, meaning unconfirmed. Store raw,
    document as unconfirmed. (`d/L tIMES:` download counters exist only on newer entries;
    no N/P correlation found — 10 N vs 13,232 P rows carry one.)
- Date `MM-DD-YY`, century pivot approved: **YY≥80 → 19YY else 20YY** → `date_iso`.
- `BBS_files_2026.txt` (4,319 entries) is a subset of the main file (spot-checked
  `BK-SE852.NFO`; main file ends 09-09-26 with the same session transcript) → **main
  file only**; P1 asserts every 2026-file entry exists in main.

## 3. Architecture (never mixed with doors)

- **New database file** `releases.db` beside `doors.db` (own env `RELEASES_DB`, own volume
  path on the VPS). Same `better-sqlite3` + migration-runner pattern, own migration array.
  Zero shared tables; `doors.db` untouched (test asserts its table list unchanged).
- **New table** `release_files`: `id, dir_no, file_no, filename, flag, size_bytes
  (NULL when the size field holds a nuke reason), size_note (the raw reason),
  date_iso, description, version, author, raw_desc` (+ `release_files_fts` if
  we want search; decide in P2).
- **Importer** `scripts/import-bbs-filelist.ts`: streaming line state-machine (never loads
  179 MB), per-entry `analyseDoor({ dizText: joined desc lines, ... })` for
  description/version/author + entry-line date → `date_iso`. Corpus group tags: derive from
  release filenames themselves (same `buildGroupTags` rule), NOT from doors.
- **New API surface** `/releases/v1` (own router, own contract `contract/release-types.ts`):
  `GET /health`, `GET /list` (paged, `?q=&board=&year=&flag=`), `GET /files/<id>`,
  plus `.txt` house format for 68K clients. Read-only. No CORS (same reason as achievements:
  no browser keys; plain list is public but keep policy explicit in plan review).
- **No changes to `contract/describe.ts` behaviour for doors.** If BBS-listing quirks need
  rules (e.g. `WRP`/`ARC` tokens, `Disk 2 part 1` metadata, `[r...-tool]` stamps), they land
  as additive, fixture-pinned cases with a contract bump — same process as always.

## 4. Phases

- [x] P0 — Streaming parser `src/releases/parse.ts` (fixed columns + flagless +
      `[DELETED]` fallbacks, dl/uploader metadata, ornament/prompts skipped) (1/8)
- [x] P1 — Counts test: 299,437 entries, 0 anomalies, histogram P 264866/N 24591/
      D 6189/-/3766/F 15/O 10, 2026-file fully contained in main (2/8)
- [x] P2 — `releases.db` (config/schema/migrations, second-DB pattern) +
      `scripts/import-bbs-filelist.ts`; scratch import 299,437/299,437 rows (3/8)
- [x] P3 — Quality audit: 99.94% with description, versions 140k, authors 49k,
      dl 30k, uploaders 6k. Found + fixed: dir 66 captured twice with reused
      numbers → key is (dir_no, file_no, filename) (4/8)
- [x] P4 — `/releases/v1` router + `contract/release-types.ts` + `.txt` +
      `docs/RELEASES-API.md`, verified against all 299,437 rows (5/8)
- [x] P5 — `typecheck` + `test:ci` green (663 passed); also fixed 3 pre-existing
      stale expectations (capitalization) found failing on clean HEAD (6/8)
- [x] P6 — Deployed: compose defaults `RELEASES_DB=/data/releases.db` (no secret
      needed; empty DB serves empty listing), rebuilt, healthy (7/8)
- [x] P7 — Imported live: file scp'd to host, 299,437/299,437 rows; health
      `r299437-t299437`; spot-checks pass. Known notes: same filename in several
      dirs = separate rows (correct); no-binary-name rows can keep a `Prog .`
      prefix the doors pipeline strips (no binary names in a listing — accepted).
      (8/8)

## 5. Owner answers (2026-09-09 — all resolved)

1. Dir mapping: SKIPPED — releases only, no board/year.
2. Flags: settled in §2b from data (sources have nothing); N/P stored raw, unconfirmed.
3. Century pivot: YY≥80 → 19YY else 20YY. Approved.
4. `BBS_files_2026.txt`: subset of main file → main file only.
5. API: `/releases/v1` + `.txt`. Approved.

Ready to build on your go.
