---
date: 2026-11-10
topic: Discord bridge Phase 1 progress
plan: thoughts/shared/plans/2026-11-09-livechat-discord-bridge.md
status: in progress
---

# Discord bridge - Phase 1 progress ledger

Scope: Phase 1 only. Decisions D1-D7 are final.

## Checklist

Hub (amiexpress-doorserver):
- [x] H1 Migration 11: `boards.chat_relay` (0/1) and `boards.discord_mirror` (0/1, default 0).
- [x] H2 Server-admin route to set/clear the relay flag (`POST /admin/boards/:id/relay`, `/unrelay`), audited like suspend/resume; flag in board summary.
- [x] H3 store: acting identity `as` on postMessage / postThread / editMessage / deleteMessage / react / unreact. Relay board only; non-relay board sending `as` gets 403 `not_relay`. `as` must pass validHandle; user = `as@<own board>`; never another board.
- [x] H4 Relay author checks use the relayed user: idempotency key, mutes, room bans, +m voice, author-only edit/delete, rate key per relayed user (board cap kept).
- [x] H5 Board `discord_mirror` sysop route on the chat surface (`PUT /chat/board/discord` body `{on:boolean}`, sysop session only) + `GET` read; event emitted so the bridge sees the change.
- [x] H6 Hub exposes mirror flag where the bridge reads it (board rows the bridge can fetch).
- [x] H7 D7 labels: hub computes display label per user (bare handle; `handle@BOARD` only when two present users share a handle) and ` [Discord]` marker for DISCORD-origin messages. Exact wire form decided after door survey.
- [x] H8 contract/chat-types.ts rows + docs contract row for `as`, relay, discord_mirror, label.
- [x] H9 Reachability test: HTTP route with relay BoardKey posts `as` (history.txt shows `x@DISCORD`, sentinel), normal BoardKey refused.
- [x] H10 Tests: edit/delete/react via `as`, ban/mute of relayed user, discord_mirror route (sysop vs non-sysop), label clash detection.
- [x] H11 typecheck + affected tests green; commit.

Doors:
- [ ] W1 amiexpress-web TS livechat door: `/discord on|off` (sysop only) calling H5; status text.
- [ ] W2 TS door labels follow D7 (use hub label; no own `@BOARD` building).
- [ ] W3 LIVECHAT68: `/discord on|off` sysop command.
- [ ] W4 LIVECHAT68 labels follow D7.
- [ ] W5 LIVECHAT68 rebuilt and re-released.
- [ ] W6 Other clients building labels themselves checked (web UI etc.).

## Decisions made in this phase
- Relay flag set by server admin only (a board cannot make itself a relay).

## Notes / gotchas
- `sessionsPerBoard` cap and 60 sessions/min charge are why relay exists.
- Hub items H1-H11 done 2026-11-10 (11 of 17; W1-W6 open). Proof: tests/chat-relay-discord.test.ts (7 cases, drives the admin relay route and the chat HTTP routes).
- H5 route as built: `GET /chat/v1/discord` and `PUT /chat/v1/discord` `{on}`; the bridge reads `GET /chat/v1/discord/boards.txt` (format DISCORD) and the `discord_mirror` event (H6).
- H7 wire form: one appended trailing field `label` on MEMBERS (index 7), HISTORY (8), WHO (7), EVENTS (9); the hub appends ` [Discord]` to message text of `@DISCORD` authors. Old parsers that read fixed indexes keep working.
- Found while running affected tests: `POST /dm-group` was never documented in docs/CHAT-API.md (contract-mirror test failed since 7fc6ac8) and tests/achievements/storage.test.ts still expected one migration. Both fixed in the H commit.
- The hub is not deployed yet; `/discord` in a released door answers 404 until it is.
