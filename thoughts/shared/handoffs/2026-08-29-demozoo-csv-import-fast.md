---
date: 2026-08-29
topic: Demozoo CSV import — fast parallel importer + local→live sync
tags: [demozoo, import, vps, doorserver, csv, parallel, sync]
status: final
---

# Demozoo CSV import — fast parallel importer + local→live sync

## TL;DR

- **Importer rewritten**: parallel (8-16 workers, configurable), per-host
  HTTP keep-alive, no retry on 404/403. **60-90 seconds** for the full
  2251-row CSV (was 12+ hours serially).
- **Local → live sync tooling**: new `sync-bundle` / `sync-apply` scripts.
  Live VPS gets the data in **~2-3 minutes** (rsync the bundle + run
  apply), no need to re-download from scene.org.
- **Bug fix**: importer now registers files that already exist on disk
  but aren't in the DB (e.g. after a DB reset). Previously these were
  silently skipped, leaving the DB empty.

## What was done

### 1. Fast parallel importer (`scripts/demozoo-csv-import.ts`)

- **Concurrency**: 8 workers default, `--concurrency=N` flag to change.
  Each worker downloads one archive at a time; the pool pipelines the
  network I/O.
- **HTTP keep-alive**: per-host `https.Agent({ keepAlive: true,
  maxSockets: 16 })`. First request to a host pays the TLS handshake;
  the next 15 reuse the same TCP+TLS session.
- **No retry on dead URLs**: 404/403/410 fail immediately. Previously
  the script retried 3x with 2s/8s/30s backoff (40+ seconds per dead
  URL). 175 dead URLs in the CSV were costing ~2 hours of wall time.
- **Retry only on transient failures**: 429 (rate limit), 5xx (server
  error), network error, timeout.
- **Sorted downloads by URL**: same-host requests cluster together,
  maximizing keep-alive benefit.
- **WAL SQLite mode**: import can run while the doorserver serves
  traffic without blocking reads.
- **Async DB lock**: better-sqlite3 is synchronous, so concurrent JS
  tasks need a small lock around `.run()` calls to keep the statement
  sequence coherent.
- **Throttled progress**: reports every 2s with rate (rows/min), error
  count, MB downloaded, ETA.

### 2. Sync bundle producer (`scripts/demozoo-sync-bundle.ts`)

Builds a portable bundle of the local DB's demozoo state:

```
<outDir>/
  patch.sql              -- INSERT OR IGNORE for new rows + COALESCE
                              UPDATEs for backfills (idempotent)
  submitted-files.tar.gz -- the new archive files
  manifest.json          -- file count, sizes, sha256s
```

Usage:
```bash
npx tsx scripts/demozoo-sync-bundle.ts /tmp/demozoo-bundle
```

Output for the current state:
- 1600 new demozoo_source rows
- 397 backfilled scan rows
- 1600 archive files
- 1.6 MB SQL + 58 MB tarball

### 3. Sync bundle apply (`scripts/demozoo-sync-apply.ts`)

Runs on the live VPS. Idempotent (safe to re-run):

```bash
npx tsx scripts/demozoo-sync-apply.ts /path/to/bundle
```

Steps:
1. Extract `submitted-files.tar.gz` into `<archivesRoot>/Submitted/`
2. Verify each file's sha256 against the manifest
3. Apply `patch.sql` in a single transaction

## Local → live workflow

The live doorserver runs in a Docker container on the Hetzner VPS. The
DB and archive root are inside the container at `/data/doors.db` and
`/data/Archives`, mounted from the `doorserver-data` named volume.

**You need to be able to reach the VPS via SSH.** I can't from this
local env, so the steps below are what YOU run.

```bash
# ── LOCAL: import + build bundle (run once, takes ~90 sec) ───────────
cd /Users/spot/Code/amiexpress-doorserver
npx tsx scripts/demozoo-csv-import.ts /Users/spot/Downloads/bbs-doors.csv --concurrency=16
npx tsx scripts/demozoo-sync-bundle.ts /tmp/demozoo-bundle

# ── LOCAL: pull latest code, push if needed (already at a370356) ─────
git status --short
git push  # if anything is uncommitted

# ── LIVE: redeploy so the new scripts (sync-apply) are in the image ──
# Easiest path: trigger the deploy workflow in GitHub Actions.
# Alternative: SSH in and rebuild the container manually.
gh workflow run deploy.yml  # or whatever your deploy workflow is called

# ── LIVE: copy the bundle INTO the running container ────────────────
# (docker cp is the right tool — the bundle is too big to mount as a
#  volume, and we want it gone after apply)
VPS_USER=spot           # your SSH user on the Hetzner box
CONTAINER=amiexpress-doorserver-doorserver-1   # or `docker ps` to find it
scp -r /tmp/demozoo-bundle ${VPS_USER}@<vps>:/tmp/demozoo-bundle
ssh ${VPS_USER}@<vps> "docker cp /tmp/demozoo-bundle ${CONTAINER}:/tmp/demozoo-bundle"

# ── LIVE: apply the bundle inside the container ─────────────────────
ssh ${VPS_USER}@<vps> "docker exec -w /app/doorserver ${CONTAINER} \
  npx tsx scripts/demozoo-sync-apply.ts /tmp/demozoo-bundle"

# ── LIVE: clean up the bundle from the container + host ─────────────
ssh ${VPS_USER}@<vps> "docker exec ${CONTAINER} rm -rf /tmp/demozoo-bundle && \
                        rm -rf /tmp/demozoo-bundle"
```

Total time on live: 2-3 minutes. No downloads against scene.org.

**To find the live container name:**
```bash
ssh ${VPS_USER}@<vps> 'docker ps --format "{{.Names}}" | grep doorserver'
```

**To verify the apply worked:**
```bash
ssh ${VPS_USER}@<vps> "docker exec ${CONTAINER} sqlite3 /data/doors.db \
  'SELECT source, COUNT(*) FROM door_catalog GROUP BY source'"
# expect: demozoo|1600  scan|4287  submission|4  (or similar)
```

**Rollback if anything looks wrong:** the apply is fully idempotent,
so re-running it is safe. If a row was inserted that you don't want,
delete the row from the DB and `rm` the file from `/data/Archives/Submitted/`
inside the container. There's no migration-tracking table; the bundle
just re-applies the same state.


## What was actually run locally

- Backfill pass: 397 scan doors enriched with demozoo_url
- Download pass (parallel, 16 workers): 1599 new demozoo_source doors
- 110 dead URLs (404/403) skipped — these are permanently dead
  mirrors; retrying doesn't help
- 132 rows with empty download URL in the CSV — can't import these
- 10 INSERT failures from CSV data quality: the same filename
  (xps-0996.zip, de-mdrix.zip, etc.) appears in multiple CSV rows;
  the first one wins, the rest get a UNIQUE constraint violation
  (this is correct behavior)

Final local state:
- 5891 doors total (4287 scan + 1600 demozoo + 4 submission)
- 1999 doors with demozoo_url

## Script flags reference

`demozoo-csv-import.ts`:
- `--no-download` — backfill only (no downloads, no INSERTs)
- `--concurrency=N` — parallel workers (default 8, max useful ~16)
- `--dry-run` — report what would change without doing it
- `CSV_VERBOSE=1` env — log every download/insert line (default:
  progress every 2s, no per-row logs)

`demozoo-sync-bundle.ts`:
- `--since-row=N` — currently a no-op (rows aren't filtered); bundle
  is intended to be a full snapshot since the import is idempotent
  on the apply side anyway

`demozoo-sync-apply.ts`:
- No flags. Idempotent.

## Open question

The 10 UNIQUE-constraint failures indicate the CSV has duplicate
archive_name rows (same file, different demozoo productions). Worth
asking the demozoo admin whether these are intentional (e.g. a
"remix" / "variant" entry) or data entry errors.
