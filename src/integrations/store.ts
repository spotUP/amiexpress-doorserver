/**
 * Store for the external scene-API integrations (operator-chat sources).
 *
 * Three tables (migration 16): `integration_config` (enabled toggle +
 * per-source settings JSON), `integration_secrets` (write-only API keys -
 * there is deliberately NO function here that returns a secret to a
 * route), `integration_cache` (cache-first serving with per-entry TTL).
 *
 * The store takes an open better-sqlite3 handle and never opens one
 * itself: routes follow the public-routes pattern (open per request,
 * close in finally), tests hand it a temp DB.
 */
import type Database from 'better-sqlite3';

export interface IntegrationConfig {
  source: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  updatedAt: number;
}

export interface CachedBody {
  body: string;
  fetchedAt: number;
  ttlSeconds: number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function listConfigs(db: Database.Database): IntegrationConfig[] {
  const rows = db
    .prepare('SELECT source, enabled, settings_json, updated_at FROM integration_config ORDER BY source')
    .all() as Array<{ source: string; enabled: number; settings_json: string; updated_at: number }>;
  return rows.map((r) => ({
    source: r.source,
    enabled: r.enabled === 1,
    settings: JSON.parse(r.settings_json) as Record<string, unknown>,
    updatedAt: r.updated_at,
  }));
}

export function getConfig(db: Database.Database, source: string): IntegrationConfig | null {
  const r = db
    .prepare('SELECT source, enabled, settings_json, updated_at FROM integration_config WHERE source = ?')
    .get(source) as { source: string; enabled: number; settings_json: string; updated_at: number } | undefined;
  if (!r) return null;
  return {
    source: r.source,
    enabled: r.enabled === 1,
    settings: JSON.parse(r.settings_json) as Record<string, unknown>,
    updatedAt: r.updated_at,
  };
}

/** Upsert. Merging with the existing settings keeps a PATCH of one key
 *  from wiping the rest; pass replace=true only from a full-form PUT. */
export function setConfig(
  db: Database.Database,
  source: string,
  patch: { enabled?: boolean; settings?: Record<string, unknown> },
  opts?: { replace?: boolean }
): IntegrationConfig {
  const current = getConfig(db, source);
  const settings =
    opts?.replace || !current
      ? (patch.settings ?? {})
      : { ...current.settings, ...(patch.settings ?? {}) };
  const enabled = patch.enabled ?? current?.enabled ?? true;
  db.prepare(
    `INSERT INTO integration_config (source, enabled, settings_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (source) DO UPDATE SET enabled = excluded.enabled,
       settings_json = excluded.settings_json, updated_at = excluded.updated_at`
  ).run(source, enabled ? 1 : 0, JSON.stringify(settings), nowSeconds());
  return getConfig(db, source) as IntegrationConfig;
}

/** Write-only by design: the value goes in, and no code path here hands
 *  it back. Adapters read it via getSecretForAdapter (server-side only);
 *  routes expose only hasSecret ("saved" state for the panel). */
export function setSecret(db: Database.Database, source: string, keyName: string, secret: string): void {
  db.prepare(
    `INSERT INTO integration_secrets (source, key_name, secret, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (source, key_name) DO UPDATE SET secret = excluded.secret,
       updated_at = excluded.updated_at`
  ).run(source, keyName, secret, nowSeconds());
}

export function deleteSecret(db: Database.Database, source: string, keyName: string): void {
  db.prepare('DELETE FROM integration_secrets WHERE source = ? AND key_name = ?').run(source, keyName);
}

/** What the admin panel may show: names only, never values. */
export function listSecretNames(db: Database.Database, source: string): string[] {
  const rows = db
    .prepare('SELECT key_name FROM integration_secrets WHERE source = ? ORDER BY key_name')
    .all(source) as Array<{ key_name: string }>;
  return rows.map((r) => r.key_name);
}

/** Server-side only. Never call this from a route handler that
 *  serializes its result. */
export function getSecretForAdapter(
  db: Database.Database,
  source: string,
  keyName: string
): string | null {
  const r = db
    .prepare('SELECT secret FROM integration_secrets WHERE source = ? AND key_name = ?')
    .get(source, keyName) as { secret: string } | undefined;
  return r?.secret ?? null;
}

/** Fresh entry or null (missing or past its TTL - stale rows are left
 *  for pruneCache, so a failed refresh can still serve them explicitly). */
export function getCache(db: Database.Database, key: string, atSeconds?: number): CachedBody | null {
  const r = db
    .prepare('SELECT body, fetched_at, ttl_seconds FROM integration_cache WHERE cache_key = ?')
    .get(key) as { body: string; fetched_at: number; ttl_seconds: number } | undefined;
  if (!r) return null;
  const now = atSeconds ?? nowSeconds();
  if (now - r.fetched_at > r.ttl_seconds) return null;
  return { body: r.body, fetchedAt: r.fetched_at, ttlSeconds: r.ttl_seconds };
}

/** Last-known body regardless of TTL: the degraded answer when a live
 *  refresh fails. Null only when nothing was ever cached. */
export function getStaleCache(db: Database.Database, key: string): CachedBody | null {
  const r = db
    .prepare('SELECT body, fetched_at, ttl_seconds FROM integration_cache WHERE cache_key = ?')
    .get(key) as { body: string; fetched_at: number; ttl_seconds: number } | undefined;
  if (!r) return null;
  return { body: r.body, fetchedAt: r.fetched_at, ttlSeconds: r.ttl_seconds };
}

export function setCache(db: Database.Database, key: string, body: string, ttlSeconds: number): void {
  db.prepare(
    `INSERT INTO integration_cache (cache_key, body, fetched_at, ttl_seconds)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (cache_key) DO UPDATE SET body = excluded.body,
       fetched_at = excluded.fetched_at, ttl_seconds = excluded.ttl_seconds`
  ).run(key, body, nowSeconds(), ttlSeconds);
}

/** Returns rows deleted. Call on a timer, not per request. */
export function pruneCache(db: Database.Database, atSeconds?: number): number {
  const now = atSeconds ?? nowSeconds();
  const r = db
    .prepare('DELETE FROM integration_cache WHERE ? - fetched_at > ttl_seconds')
    .run(now);
  return Number(r.changes);
}
