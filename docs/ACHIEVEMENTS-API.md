# Achievements API

> This API is served by the `amiexpress-doorserver` repository, as a second
> surface beside the door repo. It is not proxied by any BBS.

A multi-board HTTP API for a GLOBAL achievement system: one catalog, one
player identity per email, one set of unlocks, shared by every AmiExpress
board - amiexpress-web and original 68K AmiExpress alike. Boards report RAW
EVENTS; the server owns the rules, evaluates them, and answers with the
unlocks and the progress. **No board ever evaluates a rule.**

This document is the complete reference for a board author. Its shapes are
frozen from
`amiexpress-web/docs/superpowers/specs/2026-09-03-global-achievements-design.md`
and mirrored, field for field, in `contract/achievement-types.ts`, which is
what a TypeScript client compiles against.
`tests/achievements/contract.test.ts` fails the build if this document and
that module drift apart.

**Every example below is captured from the real server**, the way
`docs/DOOR-REPO-API.md`'s are. One ordered walk - register, verify, link,
publish a door's definitions, report events, read the catalog, the
leaderboard and a profile, unlink - is driven through the real application,
as `tests/achievements/doc-story.ts` builds it, and
`scripts/capture-achievements-examples.ts` writes what came back into the
fenced blocks marked `<!-- capture: ... -->`. Re-capture with
`npm run capture:achievements-doc`.

The walk is re-run on every CI run by
`tests/achievements/doc-examples-are-real.test.ts`, which fails if this
document and the server disagree about any field, count or status - so an
example here cannot go stale in the direction of the reader. Codes,
timestamps, revisions and seasons differ every run and are compared by shape;
everything else is compared exactly. A listing too long to print whole is
cut, and the cut is stated under the fence.

Capturing found what reading could not: `POST /events` and
`GET /players/<email>` were reporting a freshly unlocked achievement as
`rarityPctTenths: 0` - held by nobody, the most legendary number the bucket
table has - while the catalog reported the documented floor of `1000` for
the same achievement in the same breath. The prose here had been right about
that floor for weeks.

## Contents

1. Base URLs and transports
2. Authentication
3. Headers on every response
4. Endpoint reference
5. The event contract
6. Terminal versus retryable
7. The plain-text formats
8. Versioning
9. Curation: issuing board keys

---

## 1. Base URLs and transports

- **HTTPS:** `https://doors.uprough.net/achievements/v1`
- **Plain HTTP:** `http://doors.uprough.net/achievements/v1` - the same
  paths, no TLS.

Plain HTTP is a first-class, permanently supported access path, not a legacy
fallback: classic AmigaDOS TCP/IP stacks (AmiTCP, Miami, Roadshow) and
68020+ door clients frequently have no practical way to do TLS. The
production reverse proxy carries an explicit exemption for the
`/achievements/v1/` prefix from its site-wide automatic HTTPS redirect, the
same exemption `/api/door-repo/*` already has. **Every other path on this
host still redirects plain HTTP to HTTPS.**

**The board key travels in clear on the plain path.** So does a link code
during registration, and so does the player's email address. This is stated
plainly because the door has to state it to the caller before asking for an
address. The mitigations are structural rather than cryptographic:

- a board key can only report for emails linked to THAT board, and can be
  revoked in one row;
- link codes are single-use and expire in fifteen minutes;
- every unlock records the board it happened on, so a board can be suspended
  and its unlocks recomputed out of the global leaderboard without touching
  anyone's local scoreboard;
- the web BBS uses HTTPS always - plain HTTP exists only for hosts that
  cannot do TLS.

Accepted residual risk: a passive observer on a 68K board's network can
capture that board's key and report as that board until it is rotated.

## 2. Authentication

Every request carries:

```
Authorization: Board <board-id>.<secret>
```

The board id is the first half of the key and is **not** a secret - it is
already the prefix of every `ref` the board sends. It is there so the server
can find exactly one row and run exactly one password verification against
it: the key hash is scrypt with the same parameters `src/auth.ts` uses
(~50 ms, 32 MB), and an opaque key would have forced the server to try every
board on every request, on the hottest write path in the system.

| Situation | Status | Body |
|---|---|---|
| No `Authorization` header, or not the `Board` scheme | `401` | `{"error":"unauthenticated"}` |
| The key names no board | `401` | `{"error":"unauthenticated"}` |
| The board id is right and the secret is wrong | `401` | `{"error":"unauthenticated"}` |
| The board is suspended | `403` | `{"error":"board_suspended"}` |

The three `401` cases are deliberately indistinguishable: the refusal never
says which half of `<board-id>.<secret>` was wrong.

A suspended board's WRITES are what the `403` refuses. Its reads still
answer: suspension exists to stop a board reporting, not to break the
catalog display in its door for callers who did nothing wrong, and a read
returns only what that board could already see.

A verified key is cached in-process for five minutes, but the board row is
still read on every request and the cache entry is honoured only while that
row's key hash is unchanged and the board is still not suspended. **A
rotation or a suspension therefore takes effect on the very next request**,
with no cache to flush and no window to wait out.

`GET /health` needs no key. The curation routes under `/admin/boards` take
an admin token instead of a board key (section 9).

## 3. Headers on every response

| Header | Value |
|---|---|
| `X-Achievements-Contract` | the contract version, currently `1` |
| `X-Achievements-Revision` | the CATALOG revision, e.g. `a62-t1757000000` |
| `Content-Type` | `application/json; charset=utf-8`, or `text/plain; charset=ISO-8859-1` for the `.txt` variants |

Both `X-` headers are set on **every** response, errors included, so a
client can notice a catalog change without asking for the catalog, and can
tell this API's own `401` apart from a reverse proxy's.

The catalog revision has the shape `a<count>-t<newest updated_at>`. It is
never a git SHA: a deploy that changed no achievement must not invalidate a
good client's cache.

**There is no `Access-Control-Allow-Origin` header on this surface, on any
route, deliberately.** The door repo is public, read-only and meant to be
read from a browser; this surface requires a board key on every request, and
a board key must never be inside a browser.

## 4. Endpoint reference

Fifteen board-facing endpoints. All paths below are relative to
`/achievements/v1`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/players` | register an email and a handle; mails a code |
| POST | `/players/verify` | exchange the code for a verified profile |
| POST | `/players/resend` | mail a fresh verification code |
| POST | `/links` | link THIS board to a player |
| DELETE | `/links` | unlink THIS board |
| POST | `/links/rotate` | issue a fresh link code |
| POST | `/events` | report a batch of at most 100 events |
| GET | `/catalog` | the achievement catalog, JSON, full or incremental |
| GET | `/catalog.txt` | the same, as CRLF / Latin-1 text for 68K |
| PUT | `/catalog/doors/<door>` | register a door's own achievement definitions |
| GET | `/leaderboard` | ranks, JSON |
| GET | `/leaderboard.txt` | the same, as text |
| GET | `/players/<email>` | one player's profile, unlocks and progress |
| PATCH | `/players/<email>` | set the private flag or change the handle |
| GET | `/health` | liveness and counts |

### POST /players

Register a player. The handle is the only identifier any other board or any
listing ever shows.

<!-- capture: players.register.request -->
```json
{
  "email": "caller@example.com",
  "handle": "Spot"
}
```

Answers `202` with:

<!-- capture: players.register.response -->
```json
{
  "queued": true
}
```

**`202` is the answer whether or not the address already exists.** The
response never reveals whether an email is registered. A second registration
of an existing email creates no second player: it queues a fresh code to the
same address and changes nothing else. The lowercased, trimmed email is
the identity.

**A re-registration cannot rename an existing player.** A different handle
in a second registration is accepted and ignored, because anyone who knows
the address could otherwise rename the player. A verified player renames
through `PATCH /players/<email>` from a linked board.

Rules:

- Handles are 3-16 characters matching
  `^[A-Za-z0-9][A-Za-z0-9 ._-]{2,15}$` and are unique case-insensitively.
  Leading and trailing whitespace is TRIMMED before that pattern is applied
  and before the uniqueness check, so no listing ever shows a padded name
  and padding is not a way around a handle somebody already holds.
- The email is validated shallowly: one `@`, a dot in the domain, at most
  254 characters. The emailed code is the real proof; deep validation is the
  mail server's job.
- The code is six characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` - 31
  symbols, with `0`, `O`, `1`, `I` and `L` left out because it is typed off
  a screen on a real Amiga keyboard. It lives thirty minutes and burns after
  five wrong attempts.

| Status | Meaning |
|---|---|
| `202` | accepted; a code is queued |
| `400` | `bad_email`, or `bad_handle` |
| `409` | `handle_taken` - that handle belongs to another player; ask for another |
| `429` | `rate_limited` |

**Mail is queued, never sent inline.** A registration made while the SMTP
server is refusing connections still answers `202` and still keeps the code:
the HTTP response must not wait on an SMTP handshake, and a registration
must survive the mail server being down.

### POST /players/verify

<!-- capture: players.verify.request -->
```json
{
  "email": "caller@example.com",
  "code": "A23TKT"
}
```

Answers `200` with a `PlayerProfile` carrying the player's first link code:

<!-- capture: players.verify.response -->
```json
{
  "handle": "Spot",
  "verified": true,
  "private": false,
  "points": 0,
  "linkedBoards": [],
  "unlocks": [],
  "progress": [],
  "linkCode": "FQ9MRE",
  "linkCodeExpiresAt": "2026-09-07T19:04:00.000Z"
}
```

**No response from this API ever contains an email address.** The profile
identifies the player by `handle` only.

| Status | Meaning |
|---|---|
| `200` | verified; the profile and a link code are returned |
| `400` | `bad_code`, `code_expired`, or `code_burned` (five wrong attempts) |
| `429` | `rate_limited` |

A code is single-use: a second verify with the same code is `bad_code`. An
unknown email answers `bad_code` as well, so the endpoint is not a register
of who has signed up.

### POST /players/resend

<!-- capture: players.resend.request -->
```json
{
  "email": "caller@example.com"
}
```

Answers `202` `{"queued": true}`, always. A new code REPLACES the old one,
which is what makes "resend" and "rotate" the same operation. Per-address
mail limits apply (`429`, section on rate limits below).

### POST /links

Links **the key's board**. There is no board field in the body, ever.

<!-- capture: links.link.request -->
```json
{
  "email": "caller@example.com",
  "code": "FQ9MRE"
}
```

<!-- capture: links.link.response -->
```json
{
  "linked": true,
  "boards": [
    "uprough"
  ],
  "linkCode": "A6SB2Q",
  "linkCodeExpiresAt": "2026-09-07T19:04:00.000Z"
}
```

The link code is **single-use**, and a successful link issues the NEXT one
in the same response - so a player linking three boards types three
different codes, and a captured code is worthless after one use. Codes live
fifteen minutes.

Linking an already-linked board is an idempotent success and changes
nothing.

| Status | Meaning |
|---|---|
| `200` | linked (or already linked) |
| `400` | `bad_code`, or `code_expired` |
| `403` | `unverified_player` - verify first |
| `429` | `rate_limited` |

### DELETE /links

<!-- capture: links.unlink.request -->
```json
{
  "email": "phantasm@example.com"
}
```

<!-- capture: links.unlink.response -->
```json
{
  "linked": false,
  "boards": []
}
```

Unlinks **the key's board only**. A board key can never unlink another
board. It takes no code: the player is standing at that board's ACHIEVE
door, which is the proof.

Unlinking stops future reporting. **It does not delete unlocks** - those
record the board they were earned on - and it does not undo the fact that
the player once linked that board, which is what the `boards.linked.*`
achievements count.

### POST /links/rotate

<!-- capture: links.rotate.request -->
```json
{
  "email": "caller@example.com",
  "code": "A6SB2Q"
}
```

<!-- capture: links.rotate.response -->
```json
{
  "linkCode": "QK9QTQ",
  "linkCodeExpiresAt": "2026-09-07T19:04:01.000Z"
}
```

For a player whose code expired before they reached the next board.

### POST /events

The write path. A batch of at most 100 events, idempotent by `ref`.

<!-- capture: events.clean.request -->
```json
{
  "events": [
    {
      "ref": "uprough:01J8Z4M0000000000000000001",
      "email": "caller@example.com",
      "type": "msg.post",
      "at": "2026-09-07T18:49:01Z",
      "value": 1,
      "key": "conf:2",
      "door": null,
      "client": "amiga"
    }
  ]
}
```

Response:

<!-- capture: events.clean.response -->
```json
{
  "accepted": 1,
  "duplicates": 0,
  "rejected": [],
  "notLinked": [],
  "unlocks": [
    {
      "id": "msg.post.1",
      "name": "First Words",
      "tier": "bronze",
      "points": 5,
      "hidden": false,
      "rarityPctTenths": 1000,
      "at": "2026-09-07T18:49:01.000Z"
    },
    {
      "id": "rare.newboard.first",
      "name": "Ground Floor",
      "tier": "gold",
      "points": 25,
      "hidden": true,
      "rarityPctTenths": 1000,
      "at": "2026-09-07T18:49:01.000Z"
    }
  ],
  "progress": [
    {
      "id": "boards.same.3",
      "have": 1,
      "need": 3
    },
    {
      "id": "msg.burst.3",
      "have": 1,
      "need": 3
    }
  ]
}
```
*(the first 2 of 14 `progress` entries.)*

#### Per-event verdicts

**A fault that belongs to ONE ROW does not reject the batch.** A batch is
drained from an outbox that mixes players and event types, so one unknown
type or one unlinked player would otherwise take ninety-nine good events
with it - and the sender would have no way to tell which row to drop.

- `rejected` names the `ref` of every event that was dropped, with a reason.
  **Every entry is TERMINAL** (section 6): the sender deletes that row and
  never retries it.
- `notLinked` lists the email addresses whose link to this board is missing,
  so the board can arm its linking explanation for exactly the right
  callers, once, rather than once per event.

Reasons: `unknown_event_type`, `not_linked`, `unknown_player`,
`unverified_player`.

<!-- capture: events.mixed.response -->
```json
{
  "accepted": 1,
  "duplicates": 1,
  "rejected": [
    {
      "ref": "uprough:01J8Z4M0000000000000000402",
      "reason": "not_linked"
    },
    {
      "ref": "uprough:01J8Z4M0000000000000000403",
      "reason": "unknown_event_type"
    }
  ],
  "notLinked": [
    "stranger@example.com"
  ],
  "unlocks": [],
  "progress": [
    {
      "id": "msg.post.10",
      "have": 8,
      "need": 10
    },
    {
      "id": "msg.conf.distinct.10",
      "have": 1,
      "need": 10
    }
  ]
}
```
*(the first 2 of 6 `progress` entries.)*

#### Batch-level faults

These are faults of the REQUEST, not of a row, and they refuse the whole
batch. **Nothing is stored** when one of them fires.

| Status | Error | When |
|---|---|---|
| `400` | `bad_request` | the body is not `{"events":[...]}` |
| `400` | `batch_empty` | zero events |
| `400` | `batch_too_large` | more than 100 events |
| `400` | `event_missing_field` | an event lacks `ref`, `email`, `type` or `at` |
| `400` | `event_field_too_long` | a `ref` over 128 characters, or a `type` over 64 |
| `400` | `meta_type_rejected` | any event whose `type` begins `meta.` |
| `403` | `not_linked` | EVERY event in the batch is for a player who has not linked this board |
| `429` | `rate_limited` | over the write rate; `Retry-After` in seconds |

`meta_type_rejected` is batch-level and not per-event on purpose: a board
posting into the server's internal event stream is an attack signal, not a
typo (section 5).

The whole-batch `403 not_linked` is the single-player case the 68K door
always sends. A mixed batch answers `200` with `notLinked` instead.

#### Idempotency

`(board_id, ref)` is a primary key. A resent `ref` is a duplicate **by
construction**, counted in `duplicates`, and folds nothing into any counter.
This is what makes a client with no outbox and no history - the 68K door -
safe to run any number of times.

### GET /catalog

<!-- capture: catalog.since.request -->
```
GET /achievements/v1/catalog?since=a66-t1788806940
```

<!-- capture: catalog.since.response -->
```json
{
  "contractVersion": "1",
  "revision": "a67-t1788806941",
  "since": "a66-t1788806940",
  "achievements": [
    {
      "id": "door.grandmaster.first_win",
      "name": "First Blood",
      "description": "Win a game of chess",
      "family": "door",
      "tier": "bronze",
      "points": 5,
      "hidden": false,
      "rule": {
        "op": "count",
        "type": "door.grandmaster.win",
        "n": 1
      },
      "rarityPctTenths": 1000,
      "rarityBucket": "common",
      "updatedAt": "2026-09-07T18:49:01.000Z"
    }
  ]
}
```

- `ETag: "<revision>"`, and a matching `If-None-Match` answers `304` with no
  body.
- `since` is a previously returned revision. Only achievements changed since
  it are returned. **A `since` that does not parse returns the FULL catalog
  and a `200`** - never a `400`. An old client with a mangled cursor must be
  able to recover, not be bricked.
- Hidden achievements are LISTED with `hidden: true`, but carry the name
  `???` and an empty `description` until the requesting board has a linked
  player who has unlocked one. The flag alone would let any client print the
  answer.

`rarityPctTenths` is an integer in **tenths of a percent** - `81` is 8.1% -
because a C89 door has no float parsing worth relying on. `rarityBucket` is
`common` above 25%, `uncommon` 10-25%, `rare` 2-10%, `epic` 0.5-2%,
`legendary` below 0.5%. **With fewer than twenty verified players every
achievement is `common` at `1000`**: on day one the arithmetic would
otherwise make everything legendary.

| Status | Meaning |
|---|---|
| `200` | the catalog |
| `304` | `If-None-Match` matched the revision |
| `401` / `403` | see section 2 |

### GET /catalog.txt

The same data in the house plain-text format (section 7). Same `since`, same
`ETag`, same `304`.

<!-- capture: catalog.txt.response -->
```
GET /achievements/v1/catalog.txt
Authorization: Board uprough.<key>

HTTP/1.1 200 OK
Content-Type: text/plain; charset=ISO-8859-1
X-Achievements-Contract: 1
X-Achievements-Revision: a67-t1788806941

ACHIEVE|1|a67-t1788806941|67<CR><LF>
boards.linked.10|boards|gold|25|0|Scene Veteran|Link ten boards|distinct|1000|common<CR><LF>
boards.linked.2|boards|bronze|5|0|Two Timer|Link two boards|distinct|1000|common<CR><LF>
```
*(the first 2 of 67 `rows` entries.)*

(`<CR><LF>` marks the two real bytes 0x0D 0x0A, written out here so this
document itself stays one line per row.)

### PUT /catalog/doors/&lt;door&gt;

Register a door's own achievement definitions. The `<door>` segment is the
door's command name and must match `^[a-z0-9][a-z0-9-]{1,31}$`.

<!-- capture: catalog.door.request -->
```json
{
  "digest": "sha256:2f1c8a3e5d7b9042c6e1f8a4b2d0c9e7f5a3b1d8c6e4f2a0b9d7c5e3f1a8b6d4",
  "achievements": [
    {
      "id": "door.grandmaster.first_win",
      "name": "First Blood",
      "description": "Win a game of chess",
      "family": "door",
      "tier": "bronze",
      "points": 5,
      "hidden": false,
      "rule": {
        "op": "count",
        "type": "door.grandmaster.win",
        "n": 1
      }
    }
  ]
}
```

<!-- capture: catalog.door.response -->
```json
{
  "added": 1,
  "unchanged": 0,
  "total": 1
}
```

`digest` is the door manifest's own digest, so an unchanged manifest is a
cheap no-op: re-pushing it adds nothing and answers `200`.

**A published id is immutable.** The definition digest the server compares
covers the `id`, the `name`, the `description` and the `rule` - so renaming
a published achievement is a `409` like any other change. A mutable display
name would need a policy for what a player who already unlocked "First
Blood" sees when it becomes something else. A door author who wants
different behaviour publishes a new id.

| Status | Error | When |
|---|---|---|
| `200` | - | accepted; `added` and `unchanged` say what happened |
| `400` | `bad_door` | the `<door>` segment is not slug-shaped |
| `400` | `bad_namespace` | an id is not `door.<door>.<slug>`, naming the offending id |
| `400` | `bad_rule` | an unknown operator, a `granted` rule (server-only), or a rule naming a `meta.*` type |
| `400` | `bad_definition` | a tier outside the four, `points` outside 1-100, a `name` outside 1-64 characters or a `description` outside 1-160 |
| `400` | `too_many` | more than 64 achievements in one door |
| `409` | `definition_changed` | an id exists with a different definition, naming the id |
| `429` | `rate_limited` | |

**Rejection is whole-request.** Nothing is written when any id fails, and
the published definitions stand unchanged. Partial acceptance would leave a
door's catalog half-old and half-new with no way for the author to tell.

### GET /leaderboard

<!-- capture: leaderboard.global.request -->
```
GET /achievements/v1/leaderboard?scope=global&period=all&limit=50
```

A board's own ranks come from `GET /leaderboard?scope=board:uprough&period=season`.

<!-- capture: leaderboard.global.response -->
```json
{
  "scope": "global",
  "period": "all",
  "season": null,
  "revision": "l2-t1788806941",
  "rows": [
    {
      "rank": 1,
      "handle": "Spot",
      "points": 40,
      "unlocks": 4
    },
    {
      "rank": 2,
      "handle": "Phantasm",
      "points": 5,
      "unlocks": 1
    }
  ]
}
```

- `scope=global` ranks VERIFIED, NON-PRIVATE players by points summed over
  their unlocks, **excluding unlocks earned on a suspended board**.
- `scope=board:<id>` ranks the players linked to that board by points earned
  ON that board. **A private player IS listed here** - that board's caller
  list is its sysop's own data. Privacy is a global opt-out, not a local
  one.
- `period=season` counts only unlocks whose season is the current one. A
  season is a UTC calendar quarter, id `YYYYQn`. At the roll, **ranks reset
  and unlocks never do** - nothing is deleted, recomputed or downgraded,
  because the season lives on the unlock row.
- `limit` defaults to 50 and caps at 200.
- Ties break by earliest last-unlock timestamp, then by handle, so the order
  is total and two identical requests return the same rows in the same
  order.
- An unverified player is on no leaderboard at all.
- A `scope` naming an unknown board answers an EMPTY listing with a valid
  header, not a `404`.

| Status | Meaning |
|---|---|
| `200` | the ranks |
| `304` | `If-None-Match` matched the leaderboard revision |
| `400` | `bad_scope` - `scope` is neither `global` nor `board:<slug>` |

At each season roll the server grants the hidden `rare.season.winner` to the
top global player, and to the top player of **each board with at least five
verified linked players**. The floor exists so a one-caller board cannot
mint a legendary achievement every quarter. A season with zero unlocks
closes silently and grants nothing.

### GET /leaderboard.txt

The same query parameters, the same ordering, in the house plain-text format
(section 7).

<!-- capture: leaderboard.txt.response -->
```
GET /achievements/v1/leaderboard.txt?scope=board:uprough&period=all
Authorization: Board uprough.<key>

HTTP/1.1 200 OK
Content-Type: text/plain; charset=ISO-8859-1
X-Achievements-Contract: 1
X-Achievements-Revision: a67-t1788806941

ACHIEVE|1|l2-t1788806941|2<CR><LF>
1|Spot|40|4<CR><LF>
2|Phantasm|5|1<CR><LF>
```

### GET /players/&lt;email&gt;

The email is URL-encoded in the path and matched case-insensitively.

<!-- capture: players.profile.response -->
```json
{
  "handle": "Spot",
  "verified": true,
  "private": false,
  "points": 40,
  "linkedBoards": [
    "uprough"
  ],
  "unlocks": [
    {
      "id": "door.grandmaster.first_win",
      "name": "First Blood",
      "tier": "bronze",
      "points": 5,
      "hidden": false,
      "rarityPctTenths": 1000,
      "at": "2026-09-07T18:49:01.000Z"
    },
    {
      "id": "msg.burst.3",
      "name": "On A Roll",
      "tier": "bronze",
      "points": 5,
      "hidden": false,
      "rarityPctTenths": 1000,
      "at": "2026-09-07T18:49:01.000Z"
    }
  ],
  "progress": [
    {
      "id": "msg.post.10",
      "have": 8,
      "need": 10
    },
    {
      "id": "boards.linked.2",
      "have": 1,
      "need": 2
    }
  ]
}
```
*(the first 2 of 4 `unlocks` entries, the first 2 of 9 `progress` entries.)*

**Gated by the LINK, not by the privacy flag.** A board that is not linked
to that email gets `403 not_linked` whether the player is private or not,
**and whether or not the player exists** - so this endpoint is not an
address oracle.

- The response carries `handle`, never an email address.
- `linkedBoards` lists every board currently reporting for the player, so a
  player can see who that is.
- `progress` here is capped at 200 entries, ordered by completion fraction
  descending - it is what the ACHIEVE door's progress screen pages through.
  (The cap on the `POST /events` response is 20; see section 5.)
- Hidden achievements the player has not unlocked are **omitted from
  `progress` entirely**. Listing "you are 3/5 towards a secret" is the same
  leak as naming it.

### PATCH /players/&lt;email&gt;

<!-- capture: players.patch.request -->
```json
{
  "private": true
}
```

Answers the updated `PlayerProfile`:

<!-- capture: players.patch.response -->
```json
{
  "handle": "Spot",
  "verified": true,
  "private": true,
  "points": 40,
  "linkedBoards": [
    "uprough"
  ],
  "unlocks": [
    {
      "id": "door.grandmaster.first_win",
      "name": "First Blood",
      "tier": "bronze",
      "points": 5,
      "hidden": false,
      "rarityPctTenths": 1000,
      "at": "2026-09-07T18:49:01.000Z"
    },
    {
      "id": "msg.burst.3",
      "name": "On A Roll",
      "tier": "bronze",
      "points": 5,
      "hidden": false,
      "rarityPctTenths": 1000,
      "at": "2026-09-07T18:49:01.000Z"
    }
  ],
  "progress": [
    {
      "id": "msg.post.10",
      "have": 8,
      "need": 10
    },
    {
      "id": "boards.linked.2",
      "have": 1,
      "need": 2
    }
  ]
}
```
*(the first 2 of 4 `unlocks` entries, the first 2 of 9 `progress` entries.)*

Changes only that player's own flags,
and only from a linked board - the player is standing at the door on that
board. A `handle` change is subject to the same uniqueness rule as
registration and answers `409 handle_taken` when it is refused; the old
handle stands.

| Status | Meaning |
|---|---|
| `200` | the updated profile |
| `400` | `bad_handle` |
| `403` | `not_linked` |
| `409` | `handle_taken` |

### GET /health

No board key required.

<!-- capture: health.response -->
```json
{
  "status": "ok",
  "contractVersion": "1",
  "revision": "a67-t1788806941",
  "players": 3,
  "boards": 1,
  "pendingMail": 4,
  "season": "2026Q3"
}
```

`pendingMail` is the queue depth. A number that stops going down is how a
sysop finds out that verification codes are going nowhere, before the
callers do.

The DOOR-REPO health object (`/api/door-repo/health`) also gains an
`achievements` key, so the existing container healthcheck keeps working
either way:

<!-- capture: health.doorrepo.response -->
```json
{
  "status": "ok",
  "revision": "c1-t1700000000",
  "doors": 1,
  "achievements": {
    "enabled": true,
    "contractVersion": "1",
    "players": 3,
    "pendingMail": 4
  }
}
```

## 5. The event contract

### The event

| Field | Required | Meaning |
|---|---|---|
| `ref` | yes | opaque to the server, unique per board, at most 128 characters. The idempotency key. |
| `email` | yes | identifies the player. The board is identified by the key, never by a field in the body. |
| `type` | yes | the counter type, at most 64 characters, e.g. `msg.post`. |
| `at` | yes | ISO 8601 UTC, e.g. `2026-09-03T21:14:02Z`. |
| `value` | no | defaults to 1. Bytes, minutes, an absolute counter - whatever the type means. |
| `key` | no | the ONE dimension this event carries. |
| `door` | no | the door command, when the event came from one. |
| `client` | no | what the transport said the caller was, e.g. `amiga`, `c64`, `web`. |

**An event carries AT MOST ONE `key`.** A fact with two dimensions is two
events with two refs - a login is reported as `presence.call` keyed by the
hour of the clock, and again as `presence.call` keyed by the caller ordinal
when the board has one. That keeps `distinct` unambiguous about which
dimension it is counting, and keeps idempotency per dimension rather than
per fact.

`ref` formats:

```
<board-id>:<ulid>                          a one-off event
<board-id>:<email>:stat:<name>:<value>     a stat snapshot
```

The snapshot form is what makes a client with no outbox safe: re-running the
door with an unchanged counter produces the same `ref` and is dropped as a
duplicate, while a changed counter is a new `ref`.

### The `meta.*` prohibition

The server appends three INTERNAL event types of its own, so that rules
about the system itself need no new operator:

| Type | Appended when | Dimension |
|---|---|---|
| `meta.link` | a board links a player | `board` |
| `meta.unlock` | an achievement unlocks; `key` is the achievement id | `board`, grouped by `key` |
| `meta.board_first` | the first unlock ever recorded for a board | - |

**A board cannot post any of them.** A batch containing a `meta.*` type is
refused whole with `400 meta_type_rejected`.

### The clamp

The server stamps its own receive time. A board-supplied `at` **more than 15
minutes in the future, or more than 30 days in the past, is CLAMPED** to the
server's clock, and the clamp is recorded on the stored event. Streaks and
windows are computed from the clamped timestamp, in **UTC calendar days**.
Nothing anywhere reads the raw value.

Boards do not agree about the time and never will; the server's clock is the
only one in the system that is single-valued. A board whose clock is wrong
by hours still reports honestly-timed events that clamp, and its callers may
see a streak break they did not deserve - that is the accepted residual
cost of not trusting a client clock.

### Snapshot counters

`stat.snapshot` is how a board with years of history before this system
existed gets day-one credit.

```json
{ "ref": "uprough:caller@example.com:stat:file.upload:137",
  "email": "caller@example.com", "type": "stat.snapshot",
  "at": "2026-09-03T21:14:02Z", "key": "file.upload", "value": 137 }
```

- The `key` **is** the counter type being snapshotted.
- Stored as `max(existing, value)`: a LOWER snapshot after a higher one
  changes nothing at all.
- A `count` rule over that type compares against the greater of the event
  count and the snapshot. A `sum` rule reads incremental events only - the
  five numbers a board holds are all counts, and no byte total exists to
  snapshot.
- A `stat.snapshot` whose `key` names a type no achievement uses is
  `rejected` with `unknown_event_type`.

### Board-computed facts

Some facts are knowable only where they happen: a board has the list of ITS
conferences, ITS bulletins, ITS caller ordinal, and the timestamp of the
message a reply answers. **The board computes the FACT and reports it as an
event; the server still owns the rule.** The board never learns which
achievement, if any, its event satisfied.

This is the table SP2 implements, key by key:

| Event | `key` | The fact the board computed |
|---|---|---|
| `msg.post` | `conf:<id>` | which conference the message went to |
| `msg.post` | `lines:100+` | the board measured the message at over 100 lines |
| `msg.reply` | `fast` | the board timed the reply at under 60 seconds |
| `file.download` | `age:25y+` | the file was older than 25 years |
| `file.ratio` | `silver` / `gold` | an upload:download ratio crossed a threshold |
| `presence.call` | `hour:NN` | the hour of the clock, 00-23, at login |
| `presence.call` | `caller:1000` | the caller's ordinal on that board, on their first call |
| `presence.call` | `return:30` | the caller came back after 30 days away |
| `wall.tag` | `conf:<id>` | which conference the wall tag was left in |
| `bull.read.all` | - | the caller finished that board's own bulletin set |
| `stat.snapshot` | `<type>` | an absolute counter out of the board's user record |
| `msg.post` | `midnight` | the message was posted between 00:00 and 00:05 board time |
| `msg.thread` | - | a thread the caller started drew its first reply |
| `msg.comment` | - | the caller left a comment for the sysop |
| `wall.everyconf` | - | the caller has now tagged the wall in every conference this board has |
| `presence.client` | `c64` / `amiga` | the transport said the caller is on real hardware (PETSCII autodetect / dedicated port; `AE_CLIENT` / `AE_CONNECTION`) |
| `presence.petscii` | - | a session completed in PETSCII mode |
| `presence.minutes` | - | minutes online, as `stat.snapshot` |
| `social.chat` / `social.nodechat` / `social.page` / `social.olm` / `social.vote` / `social.greet` | - | one event per act |
| `door.play` | `<command>` | the caller ran that door |
| `door.minutes` | - | minutes inside a door, as `value` |

The seed catalog (`seeds/achievements.seed.json`) reads exactly these types
and keys; a fact the board does not report is an achievement nobody can earn.

### Progress

The `progress` array on a `POST /events` response holds the not-yet-unlocked
achievements the batch moved, ordered by completion fraction descending and
**capped at 20 entries**. The cap is not cosmetic: a 68K client parses this
into a static buffer, and an uncapped array on a first-ever snapshot sync
would be the whole catalog.

## 6. Terminal versus retryable

A client with an outbox has to know which rows to delete and which to keep.
There are exactly two classes.

**TERMINAL - delete the row, never retry:**

- any `4xx` status, including `400`, `401`, `403`, `409`;
- **any entry in the `rejected` array of a `200` response.** A rejected
  event will be rejected identically for ever: the type is unknown, or the
  player is unknown, unverified, or not linked to this board. Retrying it is
  a loop.

**RETRYABLE - keep the row and back off:**

- any `5xx` status;
- a connection failure or a timeout;
- `429`, after at least `Retry-After` seconds.

`duplicates` is neither: a duplicate was already accepted once, and its row
is deleted like a success.

A `403 not_linked` on a whole batch is terminal for those rows AND is the
signal to arm the door's linking explanation for that caller. `notLinked` on
a `200` carries the same meaning for the addresses it names.

## 7. The plain-text formats

`catalog.txt` and `leaderboard.txt` exist because a 68K door cannot hold a
JSON catalog in a static buffer. They follow the house format the door repo
established for `list.txt`, and carry the same stability promise.

- **Encoding:** ISO-8859-1 (Latin-1), one byte per character.
  `Content-Type: text/plain; charset=ISO-8859-1`.
- **Line endings:** CRLF throughout, **including after the last data row**.
- **Header line**, always first:

  ```
  ACHIEVE|1|<revision>|<count>
  ```

  `1` is the fixed literal format version for this line shape, `<revision>`
  is the revision the same request's JSON variant would report, and
  `<count>` is the number of data rows that follow.

### `catalog.txt` rows

```
<id>|<family>|<tier>|<points>|<hidden>|<name>|<description>|<op>|<rarity_tenths>|<bucket>
```

<!-- capture: format.catalog.rows -->
```
ACHIEVE|1|a67-t1788806941|67<CR><LF>
boards.linked.10|boards|gold|25|0|Scene Veteran|Link ten boards|distinct|1000|common<CR><LF>
rare.caller.1000|rare|gold|25|1|???||count|1000|common<CR><LF>
```
*(two real rows of the 67 this response carried: one plain, one hidden.)*

- `hidden` is exactly one byte, `1` or `0`, so a C89 client tests it without
  parsing.
- `rarity_tenths` is an INTEGER in tenths of a percent: `81` is 8.1%.
- `op` is the rule's operator name only. The rule's parameters are not in
  the text variant; a client that needs them reads the JSON catalog.
- A hidden achievement nobody on this board has unlocked shows `???` and an
  empty description, exactly as the JSON catalog does.

### `leaderboard.txt` rows

```
<rank>|<handle>|<points>|<unlocks>
```

<!-- capture: format.leaderboard.rows -->
```
ACHIEVE|1|l2-t1788806941|2<CR><LF>
1|Spot|40|4<CR><LF>
2|Phantasm|5|1<CR><LF>
```

The leaderboard's revision is `l<rows>-t<newest unlock timestamp>` scoped to
the query, so a 68K client can hold an `ETag` against a board scoreboard the
same way it holds one against the catalog.

### Escaping rules

These are applied by the SAME code that renders `list.txt` - one escaper,
not two, because a 68K parser written against one format must not mis-read
the other.

- **Pipe escaping.** A literal `|` inside any text field is replaced with
  `!` before the row is assembled, so a pipe in the source text can never
  corrupt the field split.
- **Line collapsing.** CR, LF and TAB runs inside any text field each
  collapse to a single space, so a raw newline can never split one data row
  into two physical lines - which would desync the header's `<count>` from
  the real number of data lines and break a naive line-by-line parser.
- **Length caps.** `description` is truncated to 120 characters after
  escaping and collapsing. `handle` is capped at 16, which is the
  registration limit, so the cap never actually truncates - it bounds the
  row against future content.
- **Bytes outside ISO-8859-1 are replaced with `?`** - each such character
  becomes exactly one `?`, never a multi-byte fallback, a silent truncation
  or a dropped character. A character outside the range would otherwise be
  silently truncated to an unrelated byte by the platform's own Latin-1
  encoder.

### Append-only promise

Both text formats will only ever grow new fields by APPENDING them. A
conforming parser:

- **MUST split each data row on `|` and read fields by position, ignoring
  any field it does not recognize.**
- **MUST NOT require a fixed field count.** Rejecting a row for having more
  fields than expected is the one way to break under this promise.
- **MUST treat the header's version number as the authority for what fields
  to expect.** Appending a trailing field never bumps it. It is bumped only
  when a field is removed, or an existing field's position, meaning or type
  changes.

## 8. Versioning

`X-Achievements-Contract` carries the contract version - currently `1` - on
every response. It is bumped only for a change a client cannot absorb by
ignoring what it does not know: a removed field, a changed meaning, a
changed type, a changed status code for an existing condition.

**A client that reads a field it does not know MUST ignore it.** New
response fields, new error codes, new event types, new achievements and new
rule operators all arrive without a bump.

The machine-readable form of everything in this document is
`contract/achievement-types.ts`. A client vendors a generated mirror of it:

```
npx tsx scripts/gen-achievement-types.ts path/to/vendored/achievement-types.ts
```

and keeps a staleness test against it, exactly as DOORMAN already does for
the door-repo manifest contract.

## 9. Curation: issuing board keys

Issuing a board key is curation, not a board-facing API, so these routes are
gated by the door server's existing ADMIN TOKEN
(`Authorization: Bearer <jwt>`), never by a board key.

| Method | Path |
|---|---|
| GET | `/admin/boards` |
| POST | `/admin/boards` |
| POST | `/admin/boards/<id>/rotate` |
| POST | `/admin/boards/<id>/suspend` |
| POST | `/admin/boards/<id>/resume` |
| POST | `/admin/boards/<id>/relay` |
| POST | `/admin/boards/<id>/unrelay` |

`relay` / `unrelay` set or clear the board's chat relay flag (the Discord
bridge's board): a relay board's chat requests may carry `as` to act as
`<as>@<that board>`, never as another board's user (docs/CHAT-API.md).
Board summaries carry `chatRelay` and `discordMirror`.

`POST /admin/boards` takes `{"id": "uprough", "name": "Up Rough",
"contact": "sysop@example.com"}` and answers `{"id": "uprough", "key":
"uprough.qeAt..."}`. **The plaintext key is shown exactly once**, at
creation and at rotation; only its scrypt hash is stored. A board id must
match `^[a-z0-9][a-z0-9-]{1,31}$`, and creating one that already exists is
`409 board_exists` - the stored hash is not touched.

### Self-service registration

`POST /boards/register` needs no key and no token: a board asks for one and
the key is active at once (no approval step, no rate limit). Body:
`{"name": "Up Rough", "sysop": "Spot", "contact": "optional"}`. `name` and
`sysop` are 1 to 40 printable ASCII characters (0x20-0x7E), `contact` is at
most 80; anything else is `400 bad_request`. The name is shown in every chat
log when the board first joins chat. The server derives the board id from the
name (lowercase, other characters become `-`, at most 32 characters, `board`
if fewer than 2 remain) and appends `-2` to `-99` when the id is taken. The
`contact` column stores `<sysop>` or `<sysop> <contact>`.

Answers 201 Created. With `Accept: text/plain` (the 68K door) the body is
`OK <id>.<secret>\n`; otherwise `{"id": "...", "key": "<id>.<secret>"}`. The
plaintext key is shown exactly once.

These routes answer `503` when the admin API is switched off, which is what
the door server already does when no JWT signing secret is configured.

The same operations exist as a CLI on the host, which is how the first key
is minted before any token exists:

```
npx tsx scripts/achievements-board.ts list
npx tsx scripts/achievements-board.ts create <id> "<name>" [contact]
npx tsx scripts/achievements-board.ts rotate <id>
npx tsx scripts/achievements-board.ts suspend <id>
npx tsx scripts/achievements-board.ts resume <id>
```

Every accepted write from a board appends one audit row naming the board,
the action and the count.

## 10. Rate limits

This surface is the one deliberate exception to the project-wide "no rate
limiting" rule, and the exception is narrow: it applies ONLY to this
multi-board WRITE API, which is reachable by any board on the internet
holding a key.

| Route | Per board | Per player |
|---|---|---|
| `POST /events` | 120 requests / min, 12000 events / min | 600 events / min |
| `POST /players`, `POST /players/resend` | 10 / min | 3 / hour |
| `POST /players/verify` | 30 / min | 10 / hour |
| `POST /links`, `DELETE /links`, `POST /links/rotate` | 30 / min | 10 / hour |
| `PUT /catalog/doors/<door>` | 10 / min | - |
| `POST /admin/boards/*` | 20 / min per admin | - |

**`GET /catalog`, `GET /catalog.txt`, `GET /leaderboard`,
`GET /leaderboard.txt`, `GET /players/<email>` and `GET /health` are NOT
rate limited.** A limiter on a read path is exactly the "locks out
legitimate BBS users" failure the project-wide rule exists to prevent.

A `429` carries `Retry-After` in seconds and stores nothing: the limiter
sits in front of the transaction, not inside it.
