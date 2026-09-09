---
date: 2026-09-10
topic: External scene APIs for operator chats + admin management
tags: [api, admin, chatbot, pouet, demozoo, modarchive]
status: partial
landed: "Phases 1-7 done, live on doors.uprough.net (b8891b7, 2543d29, 5cda594, 1e72790, a44fce1, ecf9ba7); BBS ask_scene tool on origin/main 55475ea67"
verify: "src/integrations/answer\\.ts"
---

# External APIs for operator chats, manageable in the admin panel

## Goal

Operator chats on the BBS answer *"tell me about / find me / surprise me"*
from live scene sources through one thin proxy, and every integration —
new ones here plus prior ones (Demozoo enrichment) — is managed in the
BBS web admin panel: keys, enable/disable, health, cache. No SSH, no
`.env` editing, no redeploy to rotate a key.

## Prior art (already in the repo)

- `src/demozoo-bbs.ts` + `scripts/demozoo-import.ts`: Demozoo enrichment,
  driven by script flags, zero admin visibility. Becomes integration #1
  in the panel (status: last import, rows enriched).
- `src/releases/*`: AquaScan listing + `/releases/v1/*` — the doorserver's
  OWN API needs no management, but the panel shows its revision/count as
  a health signal (data the chats consume).
- Secrets today live in env (`DOORSERVER_JWT_SECRET`, achievements SMTP).
  The panel must NOT move those — only integration keys/secrets, stored
  in a new table, never returned by any read endpoint.

## Integrations (priority order)

1. **Pouët 2.0** (`api.pouet.net/v1/`, no key): random prod, latest-added,
   top-of-month, search, parties. Highest value, zero auth.
2. **Demozoo live** (public, no key): credits, parties, screenshots for
   what Pouët returns; plus panel status for the offline enrichment.
3. **Internet Archive** (no key for reads): `advancedsearch.php` +
   `/metadata/<id>` for downloads. Cache aggressively (their one rule).
4. **scene.org link checks**: HEAD requests against download URLs before
   handing them to callers. No key, no index to keep.
5. **ModArchive** (free key, forum application): search, random, charts,
   downloads by ID. Key confidential, server-side only.
6. **TMDB + OMDb** (free keys): films/TV + IMDb ratings. No IMDb scraping.
7. **demoparty.net feeds** (iCal/RSS, no key): party calendar fallback
   behind Pouët/Demozoo party data.
8. **16colo.rs via GitHub mirror** (no key): raw ANSI fetches for
   *"show me an ANSI"*, CP437-safe serving.
9. **Radio now-playing** (opportunistic): Icecast `status-json.xsl` where
   exposed; ERICADE token API only if needed.

Out of scope: CSDb, Aminet, HOL (no APIs); MobyGames (approval-gated);
write paths anywhere (chats are read-only).

## Custom (user-defined) integrations

The panel also accepts NEW sources nobody hardcoded: a generic JSON-REST
adapter driven entirely by stored config, so adding an API never needs a
deploy. Constraints keep it safe and small:

- GET only, `https://` only, 10s timeout, 1 MB response cap, no redirects
  to `http://` or private-network hosts (SSRF guard).
- Auth modes: none, `?api_key=` query param, `Authorization: Bearer`,
  custom header name. The secret itself lives in `integration_secrets`
  (write-only, same as built-ins).
- Response mapping: dot-paths into the JSON (`items: "results"`,
  `title: "title"`, `id: "id"`, `detail: "overview"`, `url: "link"`),
  configured per endpoint (`search`, `random`, `detail`). No scripting,
  no templates — if a source needs more, it graduates to a real adapter.
- The card's Test button shows raw JSON side-by-side with the mapped
  preview, so a curator sees immediately what the chat will say.
- Custom sources get the same enable toggle, TTL, health checks, and
  audit logging as built-ins, and appear in `/answer` fan-out with
  attribution like any other source.

## Architecture

- `src/integrations/`: one adapter per source (`pouet.ts`, `demozoo.ts`,
  `archiveorg.ts`, `sceneorg.ts`, `modarchive.ts`, `tmdb.ts`, `artpacks.ts`,
  `radio.ts`) behind a common `{ id, name, needsKey, search(), random(),
  health() }` shape. Adapters read config + secrets from the store, never
  env directly.
- `GET /api/integrations/v1/answer?q=` (name TBD): intent → fan-out →
  cached, HTML-stripped, Latin-1-safe plain text with source attribution.
  The BBS operator chat calls this ONE endpoint, never sources directly
  (Amiga stacks can't do TLS; keys must never leave the server).
- SQLite cache table (`integration_cache(key, body, fetched_at, ttl)`);
  per-source TTLs; cache-first serving with background refresh.
- `integration_config(source, enabled, settings_json)` + `integration_secrets(source, key_name, secret_ref)`:
  secrets write-only via `POST` (never in `GET` responses, never logged).

## Admin panel (`web/src/pages/Integrations.tsx`)

- Card per integration: status dot (live health-check result + latency),
  enabled toggle, key fields (password inputs, "saved ●●●" state, rotate),
  source-specific settings (TMDB language, cache TTL), "Test" button
  firing a canned query, last-error surface.
- Prior integrations appear as cards too: Demozoo enrichment (last import
  time, rows enriched, re-run trigger emitting the existing script's
  parameters), releases listing (revision, row count, uploader coverage —
  read-only signals).
- All admin routes behind the existing curator auth; secrets endpoints
  rate-limited; audit-log key rotations via the existing `admin_audit`.

## Phases + verification

1. Store + migrations (`integration_config`, `integration_secrets`,
   `integration_cache`) with tests; secrets never serialize (test asserts
   GET bodies contain no secret values).
2. Pouët + Demozoo-live adapters + `/answer` skeleton; contract tests with
   recorded fixtures (no live HTTP in `test:ci`).
3. IA + scene.org checks + ModArchive/TMDB/OMDb adapters (keys via panel).
4. Feeds (demoparty), artpacks (GitHub raw), radio (Icecast probe).
5. Generic custom-source adapter + "Add API" flow in the panel (config
   validation, SSRF-guard tests, raw-vs-mapped test preview).
6. Admin panel UI + health dashboard; manual pass: disable a source,
   rotate a key, break a URL, add a custom source end-to-end — panel
   must show it all, chats must degrade with attribution ("Pouët is
   down, here's Demozoo").
7. Docs: extend `docs/BOT-API.md` with the chat endpoint + admin guide.

Success: a curator enables ModArchive with a pasted key, tests it, and
the operator chat answers a music question — all without touching SSH.
