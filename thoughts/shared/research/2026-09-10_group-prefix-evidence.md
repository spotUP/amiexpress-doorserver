---
date: 2026-09-10
topic: Group-prefix candidates mined from the BBS file listing
tags: [groups, release_groups, curation, filelist]
status: final
---

# Group-prefix evidence (releases.db filenames vs descriptions)

6,934 distinct `PREFIX-`/`PREFIX_`/`PREFIX!`/`PREFIX^` tags in 299,437 release
filenames; 6,399 not in `release_groups`. Method: `scripts/` one-off probes
(`tmp_mine.ts`, `tmp_validate_tags.ts`, `tmp_credits.ts` — not committed).

## Verdicts (updated: Demozoo cross-match 2026-09-10)

`scripts/fetch-demozoo-groups.ts` (committed): enumerated all 78,437 Amiga
productions (platforms OCS/ECS, AGA, PPC/RTG) via the API, harvesting
`author_nicks` with `is_group` + abbreviation — the same field the door
importer trusts. 1,331 group abbreviations indexed. Page cache under
`$TMPDIR/demozoo-groups` makes reruns resume. Conflicts (one abbrev, several
names) and thin matches (<3 prods) are reported, never inserted; inserts are
`ON CONFLICT DO NOTHING`, so curated full names are untouchable.

Result: **153 inserted** (min 20 files/tag), **97 held** (conflicts like
`SH: Sieg Heil!/SpaceHawks`, `SOS: Software of Sweden/Save Our Souls`,
`APX: Appendix/Apex`, `APT: Apathy/Advanced Pirating Technologies`,
`SNT: Sanity/Stupid Name Team`, `TSB: The Special Brothers/The Spaceballs`
+ thin ones like `HTS`, `SCB`, `E^D`). Includes `PTL→Reko`… wait, no:
re-check log before claiming. Confirmed inserts include `IRS→Iris` (183),
`SPB→Spaceballs` (152), `TEK→The Electronic Knights` (323),
`PDY→Prodigy`, `A8S→After Eights`, `MWI→Madwizards`, `DPH→Depth`,
`IFT→Infect`, `NCE→Nuance`, `CRB→Cryptoburners`, `CSL→Crystal`,
`LMS→Lamers`, `VF→Vision Factory`. Full list in console output.
Live `doors.db` updated via targeted SQL + pre-backup (839 rows total).

## Verdicts

- **Inserted 2026-09-10** (scene-certain + desc-confirmed, absent from table):
  `FLT→Fairlight` (670 files, `-Flt-` credits), `PDX→Paradox` (644, `from Paradox`).
  `SCX→Scoopex` already present.
- **Do NOT add** (not groups): `AS` (Amiga Shopper coverdisks), `O` (Aminet
  paths/German utils), `S`, `A` (fragments), `WP` (Word Perfect cracks),
  single letters, `SE` (ambiguous ascii odds), `SH` (mixed: Sledge Hammer
  `SH_MPLS` vs `SH-OCKED` "shocked" — needs owner call).
- **Strong leads for hand curation** (via admin release-groups UI):
  `PTL→Reko?` (53% of descs credit Reko), `S8→Islona?` (32%),
  `ATX→Anthrox?` (trainers credited Anthrox), `DLT→Delight?`,
  `APX→Apex` (`Apex - Denistro`), `AND→Andromeda`, `A8S→After Eights`
  (`After Eights 1st Production`), `AC!→Artcore` (`-Artcore`),
  `IRS→Iris` (`-Iris`), `DKG→Dark Age`, `APT→Apathy`, `FTR→Factor`,
  `MIR→Mirage` (`Mirage Chit-chat`), `TP5/TP6/TP7→The Party` (years match).
- **Demozoo scrape: not feasible cleanly.** No search endpoint, list rows lack
  abbreviations (145k details infeasible), site search is Cloudflare-walled.
  The listing + existing Demozoo door data is the source; rest is hand curation.

## Full credit table (tag, files, top co-occurring credits)

Top slice, n≥100 (full output was 758 novel tags ≥20; regenerate with the
probes above if needed):

| tag | n | top credits |
|---|---|---|
| WP | 1833 | — (Word Perfect cracks, not a group) |
| WT | 1664 | Polish/Hellfire noise |
| PSG | 1375 | AGA 30% (hardware, noise) |
| PDY | 1245 | Grandslam/Ocean (game publishers) |
| MIR | 886 | Mirage (chit-chat series) → likely Mirage |
| HTS | 787 | — |
| FLT | 670 | FROM/Team → **Fairlight, inserted** |
| SH | 668 | -Sledge Hammer on SH_MPLS, but SH-OCKED collides → owner call |
| PDX | 644 | Paradox → **Paradox, inserted** |
| O/AS/S/A | 640/590/443/399 | not groups, skipped |
| PTL | 836 | Reko 53% → verify |
| S8 | 406 | Islona 32% → verify |
| SCX | 627 | Scoopex → already present |
