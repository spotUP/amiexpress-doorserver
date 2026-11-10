/**
 * Entry point of the Discord bridge process (dist/src/discord-bridge/index.js).
 * Phase 2 skeleton: config, hub session, stored seq. Phases 3-5 plug in the
 * Discord side; until then events are only logged.
 */
import { loadBridgeConfig, BridgeConfigError } from './config';
import { startBridge } from './bridge';

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
  const bridge = await startBridge(config, {
    onEvent: (ev) => console.log(`[INFO] event ${ev.seq} ${ev.type} room=${ev.room} user=${ev.user}`),
  });
  console.log(`[OK] discord bridge up, ${config.rooms.size} room(s), hub ${config.hubUrl}`);
  const shutdown = (): void => {
    void bridge.stop().then(() => process.exit(0));
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
