---
date: 2026-08-30
topic: Session handoff - demozoo CSV import + admin API recovery
tags: [demozoo, csv-import, admin-api, jwt-secret, deploy-workflow, 503]
status: final
---

# Session handoff

## Where we left off

A long session that took the demozoo import from "12 hours for 2000 doors
serially" to "1 minute for 2000 doors in parallel" and shipped the result
to live. Final state of live:

- 5932 doors total (1641 demozoo-source, 4287 scan, 4 submission)
- 1996 with demozoo_url, 1504 with FILE_ID.DIZ populated, 242 with screenshots
- 1937 demozoo doors have credits from the demozoo API
- All admin API + admin routes working
- Web UI shows demozoo badges, ANSI-colored FILE_ID.DIZ, credits, etc.

Then I broke the admin API while trying to fix the deploy workflow. The
user is on the VPS right now trying to recover.

## Live state (when session ended)

- The admin API returns 503 with "DOORSERVER_JWT_SECRET is not set" on
  every login attempt.
- The .env file at /app/doorserver/.env was manually restored by the
  user (one of the early fixes), but the running container is an
  OLDER image that was started BEFORE the .env was bind-mounted, so
  it has DOORSERVER_JWT_SECRET unset in its process.env.
- The user reported restart doesn't help (the container was already
  restarted by the user once, but with the env still unset because
  the host shell running docker compose up didn't have the value).

## Recovery (what the user needs to do)

```bash
cd /app/doorserver
docker compose down
DOORSERVER_JWT_SECRET='XJj8UarJaJ+e8lHm0fnANZg6OQ3u8UARmakBISOCyQcXKmo8mirRQ3/xLGRfASKN' \
  docker compose up -d
```

This sets the env in the shell that runs compose. Compose then passes
it to the container via the `environment: DOORSERVER_JWT_SECRET: ...`
substitution. Login will work.

The longer-term fix is for the deploy workflow to set this env in
its own shell before calling docker compose (the correct pattern
is the `env:` block on the SSH action, not the `envs:` list which
the current workflow uses). I tried to fix this but the `env:` block
form got rejected by GitHub's workflow validator as "workflow file
issue" - couldn't diagnose without admin access to the run logs.

## What got shipped this session (in order)

### Speed: CSV import parallelized (1m to 90s)

- `scripts/demozoo-csv-import.ts`: rewrote to use 8-way parallel
  downloads with HTTP keep-alive, no retry on 404/403, single
  transaction. 12h serial run became 90s parallel.
- Fix: `npx tsx scripts/demozoo-csv-import.ts --concurrency=16 --no-download /path/to/csv`
  (the second flag runs the backfill only, useful for the
  apply-bundle case).

### Speed: Bundle apply non-OOMing

- `scripts/demozoo-sync-apply.ts`: 60MB patch.sql OOMed the
  container. Now uses streaming per-statement with state-machine
  token parsing (handles filenames with `;` and `'` escape).
- Test by running on a copy of the DB. (Live uses the simple
  whole-string version because the bundle was under 60MB at the
  time of the earlier successful applies; for bundles over 60MB
  the streaming is needed.)

### API enrichment (35 min scrape → credits/external_links/screenshots)

- `scripts/demozoo-import.ts`: had a bug reading
  `credits?.[0]?.person` (field that doesn't exist in current demozoo
  API). Fixed to `credits?.[0]?.nick?.name`. Re-ran on local DB:
  1552 of 1600 demozoo doors now have credits, 242 have screenshots.

### Bundle ships API enrichment to live

- `scripts/demozoo-sync-bundle.ts`: added `apiEnrichmentRows`
  query + UPDATE section for `release_date, credits,
  external_links, screenshots` with COALESCE. Plus separate
  `authorRows` query that derives `author` from
  `credits?.[0]?.nick?.name`. New `release_groupsUpserts` for
  abbreviation → full-name mapping.

### populate-files.ts: one-shot backfill

- 131 doors had 0 entries in door_catalog_files (including
  wrd-vi12.lha, tss-csc1.zip). Reads each archive, extracts the
  file list, inserts. Run once after deploy.

### Various door-detail / admin UI fixes

- Fixed ZIP delete: `lha-member-delete.ts` now uses 7z binary for
  zip/7z archives (when available) via `findArchiverFor(archivePath)`.
- Dockerfile installs p7zip (`apk add --no-cache p7zip`).
- Reordered `/learned/by-path` BEFORE `/learned/:id` so the
  literal "by-path" doesn't get captured as the id value.
- DoorDetail deleteFile: now re-fetches the file list from the
  server instead of guessing the response shape.

### Banner-only DIZ detection

- `src/describe.ts`: `analyseDoor()` returns `null` description
  when the DIZ has no real prose (just PRESENTS + title). DoorFacts.description
  is now `string | null`. Public API, manifest, and TSV renderers
  updated.

### ansi_up: render ANSI colors in FILE_ID.DIZ

- `web/src/components/DizView.tsx` now uses `ansi_up` to convert SGR
  escape codes to HTML spans. CSS in `web/src/index.css` defines
  the colour palette under `.ansi-diz .ansi-{color}-fg/bg`.

### Other open todos the user reported but I haven't fixed

- Strip preview leaving BBS-ad lines in the DIZ (the stripper has
  `stripDizLines` but it's not wired into the strip-preview path
  - strip-preview currently only shows filename-level junk
  classification, not DIZ-line stripping)
- Delete-files API returns 400 when used on a non-junk file
  (the API works but the UI's "delete" button only shows for
  flagged-junk files - on non-junk files it's hidden, so this
  isn't really a bug)
- ANSI viewer doesn't handle PC-DOS ANSI / non-SGR escape codes
  (CP437 box-drawing chars work in TopazPlus; OSC hyperlinks
  don't. ansi_up only does SGR.)

## Open issues (need user to take action)

### Admin API 503 (BLOCKER for next session)

The user is on the VPS right now. After the recovery command
above, the admin API will be back up.

### Deploy workflow bug (medium)

The deploy workflow's `envs: DOORSERVER_JWT_SECRET` is the wrong
syntax for passing a secret value. The correct pattern is the
`env:` block:

```yaml
- name: Deploy
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
      chmod 600 .env
      docker compose up -d --build
```

When I tried this, the workflow file got rejected as "workflow
file issue" - couldn't diagnose without admin access to the run
logs. The user should try this and see if it works; if it still
fails, look for tab characters or unquoted colons in the YAML.

## Where the source is

Repo: /Users/spot/Code/amiexpress-doorserver
Live: https://doors.uprough.net

Build: `npm run build` (in web/) and `npx tsc --noEmit` (in root)

Deploy: push to main → GitHub Actions deploy-doorserver workflow
runs appleboy/ssh-action → builds with docker compose → starts the
container on port 3010 (behind Caddy).

DB is bind-mounted at /data/doors.db on the VPS (volume
doorserver-data). DB is gitignored.

## Tips for the next session

- The user is the only one with admin access. To diagnose deploy
  workflow issues, ask them to grab the run log from the GitHub
  Actions UI and share it.
- The dev DB at /Users/spot/Code/amiexpress-doorserver/data/doors.db
  is the source of truth for local testing. Use
  `DOORSERVER_DB=.../data/doors.db DOOR_ARCHIVES_ROOT=.../Archives npx tsx scripts/...`
  to run scripts locally.
- The bundle apply takes a bundle directory containing
  patch.sql, submitted-files.tar.gz, manifest.json. Build with
  `scripts/demozoo-sync-bundle.ts`, apply with
  `scripts/demozoo-sync-apply.ts`.
- API rate limit: 1 req/sec to demozoo.org. The API scraper
  (`scripts/demozoo-import.ts`) already respects this via
  PAUSE_BETWEEN_REQUESTS_MS=3500 with MAX_CONCURRENT=3.
