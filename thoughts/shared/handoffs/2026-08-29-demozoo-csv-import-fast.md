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

```bash
# ── LOCAL: import + build bundle (run once, takes ~90 sec) ───────────
cd /Users/spot/Code/amiexpress-doorserver
npx tsx scripts/demozoo-csv-import.ts /Users/spot/Downloads/bbs-doors.csv --concurrency=16
npx tsx scripts/demozoo-sync-bundle.ts /tmp/demozoo-bundle

# ── LOCAL: ship bundle to live (rsync, takes ~10 sec for 60 MB) ──────
rsync -avz /tmp/demozoo-bundle/ root@<vps>:/tmp/demozoo-bundle/

# ── LIVE: apply bundle (takes ~30 sec, includes sha256 verify) ───────
ssh root@<vps> 'cd /app/doorserver && \
  git pull && npm run build && \
  DOORSERVER_DB="/var/lib/docker/volumes/doorserver-data/_data/doors.db" \
  DOOR_ARCHIVES_ROOT="/var/lib/docker/volumes/amiexpress-bbs-data/_data/bbs" \
  npx tsx scripts/demozoo-sync-apply.ts /tmp/demozoo-bundle'
```

Total time on live: 2-3 minutes. No downloads against scene.org.

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
