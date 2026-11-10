import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { createRouter } from './routes';
import { createAdminRouter } from './admin-routes';
import { createPublicRouter } from './public-routes';
import { doorRepoCors } from './cors';
import { createAchievementsRouter } from './achievements/router';
import { createRequestsRouter } from './requests/router';
import { createChatRouter } from './chat/router';
import { createReleasesRouter } from './releases/router';
import { createIntegrationsRouter } from './integrations/router';
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
  // Before the public router: /admin/* must not be shadowed by a public
  // route, and it carries its own JSON body parser.
  app.use('/api/door-repo/admin', createAdminRouter(cfg));
  // The web API: JSON, free to grow. routes.ts below it stays the byte-exact
  // contract the AmigaDOS clients depend on.
  app.use('/api/door-repo', createPublicRouter(cfg));
  app.use('/api/door-repo', createRouter(cfg));
  // The achievements surface: a sibling API, not a door-repo route. Mounted
  // BEFORE mountWebUi because that catch-all only exempts /api/ - measured,
  // not assumed: with this mount below it, GET /achievements/v1/catalog
  // answered 200 carrying the single-page app's index.html. No CORS
  // middleware in front of it, deliberately: every request here carries a
  // board key, and a board key must never be inside a browser (see cors.ts
  // for why the door repo is the opposite case).
  //
  // A null config means the surface was never configured, and then nothing
  // is mounted at all - a sysop who never wanted achievements should not be
  // serving half of one.
  if (cfg.achievements) {
    app.use('/achievements/v1', createAchievementsRouter(cfg, cfg.achievements));
    // The global-requests surface: a second sibling API. Same board registry,
    // same achievements.db, its own tables (migration step 1). Mounted here,
    // BEFORE mountWebUi, for the exact reason the achievements mount is: the
    // single-page catch-all only exempts /api/, so a requests path below it
    // would answer index.html and a 200. Gated on the same config: a sysop who
    // never configured achievements gets neither surface.
    app.use('/requests/v1', createRequestsRouter(cfg, cfg.achievements));
    // The federated live-chat surface: a third sibling API, same registry and
    // database, its own tables (migration step 2).
    app.use('/chat/v1', createChatRouter(cfg, cfg.achievements));
  }
  // The releases surface (AquaScan file listing): read-only, no keys, its own
  // database. Same mount rule as above — before the SPA catch-all — and the
  // same supported-absent semantics: unset RELEASES_DB, nothing mounted.
  if (cfg.releases) {
    app.use('/releases/v1', createReleasesRouter(cfg, cfg.releases));
  }
  // The integrations surface (external scene APIs for operator chats):
  // read-only, no keys, main database. Mounted before the SPA catch-all
  // like every other /api surface.
  app.use('/api/integrations/v1', doorRepoCors(), createIntegrationsRouter(cfg));
  mountWebUi(app);
  return app;
}

/**
 * The browser UI, built from ./web into dist/web and served from the SAME
 * origin as the API - so no CORS sits in front of the site itself, and one
 * container ships both halves.
 *
 * Mounted LAST: every /api path is already claimed above, and what remains
 * is either a hashed asset (immutable) or a client-side route, which gets
 * index.html so a deep link works on a hard refresh.
 *
 * A server built without the UI (a plain `tsc` run, or a test) simply has no
 * dist/web, and then this does nothing at all - the API still serves.
 */
function mountWebUi(app: express.Express): void {
  const webRoot = findBuiltUi();
  if (!webRoot) {
    return;
  }

  app.use(
    express.static(webRoot, {
      // Asset filenames carry a content hash, so they can be cached forever;
      // index.html must not be, or a deploy is invisible until a hard reload.
      setHeaders: (res, filePath) => {
        res.setHeader(
          'Cache-Control',
          filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
        );
      },
    })
  );

  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(webRoot, 'index.html'));
  });
}

/**
 * Where the BUILT site is, or null when it has not been built.
 *
 * Two layouts, because the server runs from two places: compiled, this file
 * is dist/src/app.js and the site is its sibling dist/web; from source (tsx,
 * jest) it is src/app.ts and the site is dist/web at the package root.
 *
 * The marker is the assets directory, not index.html: web/index.html is the
 * UNBUILT source template, which references /src/main.tsx and would serve a
 * blank page - a difference between dev and production that would only show
 * up in a browser.
 */
function findBuiltUi(): string | null {
  const candidates = [path.join(__dirname, '..', 'web'), path.join(__dirname, '..', 'dist', 'web')];
  return (
    candidates.find(
      (root) => fs.existsSync(path.join(root, 'index.html')) && fs.existsSync(path.join(root, 'assets'))
    ) ?? null
  );
}
