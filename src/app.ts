import express from 'express';
import { createRouter } from './routes';
import { doorRepoCors } from './cors';
import type { ServerConfig } from './config';

export function createApp(cfg: ServerConfig): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Mounted in front of the router so every path under it — including a
  // preflight OPTIONS for a route the router itself does not define — gets
  // the same cross-origin headers the BBS-hosted API already sends. See
  // cors.ts for why this exists and what it deliberately does not
  // restrict.
  app.use('/api/door-repo', doorRepoCors());
  app.use('/api/door-repo', createRouter(cfg));
  return app;
}
