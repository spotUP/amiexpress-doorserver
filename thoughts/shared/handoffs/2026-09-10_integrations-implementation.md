---
date: 2026-09-10
topic: External scene APIs for operator chats, full implementation
tags: [integrations, answer, admin, chatbot, deploy, handoff]
status: final
---

# Session handoff 2026-09-10: integrations plan implemented end to end

## Tasks (all done, all live)

1. Phases 1-2: store (migration 16: config/secrets/cache) + Pouet,
   Demozoo-live, AsciiArena adapters + `/answer` fan-out + `/status`.
2. Phase 3: IA, scene.org HEAD checks (`/check` + SSRF guard),
   ModArchive/TMDB/OMDb keyed (dark until configured, doc-derived
   fixtures marked for recapture).
3. Phase 4: demoparty.net feed, 16colors artpacks (git-tree index, daily
   cache, 4MB retry), scene-radio (settings-driven, unconfigured by
   default). Fairness fix: round-robin interleave (global slice dropped
   whole sources).
4. Phase 5: custom JSON-REST sources (validation, dot-path mapping,
   auth modes, validated redirects, test preview, TTL tightening).
5. Phase 6: admin API (`/api/door-repo/admin/integrations/*`) + React
   Integrations panel + Demozoo-import/releases health cards.
6. Phase 7: `docs/BOT-API.md` integrations section + BBS `ask_scene`
   tool (amiexpress-web 55475ea67, search/random/latest/check).
7. Deploy: manual treesync of 51 files (checksums match), secrets
   re-exported from docker inspect, rebuild, migration 16 ran live.

## Critical references

- Live: `https://doors.uprough.net/api/integrations/v1/answer?q=X`,
  `/status`, `/check?url=`; panel: site Integrations button (admin).
- Deploy (manual, Actions do not land): scp union tarball, checksum
  diff, `docker compose up -d --build` with secrets re-exported.
  Container `doorserver-doorserver-1`, checkout `/app/doorserver`.
- Research: `thoughts/shared/research/2026-09-10_external-api-probes.md`
  (verified endpoints + shapes + the two traps: api.demozoo.org
  NXDOMAIN, Pouet search results are id-keyed objects).
- Plan: `thoughts/shared/plans/2026-09-10-external-apis-admin.md`
  (status partial, landed notes).

## Recent changes (commits on main, pushed)

- `b8891b7` phases 1-2, `2543d29` phase 3, `5cda594` phase 4,
  `1e72790` phase 5, `a44fce1` phase 6, `ecf9ba7` phase 7 docs.
- Full suite 761 passed; 68 integrations tests; tsc + web build clean.

## Learnings (gotchas)

- `router.use('/x', sub)` + `sub.get('/x')` double-prefixes silently
  (admin 404s with valid auth - check the full path first).
- A global result cap slices off trailing sources; round-robin keeps
  every contributor visible (caught by the router test, not review).
- Unconfigured-but-ok sources (radio) veto all-failed stale logic;
  key the fallback on empty-merged, not on all-failed.
- Pouet latest-added items are bare prods, not {rank, prod}.
- 16colo has no GitHub file mirror (FTP/RSYNC only); the searchable
  index is sixteencolors' per-year pack-zip tree (1.4 MB - over the
  shared 1 MB cap, hence ResponseTooLarge + retry).
- Doorserver deploy needs secrets re-export per rebuild or
  achievements/JWT silently disable (existing gotcha, still true).

## Next steps (ordered)

1. Sysop: paste ModArchive/TMDB/OMDb keys in the panel, Test each,
   recapture doc-derived fixtures with real responses.
2. Sysop: point radio at a station (status-json.xsl URL) or leave dark.
3. Sysop: try a custom source end to end (Add API -> Test -> ask the
   operator chat); confirm degrade line when a source is disabled.
4. BBS side: `ask_scene` deploys via the web auto-deploy (verify live
   revision past 55475ea67 before testing in chat).

## Other notes

- `.env` + `logs/dev-server.log` stay untracked; never commit.
- `web/tsconfig.tsbuildinfo` churns on every web build; reverted, not
  committed.
