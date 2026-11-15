# Partyline protocol PLP/1

The wire between a board's Partyline thin client (PARTYLINE68 on the Amiga, the
TypeScript relay on amiexpress-web) and the hub. The hub owns every screen; the
client moves bytes. Types both ends compile against: `contract/partyline-types.ts`.
Server: `src/partyline/`.

## Transport

- One TCP connection per door run, on the hub's own port: `PARTYLINE_PORT`,
  default **6400**. The Hetzner host firewall must allow it.
- TLS and plain TCP share that port. The hub reads the first byte: `0x16` (a TLS
  ClientHello) starts a TLS session, anything else is a plain PLP stream (the
  first frame is `H`). TLS needs `PARTYLINE_TLS_CERT` and `PARTYLINE_TLS_KEY`
  (PEM paths); without them TLS callers are dropped and only plain works.
- **Plain TCP is unencrypted.** The board key never travels (HMAC login), but
  anyone on the path can read what that board's callers type and see. The hub
  logs `tls` or `plain` with every HELLO.
- On by default. `PARTYLINE_ENABLED=0` turns it off; it needs `ACHIEVEMENTS_DB`
  (the chat store). `PARTYLINE_HOST` sets the bind address (default `0.0.0.0`).

## Frames

Both directions: `type (1 byte ASCII) | length (u16 big-endian) | payload`.
Payload is at most 4096 bytes. A larger length on the wire closes the connection.
Larger output is split across frames. Unknown frame types are ignored by both ends.

Client to hub:

| Type | Name | Payload |
|------|------|---------|
| `H` | HELLO (first frame, once) | `key=value` lines (LF or CRLF) |
| `A` | AUTH | 64 lowercase hex chars, see Login |
| `K` | INPUT | raw caller bytes |
| `R` | RESIZE | `<cols>x<rows>` |
| `C` | ACK | u32 BE: sequence of the last `D`/`G` fully written |
| `P` | PING | any bytes; echoed in `O` |
| `U` | UPLOAD result | `ok <fileId>` or `fail <reason>` (P6) |
| `Q` | BYE | `carrier`, `timeout`, `sysop` or `user` |

Hub to client:

| Type | Name | Payload |
|------|------|---------|
| `N` | CHALLENGE | 32 hex chars (16 random bytes) |
| `W` | WELCOME | `key=value` lines: `proto`, `features`, `session`, `resume` |
| `D` | OUTPUT | u32 BE sequence, then terminal bytes |
| `G` | GRAPHICS | u32 BE sequence, then kitty APC bytes (only with `kitty=1`); one APC may span several `G` frames, so the client writes them to the terminal as they come, in sequence order with `D` |
| `S` | SOUND | cue name: the door's `audio:play` soundId; the relay re-emits it on the caller's socket as `audio:play` |
| `M` | MEDIA | voice/video signalling (only with `media=1`) |
| `T` | CTRL | host action (`write-cfg`, `upload`, `set-line-mode`, `redirect host:port`, `quit`) |
| `O` | PONG | the `P` payload |
| `X` | EXIT | reason; the client returns the caller to the board menu |

`D` and `G` share one sequence counter per connection, starting at 1.

## HELLO keys

`proto=1.<minor>`, `client=<name>/<version>`, `board=<id>`, `handle=<from the board
session, never typed>`, `access`, `sysop=0|1`, `node`, `cols`, `rows`,
`charset=latin1|utf8`, `kitty=0|1`, `mouse=0|1`, `media=0|1`,
`upload=none|zmodem|web|aew`, `console=0|1`, `conn=telnet|web|ssh`, `modem=<bps or 0>`, `resume=<token or empty>`.
Unknown keys are ignored; missing ones take defaults (80x25, latin1, flags off).

## Login

1. Client sends `H`. Hub answers `N` with a nonce.
2. Client sends `A` = `hex(HMAC-SHA256(plpKey, nonce + board + handle))`, where
   `plpKey = hex(HMAC-SHA256(secret, "PLP/1 board key"))` and `secret` is the part
   of the board key after `<board id>.`. The hub stores `plpKey` (column
   `boards.plp_key`), never the secret, so a leaked row opens Partyline only and
   none of the HTTP surfaces.
3. Hub answers `W`, then the first `D` (the full screen).

`HELLO` and `AUTH` must both arrive within 10 seconds.

Boards minted or rotated after migration 15 have `plp_key` at once. An older
board gets it on its first `/chat/v1` (or other board-authenticated) request
after the upgrade.

Refusals are one `D` with a plain text screen, then `X <reason>`, then close:

| Reason | When |
|--------|------|
| `old_client` | `proto` major is not 1 ("This board runs an old Partyline client. Ask the sysop to update.") |
| `bad_hello` | no `board` or `handle` |
| `unauthenticated` | unknown board, no `plp_key`, invalid handle, wrong MAC (one answer for all, like `/chat/v1` 401) |
| `board_suspended` | the board is suspended (403 on `/chat/v1`) |
| `rate_limited` | the board is over its chat session cap or login rate |
| `draining` | the hub is restarting |
| `login_timeout` | no `A` within 10 seconds |

## Versioning

Major/minor. The hub serves every minor of major 1 and answers `proto=1.<min(client, hub)>`.
New frame types are capability-gated (`features` in `W`), so a feature never bumps the major.

## Flow control

At most one `D`/`G` frame is in flight until its `C`. While waiting, the hub marks
the screen dirty and renders only when the `C` arrives, so the caller gets the
latest diff and never a backlog. The hub flushes at most every 30 ms per session.
A client must send `C` after writing each `D`/`G`, or the screen stops updating.

## Resume and restart

- The `resume` token in `W` is the chat session id. The Partyline session is an
  ordinary `/chat/v1` session in the same store: same who list, same rooms.
- After a disconnect, the client reconnects and sends `resume=<token>` in `H`. After
  a good `A` for the same board and handle, the hub continues that chat session.
  A stale or foreign token silently gets a fresh session.
- The hub keeps live sessions fresh; a dropped session expires after the chat
  session TTL (90 seconds).
- On SIGTERM the hub stops accepting, sends each caller `D` "Partyline is
  restarting, reconnecting...", and closes without ending the chat session, so the
  client can resume on the new process.
- `Q` (BYE) ends the chat session; no resume after it.
