/**
 * Human corrections layered over the scanned catalog.
 *
 * The point of the overrides table is that a corpus re-scan can rewrite
 * door_catalog freely without destroying anything a person fixed by hand, so
 * these tests care about two things: an edit reaches every endpoint, and
 * removing it restores exactly what the scan said - byte for byte.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDb, applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { getCatalogEntryByArchive, getCatalogRevision } from '../src/catalog';
import { buildManifest, renderListTxt, _clearListCacheForTests } from '../src/manifest';
import { renderIndexTsv, renderIndexTsvCached, _clearIndexTsvCacheForTests } from '../src/index-tsv';
import { OVERRIDABLE_FIELDS, isOverridableField, loadOverrides, applyOverrides } from '../src/effective';
import type { ServerConfig } from '../src/config';

let dir: string;
let cfg: ServerConfig;

function override(field: string, value: string | null, at = 1700001000): void {
  const db = openDb(cfg);
  db.prepare(
    'INSERT OR REPLACE INTO door_catalog_overrides (catalog_id, field, value, edited_at) VALUES (?, ?, ?, ?)'
  ).run('id1', field, value, at);
  db.close();
  _clearListCacheForTests();
  _clearIndexTsvCacheForTests();
}

function revert(field: string): void {
  const db = openDb(cfg);
  db.prepare('DELETE FROM door_catalog_overrides WHERE catalog_id = ? AND field = ?').run('id1', field);
  db.close();
  _clearListCacheForTests();
  _clearIndexTsvCacheForTests();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-eff-'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = { dbPath, archivesRoot: dir, port: 3010, adminKeys: [], jwtSecret: null, learnKey: null };
  const db = openDb(cfg);
  applySchema(db);
  runMigrations(db);
  db.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, binary_name, name, door_type, author, release_group,
        file_id_diz, description, archive_size, md5, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'AmiExpress/ACC-V103.LHA', 'AccEd', 'Account Editor', 'XIM',
             'Wize/Access', 'ACS', 'Account Editor v1.0 for /X', '___ ART ___', 4711, 'aa', 1700000000)`
  ).run();
  db.close();
  _clearListCacheForTests();
  _clearIndexTsvCacheForTests();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the overrides layer', () => {
  it('every overridable field is a real column of door_catalog', () => {
    const db = openDb(cfg);
    const columns = (db.prepare('PRAGMA table_info(door_catalog)').all() as { name: string }[]).map((c) => c.name);
    db.close();
    for (const field of OVERRIDABLE_FIELDS) expect(columns).toContain(field);
  });

  it('refuses a field name that is not on the allowlist', () => {
    expect(isOverridableField('description')).toBe(true);
    // The admin API writes `field` straight from a request body; this is
    // what keeps that from reaching an arbitrary column.
    expect(isOverridableField('id')).toBe(false);
    expect(isOverridableField("md5' --")).toBe(false);
  });

  it('a stored NULL blanks the field rather than falling back to the scan', () => {
    override('author', null);
    const db = openDb(cfg);
    const row = applyOverrides({ author: 'Wize/Access' }, 'id1', loadOverrides(db));
    db.close();
    expect(row.author).toBeNull();
  });
});

describe('an edit reaches every endpoint', () => {
  it('index.tsv serves the edited description', () => {
    const before = renderIndexTsv(cfg).toString('latin1');
    expect(before).toContain('Account Editor');
    override('description', 'Edits every field of a user account');
    expect(renderIndexTsv(cfg).toString('latin1')).toContain('Edits every field of a user account');
  });

  it('list.txt and the manifest serve the same edited string', () => {
    override('description', 'Edits every field of a user account');
    const manifest = buildManifest(cfg);
    expect(manifest.doors[0].description).toBe('Edits every field of a user account');
    expect(renderListTxt(manifest).toString('latin1')).toContain('Edits every field of a user account');
  });

  it('a single-door lookup is corrected too', () => {
    override('name', 'Account Editor Deluxe');
    expect(getCatalogEntryByArchive(cfg, 'ACC-V103.LHA')?.name).toBe('Account Editor Deluxe');
  });

  it('an edited field the classifier would have derived wins over it', () => {
    // Without an override the version is read out of the DIZ ("v1.0").
    override('version', '9.9');
    expect(getCatalogEntryByArchive(cfg, 'ACC-V103.LHA')?.version).toBe('9.9');
  });
});

describe('the catalog revision carries edits', () => {
  it('is unchanged for a catalog nobody has corrected', () => {
    // Byte-identical to what the AmigaDOS clients have always seen: the
    // edit segment appears only once an edit exists.
    expect(getCatalogRevision(cfg)).toBe('c1-t1700000000');
  });

  it('changes when a field is edited, and again when the edit changes', () => {
    const clean = getCatalogRevision(cfg);
    override('description', 'first', 1700001000);
    const edited = getCatalogRevision(cfg);
    expect(edited).not.toBe(clean);
    expect(edited).toBe('c1-t1700000000-o1700001000');

    override('description', 'second', 1700002000);
    expect(getCatalogRevision(cfg)).toBe('c1-t1700000000-o1700002000');
  });

  it('stops a cache from serving pre-edit bytes', () => {
    const before = renderIndexTsvCached(cfg).toString('latin1');
    const db = openDb(cfg);
    db.prepare(
      'INSERT INTO door_catalog_overrides (catalog_id, field, value, edited_at) VALUES (?, ?, ?, ?)'
    ).run('id1', 'description', 'Edited behind the cache', 1700003000);
    db.close();
    // No cache clear here on purpose: the revision alone must invalidate it.
    expect(renderIndexTsvCached(cfg).toString('latin1')).toContain('Edited behind the cache');
    expect(renderIndexTsvCached(cfg).toString('latin1')).not.toBe(before);
  });
});

describe('reverting', () => {
  it('restores the scanned bytes exactly', () => {
    const original = {
      tsv: renderIndexTsv(cfg).toString('latin1'),
      list: renderListTxt(buildManifest(cfg)).toString('latin1'),
      revision: getCatalogRevision(cfg),
    };

    override('description', 'Something a human typed');
    override('name', 'A different name');
    expect(renderIndexTsv(cfg).toString('latin1')).not.toBe(original.tsv);

    revert('description');
    revert('name');

    expect(renderIndexTsv(cfg).toString('latin1')).toBe(original.tsv);
    expect(renderListTxt(buildManifest(cfg)).toString('latin1')).toBe(original.list);
    expect(getCatalogRevision(cfg)).toBe(original.revision);
  });

  it('reverting one field leaves the others edited', () => {
    override('description', 'kept');
    override('name', 'dropped');
    revert('name');
    const entry = getCatalogEntryByArchive(cfg, 'ACC-V103.LHA');
    expect(entry?.name).toBe('Account Editor');
    expect(entry?.description).toBe('kept');
  });
});
