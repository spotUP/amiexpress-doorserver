// tests/startup.test.ts
/**
 * Covers FIX 2 from the phase-1 final review: nothing stopped the server
 * publishing an empty catalog. A present-but-unmigrated doors.db (the
 * volume on the host is seeded by hand, so this is a live failure mode)
 * started happily and served `revision c0-t0` with a valid ETag and zero
 * doors - a valid revision that poisons every client's cache. Worse, a
 * schema-less file made getDoorCount() throw inside the app.listen
 * callback, after the port was already bound.
 *
 * assertCatalogUsable() is exported from src/index.ts specifically so this
 * can be asserted without binding a port or spawning a process: importing
 * src/index.ts does not call main() (guarded by `require.main === module`),
 * so this test only ever exercises the pure catalog check.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import { assertCatalogUsable } from '../src/index';
import type { ServerConfig } from '../src/config';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-startup-'));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function cfgFor(dbPath: string): ServerConfig {
  return { dbPath, archivesRoot: dir, port: 3010, adminKeys: [] };
}

describe('assertCatalogUsable', () => {
  it('refuses a migrated-but-empty catalog', () => {
    const dbPath = path.join(dir, 'doors.db');
    fs.writeFileSync(dbPath, '');
    const db = openDb(cfgFor(dbPath));
    applySchema(db);
    db.close();

    expect(() => assertCatalogUsable(cfgFor(dbPath))).toThrow(/holds no doors/);
  });

  it('refuses a present-but-unmigrated (schema-less) file', () => {
    const dbPath = path.join(dir, 'doors.db');
    fs.writeFileSync(dbPath, '');
    // No applySchema() call: a valid, empty sqlite file with no
    // door_catalog table - exactly what a hand-seeded volume can produce.

    expect(() => assertCatalogUsable(cfgFor(dbPath))).toThrow(/cannot read the catalog/);
  });

  it('returns the door count for a usable catalog', () => {
    const dbPath = path.join(dir, 'doors.db');
    fs.writeFileSync(dbPath, '');
    const db = openDb(cfgFor(dbPath));
    applySchema(db);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id1', 'ACC-V103.LHA', 'FAME/ACC-V103.LHA', 'Account Editor', 'XIM', 1700000000)`
    ).run();
    db.close();

    expect(assertCatalogUsable(cfgFor(dbPath))).toBe(1);
  });
});
