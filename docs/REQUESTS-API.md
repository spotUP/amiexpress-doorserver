# Global Requests API

> Served by the `amiexpress-doorserver` repository, a third surface beside the
> door repo and the achievements API. It is not proxied by any BBS.

A multi-board HTTP API for a GLOBAL request board: a caller on any AmiExpress
board asks the scene for a **release** to be uploaded or a piece of **ASCII
art** to be made; callers on other boards vote for it, claim it, and mark it
done. One list, shared by every board that has a key.

The shapes are frozen in `contract/request-types.ts`, which is what a
TypeScript client compiles against, and mirrored field for field into any
client that vendors them. `tests/requests/contract.test.ts` fails the build if
this document and that module drift apart.

## Contents

1. Base URLs and transports
2. Authentication
3. Headers on every response
4. Endpoint reference
5. Identity and lifecycle
6. Errors
7. The plain-text formats

---

## 1. Base URLs and transports

- **HTTPS:** `https://doors.uprough.net/requests/v1`
- **Plain HTTP:** `http://doors.uprough.net/requests/v1` — the same paths, no
  TLS.

Plain HTTP is a first-class, permanently supported access path: classic
AmigaDOS TCP/IP stacks and 68020+ door clients frequently have no practical
way to do TLS, and the SDK's `ae_http` client does no TLS and no chunked
decoding. Responses on this surface are never chunked: every body carries a
`Content-Length`.

## 2. Authentication

Every board-facing route carries a board key, exactly as the achievements API
does — the same board registry, the same header:

```
Authorization: Board <board-id>.<secret>
```

A missing, malformed or wrong key is `401`, and the three cases are
indistinguishable. A suspended board's WRITES are `403`; its reads still work.
`GET /health` needs no key.

## 3. Headers on every response

- `X-Requests-Contract` — the contract version, `1` today.
- `X-Requests-Revision` — a cheap surface-wide fingerprint, `r<rows>-t<newest
  updated_at>`. A client may notice something changed without reading a
  listing. v1 clients do not send If-None-Match; there is no 304 handling.

## 4. Endpoint reference

| Method | Path | Auth | Answers |
|---|---|---|---|
| GET | `/health` | none | `{status, contractVersion, open, claimed, done, boards}` |
| GET | `/list` | Board | JSON `{contractVersion, revision, rows[]}` |
| GET | `/list.txt` | Board | Latin-1 text (section 7) |
| GET | `/requests/<id>` | Board | JSON `RequestDetail` |
| GET | `/requests/<id>.txt` | Board | Latin-1 text: header, row, blank, notes |
| POST | `/requests` | Board | `{id, state, at}` |
| POST | `/requests/<id>/vote` | Board | `{id, votes, voted}` |
| POST | `/requests/<id>/claim` | Board | `{id, state, claimHandle}` |
| POST | `/requests/<id>/release` | Board | `{id, state}` |
| POST | `/requests/<id>/done` | Board | `{id, state}` |
| POST | `/requests/<id>/withdraw` | Board | `{id, state}` |

Curation, gated by the door server's admin token, not a board key:

| Method | Path | Auth | Answers |
|---|---|---|---|
| DELETE | `/admin/requests/<id>` | Admin | `{deleted}` |

Query for the two listings: `kind` (`release`/`art`), `state`
(`open`/`claimed`/`done`/`withdrawn`/`any`; default `open`), `scope`
(`global`/`board`/`mine`; default `global`), `handle` (for `scope=mine`),
`limit` (≤200), `offset`.

Caps, refused rather than truncated: `title` 60, `notes` 200, `handle` 24,
`note` 80.

### GET /health

No key. `200`.

```json
{ "status": "ok", "contractVersion": "1", "open": 42, "claimed": 7, "done": 12, "boards": 2 }
```

### GET /list

```json
{ "contractVersion": "1", "revision": "r2-t1788", "rows": [ { "id": 103, "kind": "release", "state": "open", "votes": 12, "board": "uprough", "handle": "Spot", "title": "Fairlight - Nexus 7 (AGA)", "claimHandle": null, "createdAt": "2026-09-08T00:00:00.000Z", "updatedAt": "2026-09-08T00:10:00.000Z" } ] }
```

### GET /list.txt

Latin-1, CRLF, section 7. `200`.

```
REQUEST|1|r1-t1788|1
103|release|open|12|uprough|Spot|Fairlight - Nexus 7 (AGA)||1788|1788
```

### GET /requests/&lt;id&gt;

`200`, or `404` when there is no such request.

```json
{ "id": 103, "kind": "release", "state": "claimed", "votes": 12, "board": "uprough", "handle": "Spot", "title": "Fairlight - Nexus 7 (AGA)", "claimHandle": "Rebel", "notes": "AGA only please", "claimBoard": "other", "doneNote": null, "claimedAt": "2026-09-08T00:05:00.000Z", "doneAt": null, "createdAt": "2026-09-08T00:00:00.000Z", "updatedAt": "2026-09-08T00:05:00.000Z" }
```

### GET /requests/&lt;id&gt;.txt

The header line, the row, a blank line, then the notes as free text for the
door's word-wrapped pager. `200`, or `404`.

```
REQUEST|1|r1-t1788|1
103|release|claimed|12|uprough|Spot|Fairlight - Nexus 7 (AGA)|Rebel|1788|1788

AGA only please
```

### POST /requests

Body `{kind, title, notes?, handle}`. The handle is the caller's board handle,
read by the door — never typed. `200`.

```json
{ "id": 104, "state": "open", "at": "2026-09-08T00:00:00.000Z" }
```

`bad_kind` when `kind` is not `release` or `art`; `bad_title` when the title is
empty or over 60; `bad_handle` when the handle is empty or over 24.

### POST /requests/&lt;id&gt;/vote

Body `{handle}`. Idempotent by `(board, handle)`: a repeat does not move the
count. `200`.

```json
{ "id": 103, "votes": 13, "voted": true }
```

`wrong_state` when the request is `done` or `withdrawn`.

### POST /requests/&lt;id&gt;/claim

Body `{handle}`. Anyone on a non-suspended board may claim an `open` request.
`200`.

```json
{ "id": 103, "state": "claimed", "claimHandle": "Rebel" }
```

`already_claimed` when someone claimed it first; `wrong_state` when it is
closed.

### POST /requests/&lt;id&gt;/release

Body `{handle}`. Only the claimer; returns it to `open`. `200`.

```json
{ "id": 103, "state": "open" }
```

`not_yours` when the caller is not the claimer; `wrong_state` when it is not
claimed.

### POST /requests/&lt;id&gt;/done

Body `{handle, note?}`. Only the claimer. `200`.

```json
{ "id": 103, "state": "done" }
```

`not_yours` when the caller is not the claimer; `wrong_state` when it is not
claimed.

### POST /requests/&lt;id&gt;/withdraw

Body `{handle}`. Only the author; a withdrawn request leaves the open list.
POST rather than DELETE-with-body keeps every write on one door code path.
`200`.

```json
{ "id": 103, "state": "withdrawn" }
```

`not_yours` when the caller is not the author; `wrong_state` when it is already
closed.

### DELETE /admin/requests/&lt;id&gt;

Admin token, not a board key. Hard delete. `200`.

```json
{ "deleted": true }
```

## 5. Identity and lifecycle

Identity is `(board_id from the key, handle_key = lower(trim(handle)))`, never
an email — a 68K door cannot learn the caller's address. Two boards can each
have a "Spot"; the row carries the board id so a client can show `Spot@uprough`.

Lifecycle: `open` → `claimed` → `done`, plus `withdrawn` (the author pulls it).
A `done` or `withdrawn` request takes no more votes and cannot be re-claimed.
Every transition runs in a transaction, so a second caller cannot claim a
request in the window between another's check and write.

## 6. Errors

Every refusal is `{error, detail}` (a `429` also carries `retryAfter`). The
codes, and the status each carries:

- `400`: `bad_request`, `bad_kind`, `bad_title`, `bad_handle`
- `401`: `unauthenticated`
- `403`: `board_suspended`, `not_yours`
- `404`: `not_found`
- `409`: `already_claimed`, `wrong_state`
- `429`: `rate_limited`

Rate limits are on WRITES only; no `GET` is ever limited. A `429` is RETRYABLE
after `retryAfter` seconds. A 500 (never listed as a contract status) is the
one answer a client reads no error code out of and simply retries.

## 7. The plain-text formats

The house format the achievements `leaderboard.txt` uses, the same escaper:

```
REQUEST|1|<revision>|<count>CRLF
<id>|<kind>|<state>|<votes>|<board>|<handle>|<title>|<claim_handle>|<created>|<updated>CRLF
```

- `Content-Type: text/plain; charset=ISO-8859-1`, CRLF after EVERY row
  including the last.
- `kind` is `release`/`art`; `state` is one of the four plain words a C89
  client tests with `strcmp`. `created`/`updated` are epoch seconds.
- Three MUSTs, append-only: **(1)** a new field is APPENDED and never inserted;
  **(2)** the header's `1` never moves when a field is appended; **(3)** a
  conforming parser reads by POSITION and IGNORES trailing fields it does not
  know. `|` in any field is escaped to `!`; a newline folds to a space; a byte
  outside ISO-8859-1 becomes one `?`.
