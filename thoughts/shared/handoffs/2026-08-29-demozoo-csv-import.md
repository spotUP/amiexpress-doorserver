---
date: 2026-08-29
topic: Demozoo CSV import — done locally, ready to run on VPS
tags: [demozoo, import, vps, doorserver, csv]
status: final
---

# Demozoo CSV import — next steps

## What was done

1. **Schema**: added `door_catalog.demozoo_url` (TEXT) + migration 12.
   Already pushed to main, will run on next VPS deploy.

2. **CSV importer** (`scripts/demozoo-csv-import.ts`):
   - Reads `/Users/spot/Downloads/bbs-doors.csv` (2251 data rows)
   - Matches existing `door_catalog` rows by `archive_name` (case-insensitive)
   - Backfills NULL columns with CSV data (release_date, platform,
     download_url, author, version, name, demozoo_url)
   - Downloads new archives from CSV URLs to `<archivesRoot>/Submitted/`
   - Inserts new `door_catalog` rows for non-matches
   - Resumable via `demozoo_csv_imported` table
   - `ftp://ftp.scene.org` rewritten to `https://` (Node has no FTP client;
     scene.org serves the same bytes over HTTPS)

3. **UI updates**:
   - DoorDetail "About" tab: Platform, Released date, Links (with Demozoo
     badge + external links), Credits block
   - DoorTable row: small "DZ" badge linking to Demozoo when set
   - `demozooUrl` added to public `Door` type

4. **Local test** (against `data/doors.db`):
   - 441 doors backfilled with demozoo_url
   - 1678 new doors queued for download (--no-download mode)
   - 132 rows skipped (empty download URL)

## Current status (2026-08-29)

Local DB run is in progress:
- Backfill: 402 existing doors enriched with demozoo_url
- New downloads: ~50 done in first 2 minutes (rate limited by scene.org
  at ~30/min). 1717 total to download.
- Skipped (no filename): 132 rows (empty download URLs in the CSV)

Script runs in background. To monitor:
```bash
tail -f /tmp/demozoo-csv-import.log
ls /Users/spot/Code/amiexpress_doors/Archives/Submitted/ | wc -l
sqlite3 /Users/spot/Code/amiexpress-doorserver/data/doors.db \
  "SELECT source, COUNT(*) FROM door_catalog GROUP BY source"
```

## To run on the live VPS

After the code deploys (migration runs on start), SSH to the VPS and run
the backfill (no-download first, so the catalog just gets enriched without
waiting on 1678 scene.org downloads):

```bash
cd /app/doorserver
git pull
npm run build

# Backfill only — no downloads. Fast (~5 sec).
DOORSERVER_DB="/var/lib/docker/volumes/doorserver-data/_data/doors.db" \
DOOR_ARCHIVES_ROOT="/var/lib/docker/volumes/amiexpress-bbs-data/_data/bbs" \
nohup npx tsx scripts/demozoo-csv-import.ts /root/bbs-doors.csv --no-download \
  > /tmp/demozoo-csv-backfill.log 2>&1 &
disown
tail -f /tmp/demozoo-csv-backfill.log
```

Then, if you want the new downloads, kick that off in the background.
This will take a while — ~1700 small files at scene.org speed:

```bash
DOORSERVER_DB="/var/lib/docker/volumes/doorserver-data/_data/doors.db" \
DOOR_ARCHIVES_ROOT="/var/lib/docker/volumes/amiexpress-bbs-data/_data/bbs" \
nohup npx tsx scripts/demozoo-csv-import.ts /root/bbs-doors.csv \
  > /tmp/demozoo-csv-download.log 2>&1 &
disown
tail -f /tmp/demozoo-csv-download.log
```

The script is resumable — if you stop it and restart, it skips rows in
`demozoo_csv_imported`.

## Script flags

- `--dry-run` — don't write DB rows, don't download. Reports what it
  *would* do.
- `--no-download` — backfill only, skip new archives.
- (no flag) — backfill + download.

## Copy the CSV to the VPS

```bash
scp /Users/spot/Downloads/bbs-doors.csv root@<vps-host>:/root/bbs-doors.csv
```

## What the CSV doesn't have (vs the live API scraper)

The existing `scripts/demozoo-import.ts` script scrapes demozoo.org's
API and gets rich data: `credits`, `external_links`, `screenshots`,
`requires_bbs` (inferred from group + tag), `door_type` (inferred from
tag), `release_group` (extracted from author_nicks).

The CSV only has 6 fields:
- Demozoo URL
- Title
- By (author)
- Release date
- Platform
- Download URL

To get the rich fields for the 441 backfilled doors, run the existing
`scripts/demozoo-import.ts` after the CSV import — it scrapes the
demozoo.org API for each production and enriches the rows we just
backfilled with credits/external_links/screenshots/etc.

The CSV importer and the API scraper complement each other:
- CSV importer: fast bulk backfill + download
- API scraper: per-row enrichment with credits, etc.

## Open question

Do we want the 1678 new door downloads? Most are MS-DOS doors (the CSV
is 60% PC). Curator might prefer to add them via the admin UI
deliberately rather than auto-import 1700 unknowns.

Recommendation: backfill only first, then decide.
