import { createApp } from './app';
import { loadConfig, ConfigError } from './config';
import type { ServerConfig } from './config';
import { getDoorCount, getCatalogRevision } from './catalog';

function main(): void {
  let cfg: ServerConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[ERROR] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const app = createApp(cfg);
  app.listen(cfg.port, () => {
    console.log(`[OK] door server listening on ${cfg.port}`);
    console.log(`[INFO] catalog ${getDoorCount(cfg)} doors, revision ${getCatalogRevision(cfg)}`);
  });
}

main();
