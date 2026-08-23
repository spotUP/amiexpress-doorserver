import express from 'express';
import { createRouter } from './routes';
import type { ServerConfig } from './config';

export function createApp(cfg: ServerConfig): express.Express {
  const app = express();
  // The API is public and cacheable by anyone; CORP/CORS policy for
  // browser consumers is the BBS's business at its own host, not ours.
  app.disable('x-powered-by');
  app.use('/api/door-repo', createRouter(cfg));
  return app;
}
