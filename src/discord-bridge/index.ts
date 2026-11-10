/**
 * Entry point of the Discord bridge process (dist/src/discord-bridge/index.js).
 * Phase 3: hub events go to Discord through channel webhooks. Phases 4-5 add
 * the Discord gateway side.
 */
import { loadBridgeConfig, BridgeConfigError } from './config';
import { startBridge } from './bridge';
import { RestDiscordOut } from './discord-out';
import { createOutbound } from './outbound';

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
  await out.prepare(config.rooms.values());
  const bridge = await startBridge(config, (hub, state) => ({
    onEvent: createOutbound({ rooms: config.rooms, state, out, fetchBoards: () => hub.mirrorBoards() }),
  }));
  console.log(`[OK] discord bridge up, ${config.rooms.size} room(s), hub ${config.hubUrl}`);
  const shutdown = (): void => {
    void bridge.stop().then(() => {
      out.close();
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
