---
date: 2026-09-16
topic: Demozoo BBS text-ad corpus harvest into stripper seeds
tags: [bbs-ads, demozoo, stripper, seeds, handoff]
status: final
---

# Handoff 2026-09-16: BBS-ad corpus → stripper seeds (partial, census running)

## State (FINAL 2026-09-16 ~20:00 UTC)

- **Census COMPLETE**: 15,651 pages, 4,413 BBSes with ads, 11,078 ads (~58MB).
- **DB**: `data/bbs_ads.db` — 10,554 ads (95.3% linked), 4,313 BBSes, FTS5 over filename+text, `link_method` audit column. 211 ambiguous (multi-candidate), 313 missing (dump gaps).
- **Seeds FINAL**: patterns 4,565 → 11,942 (+7,377, dupes 0, HOLDOUT respected), fingerprints 148 → 10,783 (+10,635). Full suite 775 passed, typecheck clean.
- **Parity**: A/B (live doorserver DB 5,905 doors + local DB) identical 26/3 with and without harvest — zero attributable drift. Captures' junk bytes reflect the BBS-side strip stack, not measured data. Per-archive `/files` A/B on the 4 capture archives: exactly ONE harvest true positive — `aCI!!` in 5D!DP002.LHA (2242B) is byte-identical to corpus ad `aCI` (md5 361587ed…), old stripper kept it (0), harvest flags it (1). Capture needs recapture, not a seeds revert.
- **Reader flake (new finding, not fixed)**: `GET /files/*` nondeterministically duplicates `mastrb8.txt` across identical-code runs (FILES|11|8 vs 12|9; seen in 24STDCAL.LHA and 5D!DP002.LHA) — JS reader vs system-lha fallback disagree on duplicates. Poisons byte-parity regardless of seeds.

## Files

- `scripts/demozoo-textads-enumerate.ts` — public-page census → JSONL (no login).
- `scripts/demozoo-textads-import.ts` — dump+census → `data/bbs_ads.db` (bbs, text_ad + FTS, link_method audit column). 96%+ linkage on partial data.
- `scripts/harvest-bbs-ad-seeds.ts` — patterns (census originals) + fingerprints (all dump md5s) → seeds/. Guards: no match-all, skip `*#?@|` (auto-caught), skip bare-generic `<5 alnum`, HOLDOUT={docs.txt, read_me.txt}.
- `tests/bbs-ad-corpus.test.ts` — 12 tests, hardcoded fixtures (no corpus needed in CI).

## Key findings (forensics, scripts/probe-flagged-members.ts — DELETED after use)

- `Install.exe`/`History.guid` in doors are byte-identical corpus ads (fake installer cracktro, "WE WOULD DiE FOR COMMODoRE") — patterns KEPT.
- `docs.TXT` (IFF ANIM + door docs) and `READ_ME.TXT` (release/dev notes) are MIXED legit — patterns DROPPED, encoded in HOLDOUT. md5 tier still catches byte-identical copies.
- 24 sampled risky names otherwise all ad-class. 632 dump files already matched pre-existing fingerprints.
- JS archive reader OOMs on small zips (pht-kit.zip 13KB) — probe used system `unzip -p` for zips. Worth knowing, not yet filed.

## Next steps (ordered)

1. Census finishes → `npx tsx scripts/demozoo-textads-import.ts --db data/bbs_ads.db` → `npx tsx scripts/harvest-bbs-ad-seeds.ts` (dedupe makes it incremental) → `npm run test:ci`.
2. Tier-3 MEASURED 2026-09-16: single content signals are NOT viable for
   auto-strip. Recall/FP (3000 corpus files vs 5051 door docs + 5664 DIZes,
   hasAdSignals semantics = latin1 + regex):
   intl_phone 19.3%/1419+58, sysop: 16.9%/593+8, call_us 0.7%/48+1,
   greetings_from 0%/51+0, logon_to 0%/37+4, connect_to 0.1%/268+0,
   visit_us/download_here 0%/0+0, leech_provenance 1.9%/7+2,
   leeched_from 1.6%/16+43, day_warez 0.4%/11+0, credits_majors 0.5%/4+0.
   The existing 8 AD_SIGNAL_PATTERNS are near-zero recall AND high FP —
   good thing tier-3 was never wired. ANSI codes intersperse words
   (breaks substring search; "why not add this bbs to your call list"
   hits 77/1500 normalized but 0/3000 raw). Verdict: tier-3 needs
   ANSI-normalized MULTI-signal scoring (11k positives + 5k doc negatives
   available for training) — a follow-up design task, not a regex list.
3. md5 tier safety: smallest corpus file is 28 bytes — no tiny-file
   collision risk with legit door content.
4. dizPatterns from corpus lines: proposed, not started (substring-strip risk needs review).
5. Commit: seeds/*.json, scripts x3, tests/bbs-ad-corpus.test.ts, .gitignore. Do NOT commit bbs_ads/, *.db, *.jsonl, logs/.
