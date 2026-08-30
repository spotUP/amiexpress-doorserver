---
date: 2026-08-30
topic: Session handoff - stats filter + admin API recovery + groups dialog setup
tags: [stats, admin-api, jwt-secret, demozoo-groups, fetch-api-groups, deploy-workflow]
status: in-progress
---

# Session handoff (2026-08-30)

## Where we are

The admin API is back up. Live stats are no longer dominated by
"None" / "Unknown" rows. Demozoo's `author_nicks` has been pulled
into a new local column (`api_release_group` + `api_release_group_full`).
The release_groups table is now connected to the doors via the
filename-vs-API discrepancy audit.

## Live state

- 5932 doors total (4287 scan + 1641 demozoo + 4 submission)
- byGroup top 8: 5D (108), MST (92), TRSI (77), SAD (74), LGC (56),
  AFL (55), LSD (47), OTL (46) - NO "None" at the top
- byAuthor top 5: Food (121), Demonic Productions (59), Intellect (42),
  Noisy (41), Acidic (41) - NO "Unknown"
- byCategory top 5: auto-added (2615), XIM-BBSCmd (34), FIM-Reference (5),
  SIM (5), DD-Reference (2)
- 1507/1600 demozoo doors have `api_release_group` populated. Of those,
  0 had a release_group that disagreed with the API. So the original
  filename-derived tag was correct in 100% of the cases we could verify.
  The remaining 93 doors are the 33 connection errors + 60 unknown
  (probably 404s from demozoo's id-renumbering over the years).

## What I shipped this session (chronological)

### Admin API recovery (deployed)

- `Dockerfile`: install `p7zip` (the zip-aware archiver 7z binary)
  via apk so the in-place file delete UI works on .zip doors.
- `lha-member-delete.ts`: `findArchiverFor(archivePath)` picks the
  right archiver per file type. lha for .lha/.lzh, 7z for .zip/.7z.
  Reordered `/learned/by-path` BEFORE `/learned/:id` so the literal
  segment "by-path" isn't captured as the id value.
- `DoorDetail.tsx`: deleteFile re-fetches the file list from the
  server instead of guessing the response shape.

### Stats filter (deployed, live)

`src/public-routes.ts` - byGroup, byAuthor, byCategory now use
`WHERE value IS NOT NULL AND value != ''` to drop NULL/empty
buckets. Was the top of the chart useless (None=3116, Unknown=...).
Now shows real groups / authors / categories. Verified live:
`curl /api/door-repo/stats` shows 5D, MST, TRSI etc. as the top.

### `api_release_group` column + fetch script (committed, locally run)

- `src/migrations.ts`: migration 13 adds
  `api_release_group TEXT` and `api_release_group_full TEXT` to
  `door_catalog`.
- `scripts/fetch-api-groups.ts`: iterates all 1600 demozoo doors,
  fetches `author_nicks` from the demozoo.org API at 1 req/sec,
  writes the canonical scene group short tag + full name into
  the new columns, and (if the API's group differs from the
  stored one) updates `release_group`. ~25 min for 1600 doors.
- Verified: 1507 updated, 33 errors (timeouts/ECONNRESETs), 0
  release_group updates needed (the filename-derived tags were
  already correct).

The bundle producer / API enrichment hasn't been updated to
read `api_release_group` yet. Right now it's a side table the
admin UI can show. Future: include in the apiEnrichmentRows
UPDATE so it gets replicated to live.

## Open work

### Lower priority

- `analyseDoor` in `src/describe.ts` already returns null description
  for banner-only DIZs. Tested locally. Live.
- DIZ viewer uses ansi_up for SGR escape codes. PC-DOS FILE_ID.DIZ's
  use CP437 box-drawing chars which work fine in TopazPlus; OSC
  hyperlinks don't (CP437/ANSI mix). Not worth a fix right now.
- Strip preview leaves BBS-ad lines in the DIZ. The stripper has
  `stripDizLines()` but it's not wired into the strip-preview path.

### The groups dialog (user-built, untested in this session)

The user has built a groups dialog that uses the release_groups
table. I haven't seen it but it lives in `web/src/components/`
somewhere. The intent is: admin types an abbreviation or full name,
the dialog suggests the canonical pair from the table. This now
works because the `release_groups` table has 813 entries (or
more) with the canonical abbreviations.

The new `api_release_group` column makes the dialog more useful:
it can show "this door was tagged '5D' from the filename, but
demozoo.org says the group is actually '5th Dynasty'" so the admin
can see both.

## Deploy workflow (CRITICAL - still broken)

The deploy workflow's `envs:` field passes the literal string name
`DOORSERVER_JWT_SECRET` to the SSH step, NOT its value. So the .env
on the VPS got written empty on every push. The fix: use the `env:`
block on the SSH step:

```yaml
- name: Deploy to Hetzner VPS
  uses: appleboy/ssh-action@v1.0.3
  with:
    host: ${{ secrets.HETZNER_HOST }}
    username: root
    key: ${{ secrets.HETZNER_SSH_KEY }}
    env:
      DOORSERVER_JWT_SECRET: ${{ secrets.DOORSERVER_JWT_SECRET }}
    script: |
      cd /app/doorserver
      printf 'DOORSERVER_JWT_SECRET=%s\n' "${DOORSERVER_JWT_SECRET}" > .env
      docker compose up -d --build
```

When I tried this, GitHub rejected the workflow file as "workflow
file issue" - I couldn't diagnose without admin access to the run
logs. The user needs to retry this and find the YAML error.

Manual workaround (what the user did, recorded in the prior
handoff `2026-08-30-jwt-secret-restore.md`):
```bash
cd /app/doorserver
docker compose down
DOORSERVER_JWT_SECRET='XJj8UarJaJ+e8lHm0fnANZg6OQ3u8UARmakBISOCyQcXKmo8mirRQ3/xLGRfASKN' \
  docker compose up -d
```

This is the path the live container is running with right now.

## Files changed this session (commits on main since 2788f16)

- 33322090480 (success, deployed): stats filter
- 71c4694 (success, deployed): migration 13 + fetch-api-groups
- 71c4694 (deployed): migration 13 + scripts/fetch-api-groups.ts

Earlier in session (before 2788f16):
- dea4d92: stats filter
- 71c4694: migration 13 + scripts/fetch-api-groups.ts

## Files NOT yet committed (untracked)

- `scripts/fix-release-groups.ts` - obsolete approach to the same
  problem (was trying to match credits[0].nick.releaser.name against
  the table). Now superseded by scripts/fetch-api-groups.ts which
  goes through the demozoo.org API directly. Safe to delete.

## Quick reference

Repo: `/Users/spot/Code/amiexpress-doorserver`
Live: `https://doors.uprough.net`
Local DB: `data/doors.db` (gitignored)
Local archives: `~/Code/amiexpress_doors/Archives/`

Common commands:
```bash
# Build / typecheck
npx tsc --noEmit
npm run build   # in web/

# Run a one-shot script against local
DOORSERVER_DB=.../data/doors.db \
  DOOR_ARCHIVES_ROOT=.../Code/amiexpress_doors/Archives \
  DOORSERVER_JWT_SECRET=<64+ char string> \
  npx tsx scripts/<name>.ts

# Deploy
git push  # triggers deploy-doorserver workflow automatically

# Manual fix for the JWT issue until the workflow is fixed
ssh user@host
cd /app/doorserver
docker compose down
DOORSERVER_JWT_SECRET=<64+ char string> docker compose up -d
```

## Tips for the next agent

- The deploy workflow bug is the only thing blocking unattended
  deploys. Until it's fixed, every push requires a manual SSH
  container restart with the env set.
- The `api_release_group` column is populated for 1507/1600 doors.
  The bundle producer / API enrichment code hasn't been updated to
  read it yet. When the user adds the groups dialog, it should
  read from this column (or JOIN release_groups) rather than from
  `door_catalog.release_group` directly.
- DIZ banner detection is in place but the UI doesn't render
  the null differently from an empty string. A small follow-up to
  DoorDetail.tsx would make the DIZ tab hide entirely when null.
- The fetch-api-groups script ran once. Re-run with `npx tsx
  scripts/fetch-api-groups.ts` if demozoo.org ever fixes the 33
  doors that errored (timeouts and ECONNRESETs). The script
  already has a --ids=... flag for partial re-runs.
