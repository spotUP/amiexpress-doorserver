// tests/integrations/store.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../../src/db';
import { runMigrations } from '../../src/migrations';
import {
  listConfigs, getConfig, setConfig,
  setSecret, deleteSecret, listSecretNames, getSecretForAdapter,
  getCache, getStaleCache, setCache, pruneCache,
} from '../../src/integrations/store';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-int-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  const db = openDb({ dbPath } as never);
  applySchema(db);
  runMigrations(db);
  return { dir, db };
}

describe('integration store', () => {
  it('creates the three tables via migration 16', () => {
    const { dir, db } = tmpDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(
      ['integration_config', 'integration_secrets', 'integration_cache']));
    const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 16').get();
    expect(applied).toBeTruthy();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upserts config and merges settings by default', () => {
    const { dir, db } = tmpDb();
    setConfig(db, 'modarchive', { settings: { baseUrl: 'https://x' } });
    setConfig(db, 'modarchive', { enabled: false, settings: { timeoutMs: 8000 } });
    const got = getConfig(db, 'modarchive');
    expect(got?.enabled).toBe(false);
    expect(got?.settings).toEqual({ baseUrl: 'https://x', timeoutMs: 8000 });
    setConfig(db, 'modarchive', { settings: { only: 1 } }, { replace: true });
    expect(getConfig(db, 'modarchive')?.settings).toEqual({ only: 1 });
    expect(listConfigs(db).map((c) => c.source)).toContain('modarchive');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps secrets out of every listing the panel can see', () => {
    const { dir, db } = tmpDb();
    setSecret(db, 'modarchive', 'api_key', 'SUPER-SECRET-VALUE');
    expect(listSecretNames(db, 'modarchive')).toEqual(['api_key']);
    // The panel-safe surfaces carry no secret material...
    expect(JSON.stringify(listConfigs(db))).not.toContain('SUPER-SECRET-VALUE');
    expect(JSON.stringify(listSecretNames(db, 'modarchive'))).not.toContain('SUPER-SECRET-VALUE');
    // ...while the server-side adapter path still reads it.
    expect(getSecretForAdapter(db, 'modarchive', 'api_key')).toBe('SUPER-SECRET-VALUE');
    deleteSecret(db, 'modarchive', 'api_key');
    expect(getSecretForAdapter(db, 'modarchive', 'api_key')).toBeNull();
    expect(listSecretNames(db, 'modarchive')).toEqual([]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves fresh cache, hides expired, keeps stale for degrade', () => {
    const { dir, db } = tmpDb();
    setCache(db, 'pouet:random', '{"a":1}', 60);
    expect(getCache(db, 'pouet:random')?.body).toBe('{"a":1}');
    // 61 simulated seconds later: fresh read misses...
    expect(getCache(db, 'pouet:random', Math.floor(Date.now() / 1000) + 61)).toBeNull();
    // ...but the stale body survives for the degraded answer.
    expect(getStaleCache(db, 'pouet:random')?.body).toBe('{"a":1}');
    expect(getStaleCache(db, 'never-cached')).toBeNull();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prunes only expired rows', () => {
    const { dir, db } = tmpDb();
    setCache(db, 'fresh', '{}', 3600);
    setCache(db, 'old', '{}', 1);
    const deleted = pruneCache(db, Math.floor(Date.now() / 1000) + 61);
    expect(deleted).toBe(1);
    expect(getStaleCache(db, 'fresh')?.body).toBe('{}');
    expect(getStaleCache(db, 'old')).toBeNull();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
