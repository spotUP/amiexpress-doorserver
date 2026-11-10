# Chat API (`/chat/v1`)

The federated live-chat surface of the door server. A board (a BBS, or the web
door) talks to it with its board key; callers on different boards share rooms,
direct messages, roles and presence. The TypeScript twin of this document is
`contract/chat-types.ts`; `tests/chat-contract-mirror.test.ts` fails when the
two disagree.

Contract version: `1` (echoed on every response as `X-Chat-Contract`).

## 1. Authentication and sessions

Every request carries `Authorization: Board <boardId>.<secret>`, the same key
the achievements and requests surfaces use. A missing or wrong key is 401
`{"error":"unauthenticated"}`. A suspended board gets 403 `board_suspended` on
every write; its reads still work.

A server admin additionally sends `X-Admin-Token: Bearer <jwt>` (the token from
the existing admin login) to moderate across boards. Without a session an admin
may call the moderation, roles and `PUT /motd` endpoints.

Everything except `POST /sessions` and `GET /health` needs a session id:
`X-Chat-Session: <sid>`. A missing header is 401 `unauthorized`.

A session is created with `POST /sessions` and dies after 90 seconds without
any request; the server then emits `left` for every room it was in, and a later
request with that sid is 401 `session_expired`. `DELETE /sessions/current`
closes it at once. Presence is the set of live sessions. Obtain a board key
from the door server operator (`createBoard`, the same key as achievements).

Identity on the wire is `handle@BOARD`, where BOARD is the registered board id
in upper case. The `sysop` flag is trusted from the board (a board vouches for
its own sysops). A handle is 1 to 32 characters with no whitespace, `|` or `@`.

## 2. Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | no key; counts only |
| POST | `/sessions` | body `{handle, sysop?, client?}`; reply `{sid, user, expiresIn}` |
| DELETE | `/sessions/current` | 204 |
| GET | `/rooms.txt` | `?mine=1` optional; ROOMS rows |
| GET | `/rooms` | the same as a JSON array |
| POST | `/rooms` | `{name, topic?, visibility?, kind?}`; kind is `text` (default), `voice` or `art`; reply `{id, name, visibility, kind}` |
| POST | `/rooms/:id/join` | reply `{id, name, topic, motd, members, ops, since}` |
| POST | `/rooms/:id/leave` | 204 |
| GET | `/rooms/:id/members.txt` | MEMBERS rows; status fields appended |
| GET | `/rooms/:id/history.txt` | `?before=<seq>&limit=1..50` (default 20); HISTORY rows, oldest first |
| POST | `/rooms/:id/messages` | `{content, clientId, replyTo?, threadId?, as?}`; reply `{id, seq, at}`. `as` (relay boards only, see below) |
| PUT | `/messages/:id` | `{content}`, author only; reply `{id, seq}` |
| DELETE | `/messages/:id` | author, room op, owning-board sysop, role with perms, admin; 204 |
| POST | `/messages/:id/react` | `{emoji}`; reply `{count}` |
| DELETE | `/messages/:id/react/:emoji` | reply `{count}` |
| GET | `/messages/:id/reactions.txt` | REACTIONS rows |
| POST | `/messages/:id/thread` | `{content, clientId}`; threadId is the parent id |
| GET | `/threads/:id.txt` | `?limit`; HISTORY rows, parent first |
| GET | `/who.txt` | WHO rows across every room visible to the caller; status fields appended |
| PUT | `/presence` | `{status, text?}`; status is `online`, `away`, `busy` or `dnd`, text up to 120 characters (the away message); `online` with no text is the same as DELETE; reply `{status, statusText}`; emits `presence` |
| DELETE | `/presence` | `/back`: clears status and text; reply `{status:"online", statusText:""}`; emits `presence` |
| GET | `/users/:user/profile.txt` | `:user` is `handle@BOARD`; one PROFILE row; 404 `not_found` when the server never saw the user |
| GET | `/ignores.txt` | the caller's ignore list, IGNORES rows |
| POST | `/ignores` | `{user}` (`handle@BOARD`); idempotent; 201; up to 200 per identity |
| DELETE | `/ignores/:user` | remove; always 200 |
| POST | `/rooms/:id/invites` | `{user}`; private rooms |
| DELETE | `/rooms/:id/invites/:user` | revoke; 204 |
| GET | `/dm.txt` | DM rows |
| POST | `/dm/:peer` | `{content, clientId, as?}`; peer is `handle@BOARD`; reply `{id, seq, threadId}` |
| POST | `/dm-group` | `{participants, content, clientId, as?}`; participants are 2 or more `handle@BOARD` besides the sender (3+ unique members in all); reply `{id, seq, threadId}` |
| GET | `/dm/:threadId/history.txt` | `?before&limit&as`; HISTORY rows; marks the peer's messages read |
| GET | `/dm/:threadId/participants.txt` | PARTICIPANTS rows, one `handle@BOARD` per line, sorted; a relay board may read a thread holding one of its users, any other session only a thread it is in; else 403 `forbidden` |
| GET | `/events.txt` | `?since=<seq>&wait=0..25` long poll; EVENTS rows |
| POST | `/rooms/:id/kick` | `{user}` |
| POST | `/rooms/:id/ban` | `{user, reason?}` |
| POST | `/rooms/:id/unban` | `{user}` |
| POST | `/rooms/:id/mute` | `{user, minutes?}`; no minutes means until unmuted |
| POST | `/rooms/:id/unmute` | `{user}` |
| POST | `/rooms/:id/op` | `{user}` |
| POST | `/rooms/:id/deop` | `{user}` |
| PUT | `/rooms/:id/topic` | `{topic}` |
| POST | `/rooms/:id/mode` | `{modes, params?}` (TS `/mode`): modes like `+i`, `-m`, `+ov`; params is the space-separated `handle@BOARD` list the `o`, `v`, `b` flags take in order. `i` = invite-only (private visibility), `m` = moderated (only staff and voiced users speak, else `moderated`), `o` = op, `v` = voice, `b` = mute until unmuted. Room staff only. Reply `{applied, errors}`: applied modes space-separated, per-flag errors `\|`-separated; flags after a bad one still apply |
| POST | `/rooms/:id/typing` | `{text}`: the caller's whole input buffer, empty = stopped typing; trimmed to 200 characters, no error. Room members only (no +m check). Emits a `typing` event; senders throttle to one per 400 ms and always send the final empty text |
| GET | `/rooms/:id/canvas.txt` | `?from=0&count=24&maxBytes=7680`; the shared 80x24 canvas of an **art** room as CANVAS rows, one per canvas row. Members only. Stops before the reply passes `maxBytes` (never above 7680) and reports the rows sent in the header count; ask again from the next row. A room that is not `kind` `art`: 403 `forbidden`. The row is created blank on first use |
| POST | `/rooms/:id/canvas` | `{base, ops}`: apply `ops` (the canvas wire encoding below) to an art room's canvas; reply `{rev}`. Members only. `base` is the revision the caller last saw: informational, never a reason to refuse. Posts apply in arrival order, last writer wins per cell, `rev` goes up by one per post. An `X` (clear) op needs the room owner or a room op, else 403 `forbidden`. 403 on a room that is not an art room; 413 `too_long` over 512 bytes; 422 `bad_request` for bad grammar (the detail names the byte offset) or more than 1920 cells; 429 `rate_limited` over 40 posts per session per 10 seconds. Emits one `canvas` event |
| POST | `/rooms/:id/files` | `{name, size, clientId, as?}`: start an upload of `size` bytes (1 to 2097152) into the room; reply `{id, chunkMax, received, name}`. Members only, with voice in a +m room. `name` is rebuilt by the hub (last path part, accents folded, spaces to `_`, only `A-Za-z0-9._-`, 30 characters at most); a clash in the room gets `_2`, `_3`. The same `clientId` returns the same upload. One unfinished upload per user per room (409 `conflict`). 413 `too_large` over 2 MB; 429 `quota` over 10 MB per user or 100 MB per board per day (`Retry-After` set); 507 `quota` when the hub store is full; 503 `files_disabled` when `CHAT_FILES_DIR` is not set |
| PUT | `/files/:id/chunk` | `?offset=N`, body `application/octet-stream` of 1 to 32768 bytes: append at `offset`. Reply `{received}`. An offset that is not the bytes already received: 409 `conflict` with `received`, send from there. 413 `too_large` over 32768 bytes; 507 `quota` when the hub could not store it (the upload is cancelled). Uploader only |
| POST | `/files/:id/finish` | `{as?}`: close the upload; reply `{id, sha256, kind, name, size}`. 409 `conflict` unless every byte arrived. `kind` is `lha`, `lzx`, `dms`, `zip`, `program` (Amiga hunk executable), `image`, `text` or `binary`. Emits `file_shared`. Calling it again returns the same reply |
| DELETE | `/files/:id` | cancel an unfinished upload, or delete a shared file (`?as=` for a relay board). The uploader, a room op or moderator, or a sysop may. 404 `file_gone` when already deleted. Emits `file_deleted` |
| GET | `/rooms/:id/files.txt` | the room's shared files, newest first, as FILES rows (at most 200). Members only |
| GET | `/rooms/:id/files` | the same list as JSON `{files: [{id, name, size, uploader, at, label, kind, sha256, imgW, imgH}]}`. Members only |
| GET | `/files/:id` | the file bytes. Members only (403 `not_member`); 404 `file_gone` for a deleted or expired file. Always `application/octet-stream` with `Content-Disposition: attachment` and an exact `Content-Length`; `Range: bytes=N-` or `N-M` answers 206 with `Content-Range`. The hub has no virus scanner: treat every file as untrusted |
| GET | `/files/:id/preview.png` | `?cols=C&rows=R`: a picture (`kind` `image`: PNG, JPEG, GIF first frame, IFF ILBM) scaled to fit `C*8 x R*16` pixels (8x16 pixel cells), aspect kept, never enlarged, as an RGB PNG of at most 65536 bytes (scaled down further until it fits). `cols` is clamped to 4..80 (default 32), `rows` to 2..24 (default 10). Headers: `Content-Type: image/png`, exact `Content-Length` (never chunked), `X-Cells: <c>x<r>` = the cells the returned image covers (`ceil(w/8) x ceil(h/16)`). Same access rule as `GET /files/:id`; 415 `not_image` for any other kind. Cached on the hub next to the blob and deleted with it |
| GET | `/files/:id/preview.rgb` | `?cols=C&rows=R`: the same picture as raw RGB, one area-averaged pixel per cell, `c*r*3` bytes row by row, `Content-Type: application/octet-stream`, exact `Content-Length`, same `X-Cells` (`c` x `r`), same clamps and errors |
| GET | `/admin/files` | `X-Admin-Token` only; filters `?room=`, `&board=`, `&uploader=` (exact): JSON `{files: [{id, room, board, name, size, uploader, at, kind, imgW, imgH, sha256}]}`, ready files newest first (at most 500) |
| DELETE | `/admin/files/:id` | `X-Admin-Token` only: delete a file (`why` `sysop`, emits `file_deleted`) |
| PUT | `/rooms/:id/motd` | `{motd}` (at most 500 characters, empty clears); room owner or moderator |
| PUT | `/rooms/:id/visibility` | `{visibility}`; owner or owning-board sysop |
| DELETE | `/rooms/:id` | owner, owning-board sysop, admin; 204 |
| POST | `/rooms/:id/clear` | owning-board sysop or admin; emits `delete` per message; 204 |
| GET | `/motd` | JSON `{text}` |
| PUT | `/motd` | admin only; `{text}` |
| GET | `/discord` | JSON `{on}`: whether the caller's board is mirrored to Discord |
| PUT | `/discord` | `{on: true\|false}` (door `/discord on\|off`); sysop session of the board only, else `forbidden`; reply `{on}`; emits `discord_mirror` when the value changes. Default off: a board that never opted in is never copied to Discord |
| GET | `/discord/boards.txt` | DISCORD rows: the board ids (upper-cased) whose callers the Discord bridge may copy |
| GET | `/roles` | sysop session or admin; JSON array of roles |
| POST | `/roles` | `{name, colorHex, colorAnsi, position?, perms?}` |
| PUT | `/roles/:id` | the same body, replaces |
| DELETE | `/roles/:id` | 204 |
| GET | `/roles/assignments` | `[{handle, roleId}]` |
| PUT | `/roles/assignments/:handle` | `{roleIds}` replaces the set |
| GET | `/rooms/:id/pins` | optional, JSON |
| POST | `/rooms/:id/pins` | `{messageId}`; room op |
| DELETE | `/rooms/:id/pins/:messageId` | 204 |
| GET | `/search` | optional, JSON; `?q=&room=&user=&limit=` |
| GET | `/emoji` | optional, JSON |
| GET | `/emoji.txt` | EMOJI rows: `name|display|ascii` (image emoji list with empty text fields) |
| PUT | `/emoji/:name` | `{display, ascii}` or `{dataUrl}`; sysop of the owning board |
| DELETE | `/emoji/:name` | 204 |
| POST | `/bbs-events` | `{type, username, nodeId, data}`; board auth, no session; relays one BBS event (login, logout, upload, download, door activity, door event, command) to the posting board's own chat sessions; 204 |

A path that matches nothing is a JSON 404 from this API, never the web app.

### Rooms and membership

A room id is 12 hex characters. A room name is 1 to 32 characters of
`A-Z a-z 0-9 _ . -`, unique without regard to case. A public room is listed to
everyone and anyone not banned may join. A private room is listed only to its
members, invitees and the creator; joining needs an invite, otherwise 403
`invite_required`. The creator becomes the owner, an op, and an invitee.
Creating a private room needs a sysop session or a role with `createPrivate`.

Posting needs membership of the session (join first): 403 `not_member`.
`clientId` is the caller's own id for the message (1 to 64 characters); the
same `(room, user, clientId)` twice is 409 `conflict`, which makes a retry
after a lost reply safe. Content is 1 to 500 characters, else 400 `too_long`.

### Moderation

Permission is: a room op, or a sysop session whose board owns the room, or an
admin token, or a role of the caller's board that grants the action (`kick`,
`ban`, `mute`, `topic`) in a room that board owns. Bans are by `handle@BOARD`.
A kicked user may rejoin; a banned one gets 403 `banned` on join and post; a
muted one gets 403 `muted` on post.

## 3. Plain-text formats

House format: one header line `FORMAT|1|<revision>|<count>`, then one row per
line, CRLF after every line including the last, `Content-Type: text/plain;
charset=ISO-8859-1`. A `|` inside a field is replaced by `!`, line breaks and
tabs by a space, and any character above U+00FF by `?`. Every text reply
carries `Content-Length` and `Connection: close` and is never chunked. A new
field is only ever appended and the `1` never moves.

Formats and their fields, in order:

- ROOMS: `id|name|topic|visibility|members|owner|kind` (kind: `text`, `voice` or `art`)
- MEMBERS: `user|sysop|op|roleColor|roleName|status|statusText|label`
- HISTORY: `seq|id|user|at|replyTo|threadId|roleColor|text|label`
- EVENTS: `seq|type|room|user|ref|at|roleColor|text|replyTo|label` (`replyTo` is the
  message id a `message` event answers, empty otherwise)
- REACTIONS: `emoji|count|mine`
- EMOJI: `name|display|ascii`
- WHO: `user|room|sysop|roleColor|idleSeconds|status|statusText|label`
- DISCORD: `board`
- DM: `threadId|peer|lastAt|unread`
- PROFILE: `user|nick|board|status|statusText|firstSeen|lastSeen|idleSeconds|online|sharedRooms`
- IGNORES: `user|at`
- CANVAS: `y|cells` (`y` is the canvas row 0 to 23, `cells` the row in the canvas wire encoding)
- FILES: `id|name|size|uploader|at|label|kind|imgW|imgH` (`kind` is the sniffed type, `imgW`/`imgH` the picture's pixel size, 0 when it is not a picture)

`status` and `statusText` (WHO, MEMBERS, PROFILE) were appended after the
original fields, so a parser that reads the old positions keeps working.
`status` is `online`, `away`, `busy` or `dnd` (PROFILE adds `offline`);
`statusText` is the away message, empty when none. Presence is per user, not
per session, and is dropped when the user's last session ends.

PROFILE only repeats what the server already holds (sessions, the event log,
presence, room membership): `nick` is the handle, `board` the board id,
`firstSeen` the earliest session or event on record, `lastSeen` now while
online, otherwise the newest event, `idleSeconds` empty when offline,
`online` is `1` or `0`, and `sharedRooms` is a comma-separated list of room
ids both the caller and the user are in (map them to names with `rooms.txt`).

`label` (MEMBERS, HISTORY, EVENTS, WHO) is the name to show for `user`: the
bare handle, or the full `handle@BOARD` only when two different users with
that handle are present in the reply or in the rooms it covers. `user` stays
the identity for bans, ignores and DMs; `label` is display only. The text of a
message whose author is `name@DISCORD` (HISTORY rows, EVENTS `message` and
`edit` rows) ends in ` [Discord]`; the marker is never stored and never in
JSON replies.

Relay boards: a board the server admin marked as a relay (`POST
/admin/boards/:id/relay`; the Discord bridge is one) may add `as` to
`POST /rooms/:id/messages`, `PUT /messages/:id`, `DELETE /messages/:id`,
`POST /messages/:id/react`, `DELETE /messages/:id/react/:emoji` and
`POST /messages/:id/thread` (body, or `?as=` on DELETE). The request then acts
as `as@<relay board>`: that user's room membership comes from the relay
session, but bans, mutes, `+m` voice, author-only edit and delete, and the
per-session rate limit apply to the relayed user. `as` can never name another
board's user. Any other board sending `as` gets 403 `not_relay`.

The same `as` works on `POST /dm/:peer`, `POST /dm-group` (body) and
`GET /dm/:threadId/history.txt` (`?as=`): the DM is sent from, or the thread
read as, `as@<relay board>`, with its own per-author rate limit. (Direct
messages have no bans or ignore filtering on the server; a room ban does not
stop a DM.) A relay board's `GET /events.txt` also carries every `dm` event
that has a participant `x@<relay board>`, 1:1 or group, whichever user of the
board sent or received it. Row (the usual EVENTS columns):
`seq|dm|<threadId>|<sender full user>|<message id>|<at>|<role color>|<content>||<sender label>`
for example `42|dm|dm1a2b3c4d5e6f|alice@BBS|dabc123|1700000000||hello||alice`.
`threadId` starts with `dm` (1:1) or `dg` (group); the row does not name the
recipient: `GET /dm/<threadId>/participants.txt` lists the thread's users
(`PARTICIPANTS|1|<rev>|2` then `alice@BBS`, `zed@DISCORD`, one per row) so the
bridge can pick its own; the relay board may read it only for a thread with
one of its users, else 403 `forbidden`. A board that is not a relay still sees only DMs of its own sessions.

Ignore list: the server only stores it, per chat identity, across sessions.
It filters nothing; the door hides an ignored user's lines itself.

`at` is epoch seconds. `sysop`, `op` and `mine` are `1` or `0`. `roleColor` is
the ANSI colour index 0 to 15 of the user's highest role on their own board, or
empty. The revision is the newest event sequence number, except EVENTS and
HISTORY where it is described below.

```text example ROOMS
ROOMS|1|412|2
a1b2c3d4e5f6|lobby|Welcome to the board|public|7|spot@UPROUGH|text
0f9e8d7c6b5a|sysops|Sysops only|private|2|spot@UPROUGH|text
```

```text example MEMBERS
MEMBERS|1|412|2
spot@UPROUGH|1|1|11|Sysop|online||spot
zed@FRIEND|0|0|||busy|deploying|zed
```

```text example HISTORY
HISTORY|1|410|2
409|m1a2b3c4d5e6|spot@UPROUGH|1762500000|||11|Hello everybody|spot
410|m6e5d4c3b2a1|zed@DISCORD|1762500005|m1a2b3c4d5e6||0|Hi spot! [Discord]|zed
```

```text example EVENTS
EVENTS|1|413|2
412|message|a1b2c3d4e5f6|zed@FRIEND|m6e5d4c3b2a1|1762500005||Hi spot!|m1a2b3c4d5e6|zed
413|react|a1b2c3d4e5f6|spot@UPROUGH|m6e5d4c3b2a1|1762500007|11|thumbsup!1||spot
```

```text example REACTIONS
REACTIONS|1|413|1
thumbsup|1|1
```

```text example WHO
WHO|1|413|1
spot@UPROUGH|lobby|1|11|4|away|at lunch|spot
```

```text example PROFILE
PROFILE|1|413|1
spot@UPROUGH|spot|UPROUGH|away|at lunch|1762400000|1762500100|42|1|room1a2b3c4d5e6f
```

```text example IGNORES
IGNORES|1|413|1
zed@FRIEND|1762500100
```

```text example FILES
FILES|1|17|2
fa1b2c3d4e5f6|demo.lha|48213|alice@BOARD|1760000000|alice|lha|0|0
f0f9e8d7c6b5|shot.png|912|bob@OTHER|1759990000|bob@OTHER|image|320|200
```

```text example CANVAS
CANVAS|1|17|2
3|^40#*19;^70 *59;
4| *79;
```

```text example DM
DM|1|413|1
d1d2d3d4d5d6|zed@FRIEND|1762500100|2
```

```text example DISCORD
DISCORD|1|413|2
AEW
UPROUGH
```

An empty poll answers a header with count 0 and no rows:

```text example EVENTS
EVENTS|1|413|0
```

## 4. Event stream

`GET /events.txt?since=<seq>&wait=<0..25>` (`wait` defaults to 20; a missing
`since` means "from now"). The server answers as soon as an event with
`seq > since` that the session may see exists, otherwise after `wait` seconds
with an empty reply. At most 200 rows come back, and the reply stops before it passes `maxBytes` (default and ceiling 7680, so a 68K 8 KB buffer always fits; at least one row is always sent); the header's third field is
the last sequence number returned (or `since` when none): store it as the
next `since`. A held poll holds no database handle.

Each held poll counts against its board: at most 64 per board and 1 per
session. A second poll for the same session releases the first with its
current rows. Over the board cap the answer is 429 `rate_limited` with
`retryAfter`.

Event types and what the columns mean (`text` is the last column and may
itself hold `!`-escaped sub-fields):

| Type | room | user | ref | text |
|---|---|---|---|---|
| `message` | room id, or `t:<parentId>` for a thread reply | author | message id | content |
| `edit` | room id | author | message id | new content |
| `delete` | room id | author | message id | empty |
| `react`, `unreact` | room id | reactor | message id | `emoji!count` |
| `joined`, `left` | room id | who | empty | empty |
| `topic` | room id | who set it | empty | the topic |
| `room_motd` | room id | who set it | empty | the room's message of the day (empty = cleared) |
| `room_created`, `room_deleted` | room id | creator or deleter | empty | room name |
| `kicked`, `unmuted`, `op`, `deop` | room id | the target | empty | the acting user |
| `mode` | room id | who set it | empty | the applied modes, e.g. `+i +o alice@BOARD` |
| `typing` | room id | the typer | empty | the typer's whole input buffer (empty = stopped); receivers expire it after 5 s |
| `canvas` | room id | the drawer | the new canvas revision | the ops, in the canvas wire encoding; every member of the room gets it (their own echo too); never relayed to Discord |
| `file_shared` | room id | the uploader | the file id | `name!size!kind` (the field separator is escaped like any event text) |
| `file_deleted` | room id | who deleted it (`system` for expiry) | the file id | `name!why`; `why` is `uploader`, `op`, `sysop`, `expired` or `room-cleared` |
| `banned` | room id | the target | empty | `actor!reason` |
| `muted` | room id | the target | empty | `actor!minutes` |
| `dm` | `dm:<threadId>` | sender | message id | content |
| `role` | room id, or empty | the user whose role changed | empty | `roleName!colorHex!colorAnsi` |
| `motd` | empty | admin | empty | the message of the day |
| `presence` | room id of each room the user is in (empty when in none) | the user | empty | `status!statusText` |
| `board_joined` | empty | empty | empty | the display name of the board that just opened its first chat session ever |
| `discord_mirror` | empty | the sysop who switched it | the board id, upper-cased | `1` mirror on, `0` off |
| `bbs` | the node id | the BBS user | the BBS event type (`user_login`, `user_logout`, `upload`, `download`, `door_activity`, `custom_door_event`, `command`) | the whitelisted `data` keys, urlencoded (`location`, `duration`, `fileName`, `fileSize`, `conferenceName`, `action`, `doorName`, `eventType`, `message`, `isPersonalBest`) |

A session sees: events in rooms it has joined, direct messages to or from its
user, events about its user, `room_created`, `room_deleted` and `topic` of
public rooms, `motd`, `board_joined` and `discord_mirror`, and `bbs` events of its own board only (another board never sees them). `board_joined` is an event only (no room message is stored), is emitted once per board, never on admin mint or reconnect, and is not emitted for boards that had chatted before it was introduced. The pipe inside the `react`, `banned`, `muted` and
`role` text is shown as `!` because `|` is escaped on the wire.

### Canvas wire encoding

An art room (`kind` `art`) has one shared canvas of 80 columns by 24 rows;
each cell is a character (ISO-8859-1), a foreground and a background colour
(0 to 15) and a blink flag. It starts blank (space, 7 on 0) and lives until
the room is deleted. The encoding is Latin-1 and never contains `|`, `!`, CR
or LF, so the `.txt` escaper leaves it alone. Reserved bytes, which a cell
must write as `~hh`: `|` `!` `^` `~` `*` `@`, and every byte below 0x20.
Every other byte 0x20 to 0xFF is one cell with that character.

| Token | Meaning |
|---|---|
| `X` | clear the whole canvas; only as the first byte; room owner or op only |
| `@x,y:` | start a run at column x, row y (decimal); cells follow left to right; a cell before any run is an error |
| `^fb` | set the pen: f and b one hex digit each (0 to 15); it persists to the end of the string (a snapshot row starts at 7 on 0) |
| `^fbB` | the same pen with blink (a capital `B` right after the pair; to write a letter B as the first cell after a pen, write `~42`) |
| `~hh` | one cell with the byte hh (two hex digits) |
| `*n;` | the previous cell n more times (n at least 1; the run may not pass column 79) |

A snapshot row is the same grammar with `@0,y:` implied. Example, 20 red `#`
at row 3 as an ops string: `@0,3:^40#*19;` (13 bytes).

Conflicts: the hub applies posts in arrival order, last writer wins per cell.
A client applies every `canvas` event in `seq` order, its own echo included,
so all clients end up in hub order; if an event's `ref` is not the local
revision plus one, fetch the snapshot again. To open the view: GET the
snapshot, then apply events whose `ref` is above the snapshot revision.
Undo is client-side only: it posts the previous cells again.

## 5. Roles

Roles belong to a board and apply to that board's users only. A user's colour
is the colour of their highest `position` role. `colorAnsi` (0 to 15) is
required because the 68K door and the telnet path render 16 colours;
`colorHex` is `#RRGGBB` for the web door. Role `perms`
(`kick`, `ban`, `mute`, `topic`, `createPrivate`) add to room-op permission in
rooms the board owns. An assignment change emits a `role` event so clients
recolour live.

## 6. Errors and limits

Errors are JSON `{"error": "<code>", "detail": "<text>", "retryAfter"?: n}`.
Codes: `bad_request`, `unauthorized`, `session_expired`, `forbidden`,
`banned`, `muted`, `not_member`, `invite_required`, `not_found`, `too_long`,
`conflict`, `rate_limited`, `moderated` (a +m room; the caller has no voice or op), `not_relay` (the request carried `as` but the board is not a relay board), `too_large` (413; a file or chunk over its limit), `quota` (429 daily upload quota, 507 hub store full), `file_gone` (404; the file was deleted or expired), `files_disabled` (503; the hub has no `CHAT_FILES_DIR`), `not_image` (415; a preview was asked for a file that is not a decodable picture). A 429 also carries a `Retry-After` header.

Limits (fixed windows in process): 20 messages per session per 10 seconds,
300 messages per board per minute, 30 live sessions per board, 6 room
creations per board per hour, 64 held polls per board, 40 canvas posts per
session per 10 seconds. Reads other than
`events.txt` are not limited. Environment overrides: `CHAT_POLL_MAX_WAIT`
(default 25), `CHAT_SESSION_TTL` (default 90), `CHAT_FILES_DIR` (where file blobs live, outside any served directory; unset turns file sharing off).

File limits: 2 MB per file, 32 KB per chunk, 10 MB per user and 100 MB per board
per day (a relay `as` upload charges the board only), 200 files kept per room,
files expire after 14 days, an idle unfinished upload is dropped after 10 minutes,
clearing or deleting a room deletes its files.

## 7. The 68K polling recipe

1. `POST /sessions` once; keep the `sid`.
2. `POST /rooms/<id>/join`; keep `since` from the reply.
3. Loop: `GET /events.txt?since=<since>&wait=20` with `X-Chat-Session`; parse
   the header, then one row per line with a splitter that stops after seven
   pipes (the eighth field is free text); set `since` to the header's third
   field.
4. Send a line with `POST /rooms/<id>/messages`, a fresh `clientId` per line.
5. On 401 `session_expired`, start again at 1. On exit `DELETE /sessions/current`.

The reply always has `Content-Length` and `Connection: close`, so a client
that reads until the length is met, then closes, needs no chunked decoder.

## 8. Optional endpoints

Pins, full-text search and custom emoji images are web features, not part of
the 68K door; they are small JSON endpoints.

- `GET /rooms/:id/pins` returns `[{messageId, user, content, pinnedBy, at, messageAt}]`;
  `at` is when the message was pinned, `messageAt` when it was posted.
- `GET /search?q=<words>&room=<id>&user=<handle or handle@BOARD>&limit=<1..50>` returns
  `[{id, room, user, at, content}]` from rooms the caller may see.
- `GET /emoji` returns `[{boardId, name, dataUrl, display, ascii}]`; an image
  emoji has `dataUrl` (a `data:image/...` URL of at most 24 KB) and empty
  `display`/`ascii`; a text emoji has `display`/`ascii` (1 to 32 bytes each) and an empty `dataUrl`.
