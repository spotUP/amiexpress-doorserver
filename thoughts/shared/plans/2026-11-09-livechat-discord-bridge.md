---
date: 2026-11-09
status: decided, ready to implement (phase 1 first)
supersedes: amiexpress-web board/Doors/livechat/DISCORD_BRIDGE_DESIGN.md (2024-12-24, never built)
---

# LiveChat <> Discord bridge (replan)

## Why the old design is dead

The 2024 design bridged the TypeScript LiveChat door's Socket.IO events inside one
board's backend. Since then chat moved to the federation hub (this repo,
doors.uprough.net): rooms, messages, DMs, edits, reactions, typing and the event
stream live here, shared by every board (amiexpress-web, LIVECHAT68 on real
AmiExpress boards such as Uptown). A bridge in one board's backend would only see
that board. The bridge belongs at the hub.

## Shape

A separate process ("bridge"), deployed next to the hub on doors.uprough.net as its own
compose service. To the hub it is one more registered board, id `DISCORD`, with
its own BoardKey. Discord users appear on every BBS as `handle@DISCORD`, the
same identity form as `spot@AEW` (sessions.ts userOf).

- Hub -> Discord: the bridge holds one session (`bridge@DISCORD`) joined to the
  mapped rooms and long-polls `GET /events.txt`. Message events go to the mapped
  Discord channel through a channel webhook, username `handle@BOARD`, so each
  BBS caller shows as their own name. Edit / delete events edit / delete the
  webhook message. Reply events become Discord replies.
- Discord -> hub: discord.js gateway bot reads MESSAGE_CREATE / UPDATE / DELETE in
  mapped channels, ignores messages from its own webhooks (loop guard) and bots,
  and posts to `POST /rooms/:id/messages` as `<discordname>@DISCORD`.
- Id map: bridge-local SQLite table hub_message_id <-> discord_message_id, so
  edits, deletes and replies find their twin. Pruned with hub event retention.
- Text: hub wire is Latin-1 (render.ts toLatin1Safe). Discord -> hub converts
  unicode emoji to `:name:`, custom emoji `<:x:id>` to `:x:`, mentions
  `<@id>` to `@name@DISCORD`, strips markdown to plain text, attachments to
  their URL. Hub -> Discord escapes Discord markdown and @everyone/@here, and
  disables mentions in webhook posts (allowed_mentions none).
- Moderation: Discord users are ordinary hub users: bans, mutes, ignores and
  room modes apply through the existing hub paths. A hub ban on `x@DISCORD`
  drops that author's messages at the bridge too.
- Failure isolation: bridge down = hub and boards unaffected; the bridge resumes
  from its last seen event seq (stored), Discord side reconnects via discord.js.

## Hub change needed (one)

Posting as many Discord users through one board hits `sessionsPerBoard`
(CHAT_LIMITS) and the 60 sessions/min charge if every author gets a session.
Add a "relay board" flag on the board row: a relay board's session may post with
an `as` handle (validHandle, user = `as@<its board>`), never as another board's
user. Enforced and tested in store.postMessage / editMessage / deleteMessage.
Alternative (no hub change, worse): one session per Discord author, expired
after idle; breaks with more active Discord users than the session cap.

## Phases (each ends with its reachability test)

1. Hub: relay-board flag + `as` handle on post/edit/delete/react; contract row;
   test drives the HTTP route with a relay BoardKey and a normal one (refused).
2. Bridge skeleton: config (room <-> channel map, hub URL, BoardKey, Discord
   token from host .env, never in git), event loop with stored seq, id map.
3. Hub -> Discord messages (+ edit/delete/reply). Test: fake hub event stream
   and fake Discord REST; asserts webhook payload and allowed_mentions.
4. Discord -> hub messages (+ edit/delete/reply). Test: fake gateway events,
   real hub app in-process (supertest), asserts history.txt row `x@DISCORD`.
5. Text conversion both ways (pure functions, table tests incl. Latin-1).
6. Deploy: compose service, health line, restart policy; docs row; live check
   in the lobby with one BBS caller and one Discord account.

Out of v1 unless decided otherwise: reactions, typing, presence, DMs,
threads, file uploads, Discord slash commands.

## Decisions

Answered 2026-11-09:

- D1 Placement: sidecar process registered as board DISCORD (as in "Shape").
- D2 Rooms: per-board opt-in. Each sysop decides whether their board's chat is
  mirrored to Discord. Default off. (Direction and where the switch lives: D5, D6.)
- D3 Display: identity stays `handle@BOARD` inside the hub (uniqueness, bans),
  but callers should not see `@BOARD` / `@DISCORD` after every name: the screen
  is too narrow. Show the name only; mark Discord origin after the message text.
  (Exact form: D7.)
- D4 v1 scope: messages + edit / delete / reply. Reactions, typing, presence later.
- D5 Not opted in: that board's messages never go to Discord (filtered in the
  bridge by the author's board). Its callers still see Discord messages.
- D6 Switch: sysop command in the chat door, `/discord on|off`, stored per board
  on the hub (new board column + route; sysop flag from the session). No config
  file, no door re-release needed just for the setting. Hub exposes the flag on
  the event/board rows the bridge reads.
- D7 Names: every user shown by bare handle (no `@BOARD`); Discord messages get
  ` [Discord]` after the text. When two users with the same handle from
  different boards are both present in the room, the hub shows `@BOARD` for
  those two only. Render change lives in the hub (render.ts label) so the 68K
  and web doors both follow; check doors that build labels themselves.

## Phase changes from the answers

Phase 1 adds: board `discord_mirror` flag + sysop route + `/discord` command in
both doors; label rendering per D7 with clash detection; tests for both.
Phase 3 filters out authors whose board has the flag off.
