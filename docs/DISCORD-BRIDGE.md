# LiveChat <> Discord bridge

The bridge mirrors mapped LiveChat hub rooms to Discord channels and back.
It runs as its own process (`src/discord-bridge/index.ts`) and talks to the
hub over HTTP as the relay board `discord`, exactly like a federated board.
Discord users appear in the hub as `handle@DISCORD`; hub bans and mutes apply
to them. Hub to Discord goes through one webhook per channel (the caller's
name and board on each message); Discord to hub goes through the bot gateway.

Per-board mirroring is opt-in: a sysop turns it on for their board with
`/discord on` (off by default). Boards that are off never reach Discord.

## Deployment

`docker-compose.yml` has a `discord-bridge` service under the compose profile
`discord`. It runs the same image as the hub and stores its state in
`/data/discord-bridge.db` on the shared volume.

The deploy workflow (`.github/workflows/deploy-doorserver.yml`) switches it
on only when all three GitHub secrets are set:

| Secret | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token. The bot needs the Message Content intent, and in each mapped channel: View Channel, Send Messages, Read Message History, Manage Webhooks. |
| `DISCORD_BRIDGE_BOARD_KEY` | BoardKey (`<id>.<secret>`) of the relay board with id `discord` (exactly; `CHAT_DISCORD_BOARD` in `contract/chat-types.ts`). The server admin creates that board, issues its key and sets its relay flag. |
| `DISCORD_BRIDGE_ROOMS` | `roomKey=channelId,...`, e.g. `lobby=123456789012345678`. The room key is the hub room key (`lobby` is the landing room); the channel id is the Discord channel snowflake. |

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
