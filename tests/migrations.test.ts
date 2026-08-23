/**
 * The migration runner: it must be safe to start the server twice.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import { runMigrations, hasColumn, MIGRATIONS, type Migration } from '../src/migrations';
import type { ServerConfig } from '../src/config';

let dir: string;
let cfg: ServerConfig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-mig-'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: dir, port: 3010, adminKeys: [] };
  const db = openDb(cfg);
  applySchema(db);
  db.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'AmiExpress/ACC-V103.LHA', 'Account Editor', 'XIM', 1700000000)`
  ).run();
  db.close();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runMigrations', () => {
  it('adds requires_bbs to a catalog that predates it', () => {
    const db = openDb(cfg);
    expect(hasColumn(db, 'door_catalog', 'requires_bbs')).toBe(false);
    const ran = runMigrations(db);
    expect(ran).toEqual(['1:door_catalog.requires_bbs']);
    expect(hasColumn(db, 'door_catalog', 'requires_bbs')).toBe(true);
    db.close();
  });

  it('is a no-op the second time, and leaves the rows alone', () => {
    const db = openDb(cfg);
    runMigrations(db);
    db.prepare("UPDATE door_catalog SET requires_bbs = '/X 3.38+' WHERE id = 'id1'").run();
    expect(runMigrations(db)).toEqual([]);
    const row = db.prepare('SELECT name, requires_bbs FROM door_catalog WHERE id = ?').get('id1') as {
      name: string;
      requires_bbs: string;
    };
    expect(row).toEqual({ name: 'Account Editor', requires_bbs: '/X 3.38+' });
    db.close();
  });

  it('records what it applied', () => {
    const db = openDb(cfg);
    runMigrations(db);
    const rows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
    db.close();
  });

  it('rolls a failing step back rather than half-applying it', () => {
    const bad: Migration[] = [
      {
        version: 99,
        name: 'breaks halfway',
        up: (db) => {
          db.exec('CREATE TABLE half_applied (x TEXT)');
          throw new Error('boom');
        },
      },
    ];
    const db = openDb(cfg);
    expect(() => runMigrations(db, bad)).toThrow('boom');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_applied'")
      .all();
    expect(tables).toEqual([]);
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([]);
    db.close();
  });
});
