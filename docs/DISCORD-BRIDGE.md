# LiveChat <> Discord bridge

The bridge mirrors mapped LiveChat hub rooms to Discord channels and back.
It runs as its own process (`src/discord-bridge/index.ts`) and talks to the
hub over HTTP as the relay board `discord`, exactly like a federated board.
Discord users appear in the hub as `handle@DISCORD`; hub bans and mutes apply
to them. Hub to Discord goes through one webhook per channel (the caller's
name and board on each message); Discord to hub goes through the bot gateway.

Per-board mirroring is opt-in: a sysop turns it on for their board with
`/discord on` (off by default). Boards that are off never reach Discord.

## Mentions

Hub to Discord: `@name` in a caller's line pings the server member it names.
The bridge matches the name case-insensitively against usernames first, then
display names and nicknames (spaces written as `_`, e.g. `@Bob_Smith`). No
match, or more than one member with that name: the text stays plain and nobody
is pinged. `@name@DISCORD` also resolves; `@name@<any other board>` is a BBS
caller and is left alone. `@everyone`, `@here` and roles never ping.

Discord to hub: `<@id>` mentions arrive as `@<username>`, the handle the hub
shows for that Discord user.

## Deployment

`docker-compose.yml` has a `discord-bridge` service under the compose profile
`discord`. It runs the same image as the hub and stores its state in
`/data/discord-bridge.db` on the shared volume.

The deploy workflow (`.github/workflows/deploy-doorserver.yml`) switches it
on only when all three GitHub secrets are set:

| Secret | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token. The bot needs the Message Content and Server Members intents (both privileged, switched on in the developer portal under Bot), and in each mapped channel: View Channel, Send Messages, Read Message History, Manage Webhooks. |
| `DISCORD_BRIDGE_BOARD_KEY` | BoardKey (`<id>.<secret>`) of the relay board with id `discord` (exactly; `CHAT_DISCORD_BOARD` in `contract/chat-types.ts`). The server admin creates that board, issues its key and sets its relay flag. |
| `DISCORD_BRIDGE_ROOMS` | `roomId=channelId,...` (several servers: `roomId=channelA\|channelB`, see "Several Discord servers"), e.g. `roomd8209269178d=1431571957366788207`. The room id is the hub `chat_rooms.id` (generated, not the room name: the room named `lobby` has its own id per server); the channel id is the Discord channel snowflake. |

With all three set the workflow writes them and `COMPOSE_PROFILES=discord`
into the host `.env`. With any one missing the bridge container is stopped
and removed, because the bridge refuses to start without each of them.

Environment read by the process (`src/discord-bridge/config.ts`):

| Variable | Default |
|---|---|
| `DISCORD_BRIDGE_HUB_URL` | none; compose sets `http://doorserver:3010` |
| `DISCORD_BRIDGE_DB` | none; compose sets `/data/discord-bridge.db` |
| `DISCORD_BRIDGE_HEALTH` | `discord-bridge.health` beside the DB |

## Health

After every successful hub poll the bridge rewrites its health file with
`seq=<n> gateway=<ready|down> at=<ISO time>`. The compose healthcheck runs
`node dist/src/discord-bridge/health.js <file> 80`, which fails when the last
poll is older than 80 seconds or the Discord gateway is not ready.

A failed Discord login (bad token, missing intent) ends the process, so the
`unless-stopped` restart policy retries it. Hub errors are retried inside the
process with backoff; discord.js resumes dropped gateway sessions itself.

Check on the host:

```
cd /app/doorserver
docker compose ps discord-bridge
docker compose logs --tail 50 discord-bridge
```

## Several Discord servers (multi-guild)

One bot can sit in many Discord servers. A hub room can be linked to one
channel in each of them by listing the channels with `|`:

    DISCORD_BRIDGE_ROOMS=roomd8209269178d=1431571957366788207|1500000000000000001

Commas still separate rooms. A channel belongs to one room only. The first
channel of a room is the one it had before multi-guild: message-map rows from
an older bridge DB are assigned to it at start.

What flows where:

- A hub message (BBS caller) is posted by webhook to every linked channel.
- A message written in a linked channel goes to the hub once (as
  `handle@DISCORD`) and is copied by webhook to the room's other linked
  channels, labelled `handle (Server name)`. It is never echoed back to its
  own channel. Edits and deletes by the author follow to the hub and to every
  copy.
- A server moderator who deletes a bridge copy removes it in that server
  only; the hub and the other servers keep the message.
- Attachments are copied as links. Discord CDN links expire, so an old copy
  may lose its picture; the hub keeps its own file copy as before. A message
  with attachments and no text reaches the hub as a file only and is not
  copied to the other servers.
- Deleting a pre-upgrade Discord message in Discord no longer deletes its hub
  copy (the old map did not record which rows were Discord originals).

Adding a server:

1. Invite the bot with
   `https://discord.com/oauth2/authorize?client_id=<application id>&scope=bot&permissions=536939520`
   (View Channel, Send Messages, Read Message History, Manage Webhooks). The
   invite must be accepted by someone with Manage Server in that server.
2. Copy the channel id (Developer Mode, right-click the channel, Copy Channel
   ID) and append `|<channel id>` to the room in the `DISCORD_BRIDGE_ROOMS`
   secret (or the host `.env`).
3. Redeploy, or restart the `discord-bridge` container. At start the bridge
   creates its `LiveChat bridge` webhook in the new channel and logs the room
   and channel count.

The Message Content and Server Members intents are privileged. A bot in 100
or more servers needs Discord's verification before they stay switched on.
