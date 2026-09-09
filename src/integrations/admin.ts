/**
 * Admin management for the external scene-API integrations.
 *
 * Mounted under /api/door-repo/admin (requireAdmin). Read endpoints
 * never return secret values - only names ("saved" state for the
 * panel). Writes audit-log via recordAudit (key rotations included;
 * secret VALUES never enter the audit row). Secrets + test endpoints
 * carry a small per-IP limiter (live fan-out costs real upstream
 * calls; the login lockout in admin-routes.ts is the pattern).
 *
 * Prior integrations ride along as read-only cards: Demozoo offline
 * enrichment (last import, rows enriched, re-run command) and the
 * releases listing (revision, row count, uploader coverage).
 */
import { Router, type Response } from 'express';
import type { ServerConfig } from '../config';
import { openDb } from '../db';
import { requireAdmin, recordAudit, type AuthedRequest } from '../auth';
import {
  listConfigs, getConfig, setConfig,
  setSecret, deleteSecret, listSecretNames, getSecretForAdapter,
} from './store';
import { ADAPTERS, STATUS_ADAPTERS } from './answer';
import {
  BUILTIN_IDS, validateCustomSource, previewCustomSource,
  customSourceId, CUSTOM_PREFIX, type CustomSourceConfig,
} from './custom';
import { getReleasesRevision, getReleasesCount, getReleasesStats } from '../releases/store';
import { createFetchJson, createFetchText, createHeadStatus } from './fetch';

const SECRET_WINDOW_MS = 60 * 1000;
const SECRET_MAX = 10;
const TEST_WINDOW_MS = 60 * 1000;
const TEST_MAX = 20;
const hits = new Map<string, { at: number; n: number }>();

function limited(ip: string, windowMs: number, max: number): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > windowMs) {
    hits.set(ip, { at: now, n: 1 });
    return false;
  }
  h.n += 1;
  return h.n > max;
}

function rateLimit(windowMs: number, max: number) {
  return (req: AuthedRequest, res: Response, next: () => void) => {
    const ip = String(req.ip ?? 'local');
    if (limited(`${req.path}:${ip}`, windowMs, max)) {
      res.status(429).json({ error: 'too many requests; try again in a minute' });
      return;
    }
    next();
  };
}

const limitSecrets = rateLimit(SECRET_WINDOW_MS, SECRET_MAX);
const limitTest = rateLimit(TEST_WINDOW_MS, TEST_MAX);

export function createIntegrationsAdminRouter(cfg: ServerConfig): Router {
  const router = Router();

  /** Stored state for every source: built-ins plus customs. Fast, no
   *  live fetches - the panel reads health from the public /status. */
  router.get('/', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const db = openDb(cfg);
    try {
      const rows = listConfigs(db);
      const bySource = new Map(rows.map((r) => [r.source, r]));
      const out: Array<Record<string, unknown>> = STATUS_ADAPTERS.map((a) => {
        const row = bySource.get(a.id);
        return {
          id: a.id,
          name: a.name,
          needsKey: a.needsKey,
          builtin: true,
          enabled: row ? row.enabled : !a.needsKey,
          settings: row ? row.settings : {},
          secretNames: a.needsKey ? listSecretNames(db, a.id) : [],
        };
      });
      for (const row of rows) {
        if (!row.source.startsWith(CUSTOM_PREFIX)) continue;
        const cfg = row.settings as unknown as CustomSourceConfig;
        out.push({
          id: row.source,
          name: (cfg && cfg.displayName) || row.source.slice(CUSTOM_PREFIX.length),
          needsKey: (cfg && cfg.authMode !== 'none') || false,
          builtin: false,
          enabled: row.enabled,
          settings: row.settings,
          secretNames: listSecretNames(db, row.source),
          errors: validateCustomSource(cfg),
        });
      }
      res.json({ sources: out });
    } finally {
      db.close();
    }
  });

  /** Enable/disable + settings. Customs re-validate; invalid stays
   *  stored but dark (errors ride the GET above). */
  router.patch('/:id', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as { enabled?: unknown; settings?: unknown };
    const db = openDb(cfg);
    try {
      if (id.startsWith(CUSTOM_PREFIX)) {
        const current = getConfig(db, id);
        if (!current) {
          res.status(404).json({ error: 'no such integration' });
          return;
        }
        const next = setConfig(db, id, {
          enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
          settings: (body.settings ?? {}) as Record<string, unknown>,
        }, { replace: true });
        const errors = validateCustomSource(next.settings);
        recordAudit(db, req.admin?.id ?? null, 'integration.update', `${id} enabled=${next.enabled}`);
        res.json({ source: next, errors });
        return;
      }
      if (!BUILTIN_IDS.includes(id) && !ADAPTERS.some((a) => a.id === id)) {
        res.status(404).json({ error: 'no such integration' });
        return;
      }
      const next = setConfig(db, id, {
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        settings: (body.settings ?? {}) as Record<string, unknown>,
      });
      recordAudit(db, req.admin?.id ?? null, 'integration.update', `${id} enabled=${next.enabled}`);
      res.json({ source: next });
    } finally {
      db.close();
    }
  });

  /** Add a custom source. The secret comes separately (POST secrets). */
  router.post('/', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors = validateCustomSource(body);
    if (errors.length) {
      res.status(400).json({ error: errors[0], errors });
      return;
    }
    const id = customSourceId(String(body.name));
    const db = openDb(cfg);
    try {
      if (getConfig(db, id)) {
        res.status(409).json({ error: 'that source already exists' });
        return;
      }
      const row = setConfig(db, id, { settings: body as Record<string, unknown> });
      recordAudit(db, req.admin?.id ?? null, 'integration.create', id);
      res.status(201).json({ source: row, errors: [] });
    } finally {
      db.close();
    }
  });

  /** Delete a custom source (built-ins disable, never delete). Secrets
   *  for the source go with it. */
  router.delete('/:id', requireAdmin(cfg), (req: AuthedRequest, res: Response) => {
    const id = String(req.params.id);
    if (!id.startsWith(CUSTOM_PREFIX)) {
      res.status(400).json({ error: 'built-in sources disable, they are never deleted' });
      return;
    }
    const db = openDb(cfg);
    try {
      if (!getConfig(db, id)) {
        res.status(404).json({ error: 'no such integration' });
        return;
      }
      const apply = db.transaction(() => {
        db.prepare('DELETE FROM integration_secrets WHERE source = ?').run(id);
        db.prepare('DELETE FROM integration_cache WHERE cache_key LIKE ?').run(`%${id}%`);
        db.prepare('DELETE FROM integration_config WHERE source = ?').run(id);
      });
      apply();
      recordAudit(db, req.admin?.id ?? null, 'integration.delete', id);
      res.json({ deleted: id });
    } finally {
      db.close();
    }
  });

  /** Store/rotate a secret. The value is never returned, never logged. */
  router.post('/:id/secrets', requireAdmin(cfg), limitSecrets, (req: AuthedRequest, res: Response) => {
    const id = String(req.params.id);
    const body = (req.body ?? {}) as { keyName?: unknown; secret?: unknown };
    const keyName = typeof body.keyName === 'string' && body.keyName ? body.keyName : 'api_key';
    if (typeof body.secret !== 'string' || !body.secret) {
      res.status(400).json({ error: 'secret is required' });
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyName)) {
      res.status(400).json({ error: 'bad key name' });
      return;
    }
    const db = openDb(cfg);
    try {
      const known = getConfig(db, id) || STATUS_ADAPTERS.some((a) => a.id === id);
      if (!known) {
        res.status(404).json({ error: 'no such integration' });
        return;
      }
      setSecret(db, id, keyName, body.secret);
      recordAudit(db, req.admin?.id ?? null, 'integration.secret', `${id}:${keyName} stored`);
      res.json({ source: id, keyName, stored: true });
    } finally {
      db.close();
    }
  });

  router.delete('/:id/secrets/:keyName', requireAdmin(cfg), limitSecrets, (req: AuthedRequest, res: Response) => {
    const id = String(req.params.id);
    const keyName = String(req.params.keyName);
    const db = openDb(cfg);
    try {
      deleteSecret(db, id, keyName);
      recordAudit(db, req.admin?.id ?? null, 'integration.secret', `${id}:${keyName} deleted`);
      res.json({ source: id, keyName, stored: false });
    } finally {
      db.close();
    }
  });

  /** Test button: canned query against the live source. Customs show raw
   *  JSON beside the mapped preview; built-ins show mapped hits. Secrets
   *  are applied server-side and never echoed. */
  router.post('/:id/test', requireAdmin(cfg), limitTest, async (req: AuthedRequest, res: Response) => {
    const id = String(req.params.id);
    const q = String((req.body as { q?: unknown } | null)?.q ?? 'demo').slice(0, 120);
    const db = openDb(cfg);
    try {
      if (id.startsWith(CUSTOM_PREFIX)) {
        const row = getConfig(db, id);
        if (!row) {
          res.status(404).json({ error: 'no such integration' });
          return;
        }
        const cfg = row.settings as unknown as CustomSourceConfig;
        const errors = validateCustomSource(cfg);
        if (errors.length) {
          res.status(400).json({ error: errors[0], errors });
          return;
        }
        try {
          const preview = await previewCustomSource(cfg, q, {
            fetchJson: async () => { throw new Error('unreachable'); },
            fetchText: undefined,
            getSecret: (k) => getSecretForAdapter(db, id, k),
            settings: {},
          });
          res.json({ source: id, query: q, raw: preview.raw, mapped: preview.mapped });
        } catch (e) {
          res.json({ source: id, query: q, error: (e as Error).message });
        }
        return;
      }
      const adapter = STATUS_ADAPTERS.find((a) => a.id === id);
      if (!adapter || !adapter.search) {
        res.status(404).json({ error: 'no such integration' });
        return;
      }
      try {
        const mapped = await adapter.search(q, {
          fetchJson: createFetchJson(),
          fetchText: createFetchText(),
          head: createHeadStatus(),
          getSecret: (k) => getSecretForAdapter(db, id, k),
          settings: getConfig(db, id)?.settings ?? {},
        });
        res.json({ source: id, query: q, mapped });
      } catch (e) {
        res.json({ source: id, query: q, error: (e as Error).message });
      }
    } finally {
      db.close();
    }
  });

  /** Prior integration: Demozoo offline enrichment status + re-run line. */
  router.get('/demozoo-import', requireAdmin(cfg), (_req: AuthedRequest, res: Response) => {
    const db = openDb(cfg);
    try {
      const hasTable = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='demozoo_imported'"
      ).get();
      const processed = hasTable
        ? (db.prepare('SELECT COUNT(*) AS n FROM demozoo_imported').get() as { n: number }).n
        : 0;
      const lastAt = hasTable
        ? (db.prepare('SELECT MAX(imported_at) AS t FROM demozoo_imported').get() as { t: number | null }).t
        : null;
      let enriched = 0;
      try {
        enriched = (db.prepare(
          "SELECT COUNT(*) AS n FROM door_catalog WHERE demozoo_url IS NOT NULL AND demozoo_url != ''"
        ).get() as { n: number }).n;
      } catch {
        enriched = 0;
      }
      res.json({
        processed,
        lastImportAt: lastAt,
        rowsEnriched: enriched,
        rerun: 'npx tsx scripts/demozoo-import.ts --help  # then --limit N [--resume]; see scripts/demozoo-import.ts:34-43 for flags',
      });
    } finally {
      db.close();
    }
  });

  /** Prior integration: the releases listing as health signals. */
  router.get('/releases', requireAdmin(cfg), (_req: AuthedRequest, res: Response) => {
    if (!cfg.releases) {
      res.status(404).json({ error: 'releases surface is not configured' });
      return;
    }
    try {
      const stats = getReleasesStats(cfg.releases);
      res.json({
        revision: getReleasesRevision(cfg.releases),
        rows: getReleasesCount(cfg.releases),
        stats,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
