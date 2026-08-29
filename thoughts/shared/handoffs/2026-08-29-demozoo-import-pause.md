---
date: 2026-08-29
topic: Demozoo import handoff — when demozoo rate limit clears
tags: [demozoo, import, vps, doorserver]
status: draft
---

# Demozoo import — pause-and-resume plan

## Where we are

The import script ran a successful **enumeration** phase: 2399 BBS-Door
productions cached to `/tmp/demozoo-ids-bbs-doors.json` on the VPS.

The **processing** phase (fetching each ID's detail) hit a wall:
- 503 doors were successfully backfilled/registered (already imported)
- 1896 doors remain, but every detail fetch returns 429 or 60s timeout
- Demozoo is rate-limiting our IP hard

We killed the run. We need to wait for the rate limit to clear.

## What was confirmed working

| Concern | Result |
|---|---|
| HTML enumeration at `?production_type=53&page=N` | ✓ cached 2399 IDs |
| `parseFilenameFromUrl()` URL-decodes scene.org paths | ✓ works |
| `splitNameAndVersion()` handles elite `o` as `0` (v1.o → v1.0) | ✓ works |
| `inferRequiresBbs()` matches group names + tag prefixes | ✓ works (Sceptic, Shelter, Outlaws, Decade, etc. all → AmiExpress) |
| `registerExistingFile()` finds local files in archivesRoot recursively | ✓ works (skips `Submitted/` and `node_modules/`) |
| `inferDoorType()` reads `xim`/`arexx`/`cli` tags | ✓ works |
| Backfill (UPDATE existing row) | ✓ works — 503 doors enriched |
| Local file registration (INSERT new row from disk) | ✓ works — 3 doors added in the test |
| Dry-run mode (`--dry-run`) | ✓ works |
| CLI `--ids=1,2,3` mode | ✓ works |
| `recordAudit()` writes audit entries | ✓ works |

## What's still broken / untested

- **Demozoo rate limiting**: 429 + 60s timeouts on detail fetches. The
  per-request retry/backoff helps but doesn't solve the underlying
  IP-level throttling. Need a global pause when ANY request hits 429.
- **The 1896 unprocessed doors** still need to be processed once demozoo
  rate limit clears. They were never re-attempted.

## What we need to do (in ~2 hours, when rate limit clears)

### 1. Pull latest code

```bash
cd /app/doorserver
git pull
npm run build
```

### 2. Verify the cache is still there

```bash
ls -la /tmp/demozoo-ids-bbs-doors.json
# Should show ~2399 IDs (file size ~30-40KB)
# If gone, enumeration will re-run (taking ~8 min)
```

### 3. Test demozoo responsiveness

```bash
curl -sS -w '\nstatus=%{http_code} time=%{time_total}s\n' \
  -o /dev/null \
  'https://demozoo.org/api/v1/productions/283296/?format=json' \
  -H 'User-Agent: AmiExpress-DoorServer/1.0'
```

If `status=200` and `time<2s`: ready to run.
If `status=429` or `time>10s`: wait longer.

### 4. Run with --dry-run first (no writes)

```bash
DOORSERVER_DB="/var/lib/docker/volumes/doorserver-data/_data/doors.db" \
DOOR_ARCHIVES_ROOT="/var/lib/docker/volumes/amiexpress-bbs-data/_data/bbs" \
nohup npx tsx scripts/demozoo-import.ts --dry-run --no-download \
  > /tmp/demozoo-dry.log 2>&1 &
disown
tail -f /tmp/demozoo-dry.log
```

The dry-run reuses the cache file (`/tmp/demozoo-ids-bbs-doors.json`),
so no network calls to demozoo.org during enumeration. The 1896
detail fetches each take ~1.5s + 15s/50 = ~50 min total.

### 5. If dry-run looks clean, run for real (no downloads)

```bash
pkill -f demozoo-import 2>/dev/null
DOORSERVER_DB="/var/lib/docker/volumes/doorserver-data/_data/doors.db" \
DOOR_ARCHIVES_ROOT="/var/lib/docker/volumes/amiexpress-bbs-data/_data/bbs" \
nohup npx tsx scripts/demozoo-import.ts --no-download \
  > /tmp/demozoo-run.log 2>&1 &
disown
tail -f /tmp/demozoo-run.log
```

This will:
- Backfill the 1896 unprocessed doors that match local files (probably zero — most didn't match in the test)
- INSERT the 1896 unprocessed doors that exist on disk as new rows (probably few — most were tested)
- NOT download anything from scene.org

### 6. Decide on downloads separately

After the no-download run, decide how to handle the remaining doors
that don't have local files:
- Most are NOT in the user's archives (no `AmiExpress/FILENAME.LHA`
  match). They're new BBS doors demozoo has indexed that the user
  doesn't have on disk.
- We do NOT want to auto-add 1800+ new doors to the catalog without
  curator review. That's a separate task.
- New doors should be added manually via the admin UI, OR via a
  curated list (e.g. "add all doors tagged X that have description Y").

If the user DOES want to add new doors, run again without `--no-download`.
But expect it to take many hours and download 1800+ files.

## Script flags (final, post-fixes)

```
--ids=123,456,789   Skip enumeration, process only given demozoo IDs
--dry-run           Don't write to door_catalog or demozoo_imported
--no-download       Skip Phase 2 archive downloads
```

The flags can be combined: `--ids=... --dry-run --no-download`.

## Rate-limiting settings (current, may need more tuning)

```ts
PAUSE_BETWEEN_REQUESTS_MS = 1500
PAUSE_EVERY_N_REQUESTS     = 50
PAUSE_DURATION_MS         = 15000
MAX_CONCURRENT            = 3
MAX_RETRIES               = 5
RETRY_DELAYS_MS           = [2000, 8000, 30000, 60000, 120000]
FETCH_TIMEOUT_MS          = 60_000
```

These helped but weren't enough for demozoo's current rate-limit window.
Future improvement: a global "any 429 → all in-flight requests pause
for 5 minutes" coordinator.

## Local DB download (so I can work on it)

To pull the live db from the VPS, from the user's local Mac:

```bash
# SSH-style: from local Mac, copy the db file
scp root@<vps-host>:/var/lib/docker/volumes/doorserver-data/_data/doors.db \
    /Users/spot/Code/amiexpress-doorserver/data/doors.db

# Or use a snapshot via sqlite3 (safer — no race with live server)
ssh root@<vps-host> \
  'sqlite3 /var/lib/docker/volumes/doorserver-data/_data/doors.db ".backup \"/tmp/doors-snapshot.db\"" && \
   gzip /tmp/doors-snapshot.db && \
   cat /tmp/doors-snapshot.db.gz' \
  | gunzip > /Users/spot/Code/amiexpress-doorserver/data/doors.db
```

Then on the local machine, set:
```bash
DOORSERVER_DB=/Users/spot/Code/amiexpress-doorserver/data/doors.db \
DOOR_ARCHIVES_ROOT=/Users/spot/Code/amiexpress_doors/Archives \
  npx tsx /Users/spot/Code/amiexpress-doorserver/scripts/demozoo-import.ts --ids=...
```

This lets me work on the db locally without touching the live system.

## Open question

The 1896 unprocessed doors — do we want to:
(a) Leave them and only process the 503 already-imported ones (no work needed)
(b) Add a global pause on 429 so the script can wait out the rate limit (need code change)
(c) Add a `wait-for-rate-limit-reset` mode that does exponential backoff across many minutes (need code change)
(d) Skip processing the new ones entirely — only the 503 known doors are valuable

My recommendation: **(a)** for now. The 503 are done. The 1896 are unknown doors that the user may not want auto-added anyway. The "right" path is curated additions via the admin UI.

## Current commit (relevant)

- `e5345e4` — more conservative rate-limiting
- `2b6c120` — 60s fetch timeout
- `b5788f3` — startup logging

All deployed to VPS.
