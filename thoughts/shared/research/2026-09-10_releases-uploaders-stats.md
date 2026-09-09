---
date: 2026-09-10
topic: BBS-files uploader extraction + releases stats
tags: [releases, parser, stats]
status: final
---

# BBS Files uploaders + stats: corpus measurements

Source: `/Users/spot/Downloads/BBS_filelist (1).txt`, 299,437 entries.
Scripts: `/var/folders/w6/hc_wf7v94_dcn98mmjb_k9fh0000gn/T/opencode/mine-uploaders{,2}.ts`
(existing `uploader` = chevron `Name >>note<<` trailer, `src/releases/parse.ts:79,265`).

## Hardest truth first

**The last line is usually NOT the uploader.** It is usually scene art:
courier-credit fills (`[---( CASE )---]`, 4,303x), group/greet chains
(`.:[ cQT :.: MsT ... ]:.`, `[-fAShbACk!-]¼[-sCX-]...`), board ads,
`crusader&candyman` sigs. The `[-nick-]` bracket runs (39,721 last-lines,
13.3%) are courier/greet credits — minting "uploaders" from them would be
false data. Only the small explicit subset below is reliable.

## Reliable uploader signals (combined ~3.1%, ~9.4k entries)

| pattern (full-line, anchored) | entries | last-line? |
|---|---|---|
| `Name >>note<<` (already extracted) | 6,044 (2.0%) | no (any line, first wins) |
| `Sent by[:]? X` | 1,031 (0.34%) | 957/1,031 yes |
| `Uploader: X` (90s email headers) | 738 (0.25%) | 19 — top-of-block, NOT last |
| `Smashed by[:]? X` | 599 (0.20%) | 502 yes |
| `Uploaded by[:]? X` | 539 (0.18%) | 177 |
| `* upload by X` (e.g. "Another Graff-tastic upload by Graffito") | 295 | 280 yes |
| `Brought [to you] by X` | 105 | 23 |
| `Supplied by X` | 72 | 34 |
| `Courier:` / `Sysop:` | tiny + role-ambiguous | — |

Overlap explicit-vs-chevron: 29 entries. `anyExplicitLine` total: 3,350 (1.1%).

## Value noise (top samples)

Clean handles (`AMON` 135, `SiDeSaLaD` 57, `Graffito` 265) mix with
decorated (`*** BLUEBEARD ***`, `-----[ EddiE ]-----`), suffixed
(`sHANE/CRUX!`, `DELTAFORCE/DLM`), sentences
(`gHANDY oF gODS & pROGRESS iN 1995 !`), trailing junk
(`Belø\X/ 0`, `I-Man/RAGE --`). Needs light normalization only:
trim + strip one layer of symmetric wrapping (`* - [ ] ( ) " '`),
collapse whitespace. Leave `!` and case alone (stylized nicks).

## Decisions for the plan

1. Extract (in order): sent / uploaded / smashed / supplied / brought /
   `upload by X` / `uploader:` / chevron. Skip courier/sysop (ambiguous).
2. Strip matched lines from desc+rawDesc (contract already promises
   "uploader trailers are parsed into their own columns, not repeated here").
3. `GET /releases/v1/stats`: total, withUploader, byFlag, byGroup(20),
   byUploader(20), byAuthor(20), sizeDistribution (+nuked bucket),
   overTime (YYYY-MM). No byDir (numbers aren't names).
4. Frontend: `ReleaseStatsPanel` mirroring `Stats.tsx`; Stats button in
   Browse becomes mode-aware. Uploader chart labeled with coverage
   ("names an uploader on X% of entries").
5. No schema change (`uploader` column exists). Backfill = reimport
   (upsert on `(dir_no, file_no, filename)`); live `/data/releases.db`
   needs a manual rerun on the host — deploy does NOT do this.

## Follow-up 2026-09-10: facts page + pre-existing `>` bug (both shipped)

- Chevron regex also matched art titles (`>>>>> -+- Beast -+- <<<<<`):
  1,119 entries carried uploader `">"`. Fixed (name may not start with
  `>`/`<`), chevron path routed through normalizeUploader. Coverage now
  an honest 8,267 (2.76%).
- `GET /releases/v1/facts`, validated against a scratch DB built from the
  real 179 MB file (query ~1s): firstDiz = `SLT!RX10.LZX` 1989-12-18
  (agrees with line-shape analysis); span 1988-01-01 (`DMCS.WRP`) to
  2038-08-10 (`VGS-MIND.LHA`, capture typo, surfaced as futureCount=1);
  peak 1996 (84,270) / 1996-01 (8,616); LHA overtook DMS in 1994;
  Sunday busiest (52,786 vs Friday 38,506); biggest `UNS-8Bit.lha`
  78 MB (2011); longest desc `HF-SCD0.LHA` 6,781 chars/88 lines;
  most downloaded `FDRD015R.ZIP` 34 d/L; median size 130,542 bytes.
- Gotcha fixed en route: SQL `LIKE '%____%'` matches EVERYTHING (`_`
  is a wildcard) — must be `LIKE '%\_\_\_\_%' ESCAPE '\'` with doubled
  backslashes through the TS template literal (same for the ESCAPE
  literal itself; a backtick inside a `--` comment also broke parsing).
- Full `test:ci`: 689 passed + 1 pre-existing skip; one unrelated flake
  (`tests/achievements/rarity-floor.test.ts` fails in full runs, passes
  alone, untouched by this work).
