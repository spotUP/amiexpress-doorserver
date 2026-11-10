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
- [x] W1 amiexpress-web TS livechat door: `/discord on|off` (sysop only) calling H5; status text. (amiexpress-web 7ad55f71a)
- [x] W2 TS door labels follow D7 (use hub label; no own `@BOARD` building). (amiexpress-web 7ad55f71a)
- [x] W3 LIVECHAT68: `/discord on|off` sysop command. (amiexpress-web a7742c9f8)
- [x] W4 LIVECHAT68 labels follow D7. (amiexpress-web a7742c9f8)
- [ ] W5 LIVECHAT68 rebuilt and re-released.
- [x] W6 Other clients building labels themselves checked (web UI etc.).

## Decisions made in this phase
- Relay flag set by server admin only (a board cannot make itself a relay).

## Notes / gotchas
- `sessionsPerBoard` cap and 60 sessions/min charge are why relay exists.
- Hub items H1-H11 done 2026-11-10 (11 of 17; W1-W6 open). Proof: tests/chat-relay-discord.test.ts (7 cases, drives the admin relay route and the chat HTTP routes).
- H5 route as built: `GET /chat/v1/discord` and `PUT /chat/v1/discord` `{on}`; the bridge reads `GET /chat/v1/discord/boards.txt` (format DISCORD) and the `discord_mirror` event (H6).
- H7 wire form: one appended trailing field `label` on MEMBERS (index 7), HISTORY (8), WHO (7), EVENTS (9); the hub appends ` [Discord]` to message text of `@DISCORD` authors. Old parsers that read fixed indexes keep working.
- Found while running affected tests: `POST /dm-group` was never documented in docs/CHAT-API.md (contract-mirror test failed since 7fc6ac8) and tests/achievements/storage.test.ts still expected one migration. Both fixed in the H commit.
- The hub is NOT deployed (checked 2026-11-10 with `gh run list`): every Deploy door server and Tests run since 2026-11-09T12:27Z fails in 4 seconds with "The job was not started because recent account payments have failed or your spending limit needs to be increased". Undeployed on doors.uprough.net: 7fc6ac8 (dm-group), d5e1f0d, bcd226b. `/discord` in any door answers 404 until the deploy runs.
- W3/W4 (amiexpress-web a7742c9f8, sdk/c): `ae_chat_discord()` / `ae_chat_discord_set()`, `discord_typed()` in livechat.c, labels from HISTORY index 8, WHO index 7, EVENTS index 9 with fallback to the user field. Open gaps: search rows, pin rows and the typing indicator still show the user field; no fixture sends a label that differs from the user through the door screen.
- W5 state: `make livechat-release` built `sdk/c/build/release/LiveChat68.lha` (418290 bytes, git-ignored) on 2026-11-10. NOT published. Publishing per the A10 steps in amiexpress-web `thoughts/spot/livechat68-alpha-ledger.md` means: rig proof first (A9 rule: never publish an unproven binary), copy the binary to `board/Doors/LIVECHAT68/LIVECHAT68`, file LIVECH68.LHA in Scene Tools (Conf6) on bbs.uprough.net, GitHub release on spotUP/livechat68. Waits for the hub deploy.
- W6 survey: the only client that builds a name from the hub rows is the board backend `web/backend/src/services/chat-federation/chat-session-bridge.ts` (parses by named column, so the extra field broke nothing). Unaffected: bots/whip/src/feed.ts (board socket only), board/Doors/card-lobby/lib/live-chat.ts (announcements only), doorserver web/src/pages/Integrations.tsx (no chat text), web/backend/dev-scripts/chat-export.ts (reads the board's own database).
- W1/W2 (amiexpress-web 7ad55f71a): the TS door never calls the hub; the board backend's `chat-session-bridge.ts` does. `/discord` = door command emitting `chat:discord`; the bridge does GET/PUT `/chat/v1/discord` through `chat-client.ts` and replies `chat:discord {message,on}`. With federation off the door waits 3 seconds, then says "Discord mirror needs the federated chat." Labels go through `shown(r)` in the bridge. Proof: web/backend/tests/chat/chat-federation-discord.test.ts (enters at `handleFederatedChatEvent`), board/Doors/livechat/tests/discord-mirror.test.ts.
- Open after W1: (a) transport-event ruling for `chat:discord` in web/backend/src/server/transport-event-rulings.ts plus the pin in tests/transport/transport-adapter.test.ts (264 to 265, web-only 130 to 131); waits for session amiexpress-web-02 to commit its four rulings first. (b) Not exercised: the first-person socket path through door.handler.ts:189, and anything against a live hub.
- Pre-existing door test failure, not from this work: voice-telnet.test `voiceCommandsAndHelpFollowTheTransport` ("telnet help has no voice lines"). Cause: overlays/help-content-1.ts line 54 "/create <name> ... asks Text, Voice or Art" from 7aa65194c matches the test's /voice/i.
- Phase 1 count: 16 of 17. W5 open (archive built, not published).
