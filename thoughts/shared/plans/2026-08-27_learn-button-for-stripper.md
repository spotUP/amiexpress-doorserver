---
date: 2026-08-27
topic: Learn button for scene stripper
tags: [stripper, classifier, admin-ui, doorman, doorrepo]
status: draft
---

# Learn button for the scene ad stripper

## Goal
Let sysops teach the classifier new ad patterns organically. When viewing
archive files or the strip preview, a "Learn" button adds the filename
pattern to a persistent learned-patterns table. Future previews and strips
automatically catch it. DOORMAN (BBS terminal UI) also POSTs learned
patterns to the same endpoint, so the classifier improves across both UIs.

## Architecture

```
  ┌──────────────┐     POST /admin/learn     ┌──────────────────────┐
  │  Web UI      │ ──────────────────────────▶│  Doorserver API      │
  │  (Files tab  │                            │  admin-routes.ts     │
  │  + Strip     │  ◀────────────────────── │                      │
  │  preview)    │  GET /admin/learned       │  learned_junk table  │
  └──────────────┘                            └──────────┬───────────┘
                                                         │
  ┌──────────────┐     POST /admin/learn     │           │
  │  DOORMAN     │ ──────────────────────────┘           │
  │  (BBS TUI)   │  via repo-client.ts                   │
  └──────────────┘                                       │
                                                         │
  ┌──────────────┐     GET /api/learned-patterns         │
  │  doorrepo.c  │ ◀────────────────────────────────────┘
  │  (Amiga)     │  (read-only for now)
  └──────────────┘
```

**Key design decision:** The classifier (`classifyFile`) stays pure —
no DB access. Learned patterns are loaded by callers and passed in as
additional arguments. This keeps the classifier testable and portable.

## Implementation

### Phase 1: DB schema + backend

**`schema.sql` — new table:**
```sql
CREATE TABLE IF NOT EXISTS learned_junk_patterns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern     TEXT NOT NULL,        -- exact filename glob (e.g. "7hE-EdGE.nfo")
  archive_name TEXT,                -- which door this was learned from
  file_path   TEXT,                 -- which file in the archive
  learned_by  TEXT DEFAULT 'admin', -- admin username
  created_at  INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_ljp_pattern ON learned_junk_patterns(pattern);
```

**`admin-routes.ts` — new endpoints:**

1. `POST /admin/learn` — add a learned pattern
   - Body: `{ pattern: string, archiveName?: string, filePath?: string }`
   - `pattern` is the exact filename glob to match (case-insensitive)
   - Returns `{ ok: true, id: number }`
   - Audit-logged

2. `GET /admin/learned` — list learned patterns
   - Returns `{ patterns: LearnedPattern[] }`
   - Useful for review/pruning

3. `DELETE /admin/learned/:id` — remove a learned pattern
   - Returns `{ ok: true }`

### Phase 2: Classifier integration

**`ami-stripper.ts` changes:**

1. New function `loadLearnedPatterns(db)`:
   ```ts
   function loadLearnedPatterns(db: Database): string[]
   ```
   Queries `SELECT pattern FROM learned_junk_patterns` → returns string[]

2. Modified `analyzeArchive` — add optional `extraPatterns` parameter:
   ```ts
   export function analyzeArchive(
     archivePath: string,
     extraPatterns?: string[]
   ): StripResult
   ```
   Merges `extraPatterns` with seed patterns before calling `deriveStripPlan`.

3. `strip-preview` endpoint loads learned patterns and passes them:
   ```ts
   const learned = loadLearnedPatterns(db);
   result = analyzeArchive(absPath, learned);
   ```

### Phase 3: Web UI — learn buttons

**`DoorDetail.tsx` — Files tab:**
- Each file row gets a "Learn" button (ghost variant) on the right
- Disabled if `file.isJunk` is already true
- Click → `POST /admin/learn` with `{ pattern: file.path, archiveName, filePath: file.path }`
- After success: invalidate door query (refreshes `files` list with new `isJunk`)

**`DoorDetail.tsx` — Strip preview:**
- Each **kept** file gets a "Learn" button on the right
- Click → `POST /admin/learn` → re-run preview
- The newly learned pattern should cause the file to appear in `stripped` on the next preview

**`queries.ts` — new mutations:**
```ts
export function useLearnPattern() {
  return useMutation({
    mutationFn: (data: { pattern: string; archiveName?: string; filePath?: string }) =>
      api.post<{ ok: boolean; id: number }>('/admin/learn', data),
  });
}
```

### Phase 4: DOORMAN integration

**`repo-client.ts` — new function:**
```ts
export async function learnPattern(
  config: RepoClientConfig,
  pattern: string,
  archiveName?: string,
  filePath?: string
): Promise<{ ok: boolean }>
```
POSTs to `/api/door-repo/admin/learn` on the doorserver.

**`app.ts` StripView — learn key:**
- Add `[L] Learn` key binding in `renderFiles()`
- When pressed on a kept file that's not junk: calls `learnPattern()`
- Re-runs analysis to refresh the file list

### Phase 5: Export/import for doorrepo.c

**`GET /api/admin/learned-patterns` (public, read-only):**
- Returns the full learned patterns list as JSON
- doorrepo.c can fetch this to augment its local classification
- For now, read-only — Amiga client doesn't need to POST patterns

## Files to change

| File | Change |
|------|--------|
| `src/schema.sql` | Add `learned_junk_patterns` table |
| `src/admin-routes.ts` | Add POST /learn, GET /learned, DELETE /learned/:id |
| `src/ami-stripper.ts` | Add `loadLearnedPatterns()`, modify `analyzeArchive()` signature |
| `src/catalog.ts` | (no changes needed) |
| `web/src/api/types.ts` | Add `LearnedPattern` type |
| `web/src/api/queries.ts` | Add `useLearnPattern` mutation |
| `web/src/components/DoorDetail.tsx` | Add "Learn" button to Files tab + strip preview |
| `amiexpress-web/.../repo-client.ts` | Add `learnPattern()` function |
| `amiexpress-web/.../app.ts` | Add [L] key in StripView for DOORMAN |

## Verification

1. **Unit tests** (`tests/ami-stripper.test.ts`):
   - Test `analyzeArchive()` with `extraPatterns` parameter
   - Test that learned patterns cause files to be classified as junk

2. **Manual test on live server:**
   - Open door detail → Files tab → click "Learn" on a clean file → verify it gets a junk badge
   - Open strip preview → click "Learn" on a kept file → verify it moves to stripped list
   - Verify the pattern persists across page reloads

3. **DOORMAN test:**
   - In DOORMAN StripView, press [L] on a file → verify the pattern is saved to the doorserver

## Success criteria
- [x] Learn button appears in Files tab for non-junk files
- [x] Learn button appears in strip preview for kept files
- [x] Clicking Learn saves pattern to DB and refreshes the view
- [x] Learned patterns are included in future strip previews
- [x] Patterns persist across server restarts
- [x] DOORMAN can POST learned patterns to the doorserver
- [x] Public GET /api/door-repo/learned-patterns endpoint for doorrepo.c
- [x] All existing tests still pass
