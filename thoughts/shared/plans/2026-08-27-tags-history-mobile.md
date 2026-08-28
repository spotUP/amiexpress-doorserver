---
date: 2026-08-27
topic: Tags UI, Version Tracking, Mobile View
tags: [plan, frontend, admin]
status: draft
---

# Plan: Tags UI, Edit History, Mobile Responsiveness

## Feature 1: Tags UI in DoorDetail Edit Tab

### What exists
- Backend: migration v5 (`door_tags`), GET/PATCH endpoints, audit recording
- Hooks: `useDoorTags`, `useSetDoorTags`, `useAllTags` in queries.ts
- **Missing**: The Edit tab in DoorDetail.tsx doesn't render a tags editor

### Changes

**`web/src/components/DoorDetail.tsx`** (lines 10, ~261-298):
1. Import `useDoorTags`, `useSetDoorTags`, `useAllTags` from queries
2. Call hooks inside `DoorDetailDialog`:
   ```ts
   const { data: tagData } = useDoorTags(archiveName ?? '', Boolean(admin));
   const { data: allTagData } = useAllTags(Boolean(admin));
   const setTags = useSetDoorTags(archiveName ?? '');
   ```
3. Add a tags section at the bottom of the Edit tab (after FieldEditor loop, before `</Tabs.Content>`):
   - Current tags shown as removable `Badge` chips with an X button
   - An `Input` field with placeholder "Add tag..." that commits on Enter
   - On add/remove: call `setTags.mutateAsync(newTags)` immediately (no explicit save button - same pattern as FieldEditor autosave)
   - Show `setTags.isPending` as a subtle saving indicator
   - Deduplicate suggestions from `allTagData` that aren't already applied

**Estimated scope**: ~40 lines added to DoorDetail.tsx

---

## Feature 2: Per-Door Edit History

### What exists
- `admin_audit` table records all edits with `{ field, from, to }` detail
- `GET /admin/audit` returns global audit trail (limit 500)
- `AuditPanel` renders the global trail as raw JSON
- **Missing**: No per-door endpoint, no History tab in DoorDetail

### Changes

**`src/admin-routes.ts`** — new endpoint before `return router`:
```
GET /admin/doors/:archiveName/audit
```
- Query: `SELECT ... FROM admin_audit WHERE target = ? ORDER BY at DESC LIMIT 100`
- Need to resolve `archiveName` to `catalog_id` first (same pattern as tags endpoint)
- Return `{ entries: AuditEntry[] }` with parsed detail JSON and resolved `by` username

**`web/src/api/queries.ts`** — new hook:
```ts
export function useDoorAudit(archiveName: string | null, enabled: boolean)
```
- Calls `GET /admin/doors/:name/audit`

**`web/src/components/DoorDetail.tsx`** — new History tab:
- Add `['history', 'History']` to the tabs list (only when `admin` is true)
- History tab content: timeline of edits, each showing:
  - Timestamp (relative: "2 hours ago")
  - Action badge (edit, revert, hide, restore, strip, edit-tags)
  - For edits: field name, old value → new value
  - For other actions: relevant detail from the JSON
- Sort by `at DESC` (newest first)

**Estimated scope**: ~30 lines backend, ~60 lines frontend

---

## Feature 3: Mobile Responsiveness

### What exists
- DoorTable: fixed `min-w-[60rem]` table with horizontal scroll — unusable on phones
- Browse page header: flex-wrap but no responsive breakpoints
- Filter bar: 4 selects + search input, overflows on narrow screens
- Stats panel: already responsive (best component)
- **Missing**: Mobile layout for the core table, responsive filter bar, mobile nav

### Changes

#### 3a. DoorTable card layout (`web/src/components/DoorTable.tsx`)

Replace the single `<table>` with a responsive approach:
- On `md:` and above: keep the existing table (current behavior)
- Below `md:`: render a card/stacked layout where each door is a card showing:
  - Name (primary, large)
  - Archive name (mono, secondary)
  - Size, type badge, group badge
  - Description truncated to 2 lines
  - Checkbox for selection (admin)

Implementation: wrap both layouts in a container, use `hidden md:block` for the table and `md:hidden` for the cards. The card layout reuses the same data, just renders differently.

#### 3b. Filter bar responsive (`web/src/pages/Browse.tsx`)

- Wrap filter selects in a collapsible section on mobile
- On mobile: show a "Filters" button that expands/collapses the filter row
- On `md:` and above: show filters inline as before
- Search input always visible (it's the most important control)

#### 3c. Browse header responsive (`web/src/pages/Browse.tsx`)

- Group admin action buttons into a dropdown on mobile
- On `md:` and above: show inline as current

**Estimated scope**: ~80 lines DoorTable, ~40 lines Browse

---

## Verification

1. `npm run build` — TypeScript compiles
2. `npx jest --config jest.config.ts` — all 321 tests pass
3. `npm run build:web` — frontend builds
4. Manual testing on server:
   - Tags: open a door Edit tab, add/remove tags, verify they persist
   - History: open a door History tab, verify edits appear
   - Mobile: open on phone or resize browser below 768px, verify card layout

## Order of implementation

1. Tags UI (smallest, most self-contained)
2. Version tracking (new endpoint + tab)
3. Mobile view (largest scope, depends on stable layout from 1 & 2)
