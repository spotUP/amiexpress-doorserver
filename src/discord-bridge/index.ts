/**
 * Entry point of the Discord bridge process (dist/src/discord-bridge/index.js).
 * Hub events go to Discord through channel webhooks (outbound); the discord.js
 * gateway feeds mapped-channel messages to the hub (inbound).
 */
import { loadBridgeConfig, BridgeConfigError, allChannels } from './config';
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
  const bridge = await startBridge(
    config,
    (hub, state) => {
      const resolveMention = (channel: string, name: string) => gateway.memberId(channel, name);
      // One fan-out for both directions: a Discord message is copied to the room's other guilds.
      const fanout = createFanout({ rooms: config.rooms, state, out, resolveMention });
      // A failed login (bad token, missing intent) ends the process so the
      // restart policy retries it; discord.js resumes dropped sessions itself.
      gateway.start(createInbound({ rooms: config.rooms, hub, state, fanout })).catch((err) => {
        console.error(`[ERROR] discord gateway: ${(err as Error).message}`);
        process.exit(1);
      });
      return { onEvent: createOutbound({
          rooms: config.rooms,
          state,
          out,
          fetchBoards: () => hub.mirrorBoards(),
          resolveMention,
        }) };
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
  console.log(`[OK] discord bridge up, ${config.rooms.size} room(s) in ${allChannels(config.rooms).length} channel(s), hub ${config.hubUrl}`);
  const shutdown = (): void => {
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
