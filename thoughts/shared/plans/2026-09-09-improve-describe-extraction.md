---
date: 2026-09-09
topic: Improve FILE_ID.DIZ description extraction — multiline, art stripping, and field correctness
tags: [describe, diz, catalog, extraction, ascii-art]
status: draft
---

# Improve DIZ extraction — multiline descriptions, cleaner art stripping, and field correctness

## 1. Problem statement

`contract/describe.ts:1165` (`analyseDoor`) is the single extractor for `version`, `author`, `releaseGroup`/`requiresBbs`, and `description` from `FILE_ID.DIZ`. It was tuned over 15 rounds against the 3301-door corpus and is pinned by `tests/describe.test.ts:1` and `contract/describe-fixtures.json:1`. It works for the fixture set, but on the live 5932-door corpus (5665 with a DIZ) it systematically under-reads:

- **Multi-line prose is truncated to the first line.** A DIZ description that wraps across 2–5 lines inside the box (common at 30–42 cols) is emitted as only `parts[0]` plus at most one more line when `parts[0].length < 30` (`contract/describe.ts:373`). Any first line ≥30 chars stops the join. Real example `KCLHAAD.LHA` — 5-line paragraph:
  ```
  KCLhaAd (v1.0) LHA tester and adder for /X,
  S!X and Courier clones.  Since I was coding
  all the other utils, and I really didn't
  care for all the others, I quickly did this
  one also.  Simple and gets the JOB done!
  ```
  current output: `"all the other utils, and I really didn't"` — line 3 of 5, not line 1, and only one line of the five. User-visible symptom: short, mid-sentence fragment.

- **Art leaks into the first line.** CP437/ANSI borders (`─`, `│`, `±²Û`, `³Y³`) are scored via `clean()` (`contract/describe.ts:189`) but not via `toPlain()` (`contract/describe.ts:645`), which is applied *after* block selection (`contract/describe.ts:1185`). A line with 60% art + one real word can pass `score()` (via `alnumShare >0.5`) and become the chosen cell, then `toPlain` later turns pillars into spaces and the word survives with junk spacing. Example `mtnt_lb1.zip` → `"Lightúbarúenhancer PPe"` (still contains `ú` pillars as `ú`); `ma_upl20.zip` → `"Û Uplo D PPî 2.o …"`.

- **Metadata stripping is order-dependent and lossy.** `analyseDoor:1187-1198` does `splitBannerCredit → splitBbsRequirement → splitVersion → splitAuthor` sequentially on the *already-truncated* `body`. A version/BBS/author that sat on line 2 of the paragraph is already gone when the strip runs, and a version that *is* on line 1 gets stripped but leaves a hole (`"For AmiExpress or compatibilties, replaces internal B"` → `"For or compatibilties, replaces internal"` in fixture `AMIBULLS`).

- **Author/version detection scans the description, not the DIZ.** `splitAuthor` (`contract/describe.ts:531`) and `splitVersion` (`contract/describe.ts:396`) regex the `body` string. A real credit line `"Coded by SvEN tHE CREAToR/5tH DyNASTY"` on its own line (e.g. `5D-WHO24.LZH`) never enters `body` if that line was excluded from the chosen block (penalised by `HANDLE_RE`/`JUNK_RE`). The author is then missed unless `catalogAuthor` covers it.

- **Paragraph detection is brittle.** `describeBlock:323-343` builds blocks as runs of `score>0 && !JUNK && !HANDLE`. Any line containing `COMPAT_RE` (`contract/describe.ts:87`, e.g. `"for /X"`) or `COPYRIGHT_RE` is penalised -20/-40 but can still be `score<=0`, which *splits* a paragraph mid-sentence into two blocks. The next block then competes independently and a mid-paragraph line can win (the KCLHAAD case above).

Measured on a 100-row random sample (`data/doors.db` @ 2026-09-09): 20/100 descriptions <15 chars, 7/100 single-word, 0 art leak via `|` check but `ú`/`Û` leak present in subsample above. Not a formal corpus audit — Phase 1 below makes it one.

## 2. Current pipeline (file:line)

```
deriveMetadata (src/submissions.ts:351) / buildManifest (src/manifest.ts:253)
  → analyseDoor(input, groupTags)  contract/describe.ts:1165
      prettyProg = prettifyProgram(toPlain(binaryName))  :1166
      body = describeBlock(dizText, 70, prog)            :1173  → 323
             ├─ lines → bestCell(line) per line          :328-329
             │     └─ split on CELL_SPLIT_RE (110) → score() (239)
             │           ART_RE (57), WORD_RE (96), highBitShare>0.3 (243),
             │           alnumShare<0.5 (244), JUNK/COPYRIGHT/COMPAT/HANDLE penalties,
             │           VERSIONISH +12, DOORISH +8, words*3, >55 chars -4, trailing : -6
             ├─ group into blocks: consecutive score>0 && !JUNK && !HANDLE :330
             ├─ ranked by maxScore + min(len,4)*4 - firstLine   :346-350
             ├─ skip prog-only blocks (bodyAddsNothing)           :353-360
             ├─ parts = chosenBlock.map(cleaned).map(finalise 70):362-368
             └─ join: text=parts[0]; for next in rest: if text.length>=30 break :373-377
      fallback: clean(name) scored, else archiveBase              :1174-1184
      body = toPlain(prettifyInText(body))                        :1185
      banner = splitBannerCredit(body)                            :1187
      req    = splitBbsRequirement(banner.text)                   :1190
      ver    = splitVersion(req.text, catalogVersion)             :1194
      auth   = splitAuthor(ver.text, catalogAuthor??banner.credit):1197
      prog   = stripVersionTail(capitaliseName(prog), ver)        :1200
      description = finalise(toPlain(compose(tidyCase(prog), tidyCase(body))), 60):1203
```

Key callers: `src/manifest.ts:236` (`describeRow`), `src/submissions.ts:359` (`deriveMetadata`), `src/public-routes.ts`, `src/admin-routes.ts`, `web/src/components/DoorDetail.tsx`.

Contract surface: `DESCRIBE_CONTRACT_VERSION='1'` (`contract/describe.ts:52`), mirrored to BBS via `contract/describe-fixtures.json` and `tests/describe-fixtures.test.ts`.

## 3. Root causes (fix at this level, not in callers)

| # | Invariant violated | Where the fix belongs | Band-aid that would hide it |
|---|--------------------|-----------------------|-----------------------------|
| R1 | A paragraph is the unit of meaning, not a line. Current join stops at `>=30` chars (`contract/describe.ts:375`) — a single wrapped line is already ≥30, so every multi-line description is truncated. | `describeBlock` paragraph joining | Raising `finalise` cap alone (still only one line joined) |
| R2 | Art filtering uses `clean()` not `toPlain()`. CP437 `Û±²` counts as letters for `WORD_RE`/`alnumShare`; `highBitShare>0.3` misses mixed art+text lines. | Scoring predicate (run `toPlain` or a stripped variant before `score`) | Extra post-hoc `replace(/ú/g,'')` |
| R3 | Metadata lines (`for /X`, `v1.0`, `by Author`) are part of the paragraph and must not split it. `describeBlock:330` excludes `JUNK`/`HANDLE` lines from blocks, and `score` penalises `COMPAT_RE` → break mid-sentence. | Block building: include metadata lines in block, strip them later; tune `COMPAT_RE` penalty to not break prose blocks | Widening `COMPAT_RE` exclusion elsewhere |
| R4 | Author/version/requirement are properties of the DIZ, not of the chosen `body`. Scanning `body` (`contract/describe.ts:531,396,485`) misses lines outside the chosen block. | Scan the *whole* DIZ for those fields before/parallel to description picking (as `bbsRequirementFromDiz:499` already does for one field). Extend pattern to version/author. | Adding more `places` to regex on `body` |
| R5 | Casing/normalisation (`tidyCase:766`, `toPlain:645`) runs after composition, but scoring ran on differently-normalised text, so elite-cased or hyphen-broken words score inconsistently. | Normalise before scoring (or score on normalised form) | Adding acronyms to `ACRONYMS` list one-by-one |

## 4. Goals / Non-goals

**Goals:**
- Multiline `FILE_ID.DIZ` art boxes yield a coherent 1–3 sentence description (not the first cell's fragment), with frame/ANSI/CP437 fully stripped and no leftover `|`/`¦`/`ú`/`Û`/`Ä` pillars.
- `version`, `author`, `requiresBbs` correctness does not regress and ideally improves (measured on corpus, not on fixtures alone).
- No `list.txt`/`manifest`/`index.tsv` byte change for rows that already read correctly; `DESCRIBE_CONTRACT_VERSION` bump is explicit and mirrored to BBS.
- Every improvement ships with a regression test that fails before the change and passes after (`tests/describe.test.ts` + `contract/describe-fixtures.json` regen).

**Non-goals:**
- Changing `door_catalog.description` column semantics or `schema.sql`; changing archive extraction (`src/archive-reader.ts`).
- ML/LLM-based extraction or adding a native dependency.
- Touching rate limits, auth, or any non-describe surface.

## 5. Proposed design (overview)

Keep the file in `contract/` (no imports, contract is the source of truth). Keep the public shape `DoorFacts {description, version, author, requiresBbs}` and `analyseDoor` signature; all callers unchanged.

Introduce three small internal helpers, replace one predicate, widen the join window, and reorder metadata extraction:

```
text block =  DIZ → normaliseLines() (ANSI+controls → spaces, keep frame for split)
           → bestCell() now scores on toPlain(clean(cell))-stripped form
           → block building includes metadata-tainted lines (don't exclude on JUNK/COMPAT)
           → rank blocks as before, but choose block via new blockScore that rewards
              sentence completeness (ends with .!? or next line starts lowercase → continuation)
           → reconstructParagraph(chosenBlock, cap): join until finalise length cap or sentence boundary,
              handling hyphen-continuations ("Lay-\nOut" → "Lay-Out"), bullet stripping, leading "o" etc.
           → description post-processing: finalise(cap) with cap raised (see D6)

metadata =  bbsRequirementFromDiz(diz)  (already whole-DIZ)  +
            versionFromDiz(diz) + authorFromDiz(diz)  (new: scan whole DIZ with current regexes,
            preferring version near prog/title over body version)
           → strip those tokens from body *after* paragraph reconstruction, not before
```

## 6. Plan — phases, each with automated + manual exit

### Phase 0 — Measurement harness (no behaviour change)

**Why:** Every subsequent claim ("cleaner", "correct", "less junk") is otherwise unmeasurable and the 60-char cap hides regressions.

- Add `scripts/diz-audit.ts` (not built):
  - Against real `data/doors.db`, compute per-row: `dizLines`, `bodyLines`, `descLen`, `descWords`, `artLeak` (`/[|\u00a6\u2588\u2591\u2592\u2593\u00b3\u00c4\u00c1\u00da]/` in `description`), `truncatedMidSentence` (cap hit && !`/[.!?]$/`), `versionFound` vs `catalogVersion`, `authorFound` vs empty, `requiresBbs` vs known set.
  - Emit CSV + summary (mean/median desc len, % single-word, % art leak, % mid-sentence truncation).
  - Also run `describeBlock` vs `describeLine` delta and log rows where block picked mid-paragraph (KCLHAAD pattern): `chosenBlock.firstLine != 0 && chosenBlock.length>2`.
- Add `npm run audit:diz` script entry.
- Commit baseline numbers in plan appendix; no contract bump.

**Verification:** `npx tsx scripts/diz-audit.ts --db data/doors.db` prints table; `npm run typecheck` green. Manual: attach baseline CSV to PR.

### Phase 1 — Art filtering before scoring (R2)

**Edit:** `contract/describe.ts:239-284` (`score`, `bestCell`).

- New helper `plainForScoring(s)` = `toPlain(clean(s))` with frame-aware `stripFrameBoth` kept for split, then `toPlain` for the letter/digit density tests.
- `score()` runs `WORD_RE`, `highBitShare`, `alnumShare` on `plainForScoring` output, not on raw `clean()`. Thresholds unchanged initially (`>0.3`, `<0.5`), then tuned if audit shows residual `ú`/`Û`.
- Add `FRAME_DENSITY_RE` quick reject: if `FRAME` chars are >50% of line length and no `WORD_RE` with ≥4 letters, return `-99` early (catches `ÄÄÄÅHä…` bands).
- `CELL_SPLIT_RE` keep as-is; verify `¦`, `·`, `!` pillars already covered. Add test for the vertical `"P\no\ni\nt"` columnar art pattern (reject as non-block).

**Tests:** extend `tests/describe.test.ts` — "CP437 band with one word is not a description" (`mtnt_lb1.zip`-style), "mixed art+text splits and picks text cell". Update `contract/describe-fixtures.json` if any fixture moves (expect 0 moves).

**Success:** audit `artLeak` → 0 on 100-row sample; fixtures green or explicitly rebased with `DESCRIBE_FIXTURES_OUT`.

### Phase 2 — Paragraph reconstruction (R1, R3)

**Edit:** `contract/describe.ts:323-379` (`describeBlock`).

- Block building: `prose` predicate becomes `score> -50` (not `>0`) but still `!HANDLE_RE` for block *membership*; metadata-tainted lines (`COMPAT_RE`, `JUNK_RE` with `version`/`author` nearby) are *included* in block so they don't split it. Only `ART_RE`/`highBitShare`/`alnumShare` hard rejects split.
- New `isContinuation(prev, next)` — returns true if `prev` does not end with `.!?` and `next` starts with lowercase or is short (<35 chars) and `prev.length` near box width (30–42). Hyphen at EOL (`"Lay-"` + `"Out"`) merges without space.
- `reconstructParagraph(parts, cap)`:
  ```ts
  let text = finalise(parts[0], cap);
  for (const nxt of parts.slice(1)) {
    const cleaned = finalise(nxt.replace(/^[o*·]\s+/,'').trim(), cap);
    if (!cleaned) continue;
    if (text.length >= cap) break;
    // don't break mid-sentence if previous line is a continuation
    if (text.length < cap * 0.6 || isContinuation(text, cleaned)) {
      text = finalise(text + ' ' + cleaned, cap);
    } else if (/[.!?]$/.test(text)) {
      // sentence ended and we're over half the cap — stop, we have enough
      break;
    } else {
      text = finalise(text + ' ' + cleaned, cap);
    }
  }
  ```
  Replace the `>=30 break` loop.
- `parts` mapping: keep `finalise(p, cap)` per part but with same `cap` that the final join uses, so truncation is word-boundary consistent.

**Cap note:** keep `describeBlock` default `cap=70` for now; Phase 3 raises the final `analyseDoor:1203` cap.

**Tests:** regression for `KCLHAAD.LHA` ("LHA tester and adder for … Since I was coding … Simple and gets the JOB done!" should read as one sentence, not mid-paragraph), `AMN10` two-line wrap, `JC40` bullet list `"Totally New Lay-Out Manages up to 256 Cnfs"` still passes, `DLT-UL11` single-line fallback still uses `describeLine`.

**Success:** audit `% truncatedMidSentence` drops; manual spot-check 30 random rows: no first-line-only fragment where DIZ had a 2+ line wrapped paragraph.

### Phase 3 — Cap and finalise policy (R1)

**Edit:** `contract/describe.ts:1203` and `contract/describe.ts:207-230`.

- Raise `analyseDoor`'s final cap from `60` → `120` for `manifest`/`describeRow`; keep `list.txt`'s own 120-char slice (`src/manifest.ts:438`) and `index.tsv` 60-char contract separate. `analyseDoor` already takes `cap` via `describeBlock`; thread `cap` through so `manifest` can ask for 120 while `index.tsv` (via `describeRow`) can ask for 60 without a second extractor.
- `finalise` word-boundary cut: when cutting at `cap`, prefer last `[.!?]` in the cut window over last space (avoid cutting mid-clause). Keep existing bracket/connector cleanup.

**Compatibility:** `DESCRIBE_CONTRACT_VERSION` bumps `1→2`; `contract/describe-fixtures.json` regenerated; BBS mirror bump is a tracked follow-up (add checklist item). `list.txt` parity unchanged because `manifest.ts:438` already caps at 120 — the visible change is in `manifest.description` / `DoorJson` which is versioned separately.

**Tests:** `analysis: never returns more than cap`, `cut prefers sentence boundary over space`.

**Success:** mean `descLen` moves from ~34 → ~70 on corpus; no row exceeds new cap; `npm run test:parity` re-run noted (expected diff: every row's description changed, no other field — same as last description divergence `docs/DOOR-REPO-API.md:473`).

### Phase 4 — Whole-DIZ metadata extraction (R4)

**Edit:** `contract/describe.ts:396-523`, `531-570`.

- New `versionFromDiz(diz, groupTags?)` that scans `diz.replace(ANSI_RE,'').split('\n')` with `VER_RE`/`BARE_VER_RE` as now, but scores candidates: +2 if within 1 line of a `prog` mention or title cell (`bestCell` top cell), -1 if on a `COMPAT_RE` line (BBS version). Return best. `analyseDoor` then prefers `versionFromDiz` over `splitVersion(body)`; `catalogVersion` remains last resort.
- New `authorFromDiz(diz)` that scans lines matching `/by\s+/i` or `HANDLE_RE` or `BANNER_SPLIT_RE` patterns across the whole DIZ, returns the longest handle-shaped match ≤40 chars. `analyseDoor` prefers `authorFromDiz` over `splitAuthor(body)`; `catalogAuthor`/`banner.credit` remain fallbacks.
- `requiresBbs` already whole-DIZ via `bbsRequirementFromDiz:499` — keep as-is, but ensure `splitBbsRequirement(body)` stripping is idempotent when the requirement was on a different line than `body` (currently `stripBbsMatch:473` guards with `/[A-Za-z]{3}/` — retain).
- Order in `analyseDoor` becomes: `dizMeta = {requires: bbsRequirementFromDiz(diz), version: versionFromDiz(diz), author: authorFromDiz(diz)}` → `body = reconstructParagraph(...)` → strip `requires`/`version`/`author` tokens from `body` using the diz-derived values (so a credit on line 5 can be removed from a body built from lines 1–2 without needing to be inside it).

**Tests:** `5D-WHO24.LZH` author `"SvEN tHE CREAToR/5tH DyNASTY"` via DIZ scan even when block is `"Who"`; `KCLHAAD.LHA` version `1.0` via DIZ scan not via truncated body; `SHX-GB10.LHA` `Amix` not mistaken as BBS so `v3.x` correctly stays as version or is dropped, not bled into description.

**Success:** on corpus audit, `% author empty` drops where DIZ has a `by` line outside chosen block; version correctness spot-check on 50 rows with a version in DIZ: no BBS version mis-classified as door version.

### Phase 5 — Scoring retune and dictionary assist (R5)

**Edit:** `contract/describe.ts:239-284` (weights).

- Re-weight with corpus feedback (measure before coding — 20-line probe per change):
  - `COMPAT_RE` penalty `-20` → `-8` for block membership (don't split), keep `-20` for final line ranking if the line is *only* a compat note (`/^[^\w]*for \/X/i`).
  - `JUNK_RE` `-40` keep, but exempt when `VERSIONISH_RE` or `DOORISH_RE` also present (a release date line with a version is not pure junk).
  - Add `+4` for sentence-like lines (starts with capital, ends with `.!?`, has verb word list `is|are|for|with|the`) — pushes real prose above box-art cells.
- Optional: tiny word-list check (100 common English words + 50 BBS words `door|tool|utility|bbs|amiexpress|file|upload|download|message|caller|sysop|node|chat|game|list|menu`) — add `+2` if ≥2 such words present. No new dependency; list in-file.

**Tests:** assert ranking: `"LHA tester and adder for /X, S!X and Courier clones."` outranks `"all the other utils, and I really didn't"` within same block (first line wins when paragraph is reconstructed). Fixture moves documented per rule change.

**Success:** audit ranking inversion count (where block's best `score` is not on its first line) drops.

### Phase 6 — Fixture & corpus expansion

- Regenerate `contract/describe-fixtures.json` via `DESCRIBE_FIXTURES_OUT=contract/describe-fixtures.json npx jest tests/describe.test.ts`.
- Add 15 corpus-derived fixtures that previously read wrong (KCLHAAD, mtnt_lb1, SHX-GB10, KCLhaAd vertical text case, HWC11 art-heavy, SCK-NUBC `!ALSTER` date vs description). Each fixture stores `input` + `expected` with `groupTags` sorted.
- Add `tests/diz-corpus.test.ts` that runs the audit thresholds as a test (`artLeak===0`, `meanDescLen>45`, `singleWord<5%`) — informational, not blocking, but logs on failure.

**Verification (per phase):**
```
npm run typecheck
npx jest tests/describe.test.ts tests/describe-fixtures.test.ts tests/manifest.test.ts
npx tsx scripts/diz-audit.ts --db data/doors.db   # compare to Phase 0 baseline CSV
# before deploy:
npm run test:parity   # expect description-field diff only, logged in commit message
```

## 7. Alternatives considered

- **LLM post-processing of DIZs.** Would give best prose quality, but adds a runtime dependency, non-determinism, and breaks the `contract/` no-imports, offline, reproducible rule that lets the BBS vendor the extractor. Rejected.
- **Keep `cap=60` and fix only truncation.** The cap is the reason DIZ rewriters cap at 60; raising it needs a contract version bump but the current 60 is *after* frame stripping, so most doors already lose their second sentence. Fixing join without raising cap still truncates mid-sentence in `finalise`. Do both.
- **Rewrite extractor in Python and vendor.** Prototype already exists (`amiexpress-web:dev/scripts/door-index/description_rules.py` per `contract/describe.ts:10`) but TypeScript is the contract; moving would invert the mirror. Keep TS as source, regen Python if needed.

## 8. Risks and mitigations

- **Fixturing churn breaks BBS mirror.** Mitigation: `DESCRIBE_CONTRACT_VERSION` bump, single PR, BBS vendor step is a checklist item in the PR description (copy of this plan's "Non-goals" note).
- **Corpus-wide description change invalidates caches.** `getCatalogRevision` (`src/catalog.ts:138`) already includes `overridesStamp+hiddenStamp` but not describe version; `manifest.revision` (`getCatalogRevision`) is count+max(indexed_at) and will *not* change when only extractor changes. Mitigation: include `DESCRIBE_CONTRACT_VERSION` in revision or bump a manual `o` segment — decide in Phase 3; alternative is to accept that clients re-fetch on next `indexed_at` tick.
- **Performance:** whole-DIZ scans add O(lines) per row at manifest build; measured: `buildManifest` is one `fetchCatalogRows` + per-row `analyseDoor`. 5932×~10 lines regex is negligible vs `getArchiveChecksums`. Still benchmark via `scripts/diz-audit.ts` timing.

## 9. Reachability / Definition of done

Per `~/.claude/REACHABILITY_PROTOCOL.md`:

- `npm run dev` serves `GET /api/door-repo/manifest` and `GET /api/door-repo/list.txt` with new descriptions; `GET /api/door-repo/diz/:name` unchanged.
- `scripts/diz-audit.ts` drives `analyseDoor` and asserts: mean description length up, art leak down, mid-sentence truncation down (numbers, not just unit tests).
- `tests/describe.test.ts` + `tests/describe-fixtures.test.ts` + `contract/describe-fixtures.json` prove the extractor contract, with a named test per reported symptom (multi-line truncation, `ú` leak, KCLHAAD mid-paragraph pick).
- Every declared knob (`cap`, block ranking, scoring) moves the output or carries an exemption note.
- `npm run typecheck` + `npm run test:ci` green; `npm run test:parity` run manually and diff logged (description field only).

## 10. Checklist (tick in the open, report running count)

- [ ] P0 measurement harness + baseline CSV committed (1/10)
- [ ] P1 art filtering before scoring — code + tests + fixture regen if needed (2/10)
- [ ] P2 paragraph reconstruction — code + KCLHAAD/AMN10 regression tests (3/10)
- [ ] P3 cap raise 60→120 + finalise sentence-boundary cut (4/10)
- [ ] P4 whole-DIZ version/author scan + strip-after-reconstruct (5/10)
- [ ] P5 scoring retune + word-list assist, measured before coding (6/10)
- [ ] P6 15 corpus fixtures + `diz-corpus` audit test (7/10)
- [ ] `DESCRIBE_CONTRACT_VERSION` bump + `contract/describe-fixtures.json` regen (8/10)
- [ ] `npm run typecheck` + `npm run test:ci` green (9/10)
- [ ] `npm run audit:diz` shows meanLen up / artLeak 0 / truncation down; `test:parity` description-only diff logged; BBS mirror bump filed (10/10)

---
*Next step: review this plan, then execute phase-by-phase via subagent-driven development. Do not start P1 until P0 baseline is committed.*
