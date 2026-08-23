// tests/db.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import type { ServerConfig } from '../src/config';

function tmpConfig(): { cfg: ServerConfig; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-db-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  return {
    dir,
    cfg: { dbPath, archivesRoot: path.join(dir, 'Archives'), port: 3010, adminKeys: [] },
  };
}

describe('db', () => {
  it('creates both catalog tables', () => {
    const { cfg, dir } = tmpConfig();
    const db = openDb(cfg);
    applySchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(tables).toEqual(expect.arrayContaining(['door_catalog', 'door_catalog_files']));
  });

  it('does not carry the per-node install columns', () => {
    const { cfg, dir } = tmpConfig();
    const db = openDb(cfg);
    applySchema(db);
    const cols = db.prepare('PRAGMA table_info(door_catalog)').all()
      .map((r) => (r as { name: string }).name);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(cols).not.toContain('installed');
    expect(cols).not.toContain('installed_as');
    expect(cols).not.toContain('install_dir');
  });

  it('opens read-only when asked and refuses writes', () => {
    const { cfg, dir } = tmpConfig();
    const rw = openDb(cfg);
    applySchema(rw);
    rw.close();
    const ro = openDb(cfg, { readonly: true });
    expect(() =>
      ro.prepare("INSERT INTO door_catalog (id, archive_name, archive_path, name) VALUES ('x','X.LHA','X.LHA','X')").run()
    ).toThrow();
    ro.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent when the schema is applied twice', () => {
    const { cfg, dir } = tmpConfig();
    const db = openDb(cfg);
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
