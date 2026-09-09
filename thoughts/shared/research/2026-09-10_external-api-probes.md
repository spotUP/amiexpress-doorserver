---
date: 2026-09-10
topic: External scene API probes for the integrations plan
tags: [integrations, pouet, demozoo, asciiarena, research]
status: final
---

# Live probes (2026-09-10, from dev machine, curl)

All keyless sources answer. Shapes below are what the adapters must parse.
Recorded fixtures for `test:ci` must be captured from these, never hand-written.

## Pouet 2.0 (`https://api.pouet.net/v1/`, no key)

Doc: `https://api.pouet.net/` (endpoint list). No `api.php` (404s).

- Random: `GET /v1/prod/?random=true` -> `{success:true, prod:{id,name,type,addedUser:{nickname},addedDate,...}}`
- Search: `GET /v1/search/prod/?q=logic` -> `{success:true, results:{"60678":{id,name,type,...}}}` (OBJECT keyed by id, not array)
- Party search: `GET /v1/search/party/?q=...` (same shape)
- Front page: `/v1/front-page/latest-added/`, `/latest-released/`, `/alltime-top/`, `/top-of-the-month/` -> `{success:true, prods:[{rank, prod:{...}}]}`
- Detail: `/v1/prod/?id=1`, party `/v1/party/?id=1&year=2000`

## Demozoo (`https://demozoo.org/api/v1/`, no key)

TRAP: `api.demozoo.org` is NXDOMAIN. Base is `demozoo.org/api/v1/`.

- Prod detail: `GET /api/v1/productions/1/` -> `{id,title,author_nicks[],platforms[],types[],demozoo_url,...}`
- Parties search: `GET /api/v1/parties/?q=revision` -> DRF `{count,next,previous,results:[{id,name,tagline,start_date,end_date,location,country_code,...}]}`
- (Productions search endpoint TBD at adapter time — detail + parties verified; check `/api/v1/productions/?q=` when writing the adapter.)

## AsciiArena (`https://asciiarena.se`, no key, 120 req/min/IP)

Guide: `/Users/spot/Desktop/asciiarena-bot-api-v1-chatbot-guide.md`.

- Verified: `/api/v1/search?q=spot` -> `{data:{query,collys[],logos[{id,label,filename,html_url,api_url,...}],...}}` (NOT the flat `{data:[...],meta}` envelope — search nests per-section arrays)
- Verified: `/api/v1/status` -> `{data:{service,version,endpoints[...]}}`
- Detail per guide: `/api/v1/logos/456` adds `lines[]` + `colly_url`.
- Note: `text` for `manual:false` rows is a preview window, not exact bounds.

## Internet Archive (no key for reads)

- Verified: `advancedsearch.php?q=demoparty&fl[]=identifier,title&rows=2&output=json` -> `{response:{numFound,docs:[{identifier,title}]}}`
- Detail per plan: `/metadata/<id>`. Cache aggressively (their one rule).

## demoparty.net feeds (no key)

- Verified: `https://www.demoparty.net/demoparties.xml` -> 200, ~38 KB (RSS, matches WHIP's existing parser expectations).

## scene.org

- No index API; per-URL HEAD checks before handing download URLs to callers. (Probe of a mirror index dir 404'd — checks must target actual file URLs.)

## 16colo.rs via GitHub mirror

- UNRESOLVED: `raw.githubusercontent.com/16colo/artpacks/main/README.md` 404s. Find the real mirror repo path during Phase 4; do not guess it into the adapter.

## Keyed (later phases, NOT probed)

- ModArchive (forum-issued key), TMDB + OMDb (free keys), radio (Icecast `status-json.xsl` opportunistic).
