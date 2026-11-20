/**
 * Entry point of the Discord bridge process (dist/src/discord-bridge/index.js).
 * Hub events go to Discord through channel webhooks (outbound); the discord.js
 * gateway feeds mapped-channel messages to the hub (inbound).
 */
import { loadBridgeConfig, BridgeConfigError, allChannels } from './config';
import { LiveRooms, allLookupChannels } from './rooms';
import { createRefresher } from './refresh';
import { startBridge } from './bridge';
import { RestDiscordOut } from './discord-out';
import { createFanout, createOutbound } from './outbound';
import { GatewayDiscordIn, createInbound } from './inbound';
import { writeHealth } from './health';

async function main(): Promise<void> {
  let config;
  try {
    config = loadBridgeConfig();
  } catch (err) {
    if (err instanceof BridgeConfigError) {
      console.error(`[ERROR] ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  const out = RestDiscordOut.fromToken(config.discordToken);
  await out.prepare(allChannels(config.rooms));
  const gateway = new GatewayDiscordIn(config.discordToken);
  // Env seed always wins; hub links layer on top and refresh without a restart.
  const liveRooms = new LiveRooms(config.rooms);
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const bridge = await startBridge(
    config,
    (hub, state) => {
      const resolveMention = (channel: string, name: string) => gateway.memberId(channel, name);
      // One fan-out for both directions: a Discord message is copied to the room's other guilds.
      const fanout = createFanout({ rooms: liveRooms, state, out, resolveMention });
      const outbound = createOutbound({
        rooms: liveRooms,
        state,
        out,
        fetchBoards: () => hub.mirrorBoards(),
        fetchFile: (id) => hub.downloadFile(id),
        resolveMention,
      });
      const refresher = createRefresher({ hub, rooms: liveRooms, out });
      // The invite link needs the application id; the hub learns it here, once.
      // The gateway may not know it yet at login, so every refresh retries the
      // publish until it sticks.
      let published = false;
      const refreshNow = (why: string): void => {
        const run = async (): Promise<void> => {
          if (!published) {
            const id = await gateway.fetchApplicationId();
            if (id !== undefined) {
              await hub.setDiscordApp(id);
              published = true;
              console.log('[OK] discord application id published to the hub');
            }
          }
          await refresher.refresh(why);
        };
        run().catch((err) => console.error(`[ERROR] discord refresh (${why}): ${(err as Error).message}`));
      };
      // A failed login (bad token, missing intent) ends the process so the
      // restart policy retries it; discord.js resumes dropped sessions itself.
      gateway.start(createInbound({ rooms: liveRooms, hub, state, fanout })).catch((err) => {
        console.error(`[ERROR] discord gateway: ${(err as Error).message}`);
        process.exit(1);
      });
      refreshNow('start');
      refreshTimer = setInterval(() => refreshNow('poll'), 60_000);
      if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
      return {
        onEvent: async (ev) => {
          if (ev.type === 'discord_link') refreshNow('event');
          await outbound(ev);
        },
      };
    },
    {
      onPolled: (seq) => {
        try {
          writeHealth(config.healthPath, { seq, gatewayReady: gateway.ready, at: new Date() });
        } catch (err) {
          console.error(`[ERROR] health file ${config.healthPath}: ${(err as Error).message}`);
        }
      },
    },
  );
  console.log(`[OK] discord bridge up, ${[...liveRooms.entries()].length} room(s) in ${allLookupChannels(liveRooms).length} channel(s), hub ${config.hubUrl}`);
  const shutdown = (): void => {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    void bridge.stop().then(() => {
      out.close();
      void gateway.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[ERROR] ${(err as Error).message}`);
    process.exit(1);
  });
}
