/**
 * Regression: every endpoint classifies ads through the same code.
 *
 * Two classifiers used to disagree. The admin strip-preview opened the
 * archive and classified it live, applying learned patterns and the
 * per-archive keep-list. GET /files/<archive> - what the DoorRepo door reads
 * - served the is_junk column written at index time, and nothing ever
 * recomputed it. So the operator was shown one answer and the door another,
 * on the same archive: reported on -D-CALC.LHA, where sanctuary.txt matches
 * the seed pattern `sanctuary.*`, the preview flagged it and the door listed
 * it as an ordinary file.
 *
 * That is not only cosmetic. The door strips ads on install by removing the
 * files whose flag is 1, so a stale 0 leaves an ad on the board.
 *
 * classify.ts is now the single answer, and it writes what it computes back
 * so the denormalised junk_count and the catalog revision stop lying too.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { openDb, applySchema } from '../src/db';
import { createApp } from '../src/app';
import { _clearListCacheForTests } from '../src/manifest';
import type { ServerConfig } from '../src/config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AdmZip = require('adm-zip');

let dir: string;
let cfg: ServerConfig;
let app: ReturnType<typeof createApp>;

/** An archive holding one real door file and one scene ad. */
function writeArchive(archivePath: string): void {
  const zip = new AdmZip();
  zip.addFile('CALC.rexx', Buffer.from('/* a door */\n'));
  zip.addFile('sanctuary.txt', Buffer.from('call the sanctuary bbs!\n'));
  zip.writeZip(archivePath);
}

function db() {
  return openDb(cfg);
}

function filesOf(text: string): string[] {
  return text.split('\r\n').filter((l) => l !== '' && !l.startsWith('FILES|'));
}

beforeEach(() => {
  _clearListCacheForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-cls-'));
  fs.mkdirSync(path.join(dir, 'Archives'));
  writeArchive(path.join(dir, 'Archives', 'ADDOOR.ZIP'));

  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = {
    dbPath,
    archivesRoot: path.join(dir, 'Archives'),
    port: 3010,
    adminKeys: [],
    jwtSecret: null,
    learnKey: null,
  };

  const d = openDb(cfg);
  applySchema(d);
  d.prepare(
    `INSERT INTO door_catalog
       (id, archive_name, archive_path, name, door_type, archive_size, indexed_at, junk_count)
     VALUES ('id1', 'ADDOOR.ZIP', 'ADDOOR.ZIP', 'Ad Door', 'XIM', 5, 1700000000, 0)`
  ).run();
  // The stale state this fix exists for: the ad is stored as NOT junk,
  // exactly as a row indexed before the pattern set grew.
  d.prepare(
    `INSERT INTO door_catalog_files (catalog_id, path, size, is_junk, junk_reason)
     VALUES ('id1', 'CALC.rexx', 13, 0, NULL), ('id1', 'sanctuary.txt', 24, 0, NULL)`
  ).run();
  d.close();

  app = createApp(cfg);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('the door listing flags an ad the stored row called ordinary', async () => {
  const res = await request(app).get('/api/door-repo/files/ADDOOR.ZIP');

  expect(res.status).toBe(200);
  const rows = filesOf(res.text);
  const ad = rows.find((r) => r.endsWith('|sanctuary.txt'));
  expect(ad).toBeDefined();
  // "<size>|<isJunk>|<path>" - before this fix the middle field was 0.
  expect(ad!.split('|')[1]).toBe('1');
  expect(res.text.split('\r\n')[0]).toBe('FILES|2|1');
});

it('heals the stored row, so the next read is cheap and also correct', async () => {
  await request(app).get('/api/door-repo/files/ADDOOR.ZIP');

  const d = db();
  const row = d
    .prepare("SELECT is_junk FROM door_catalog_files WHERE catalog_id='id1' AND path='sanctuary.txt'")
    .get() as { is_junk: number };
  d.close();

  expect(row.is_junk).toBe(1);
});

it('updates the denormalised junk_count the catalog and list.txt report', async () => {
  await request(app).get('/api/door-repo/files/ADDOOR.ZIP');

  const d = db();
  const row = d.prepare("SELECT junk_count FROM door_catalog WHERE id='id1'").get() as {
    junk_count: number;
  };
  d.close();

  expect(row.junk_count).toBe(1);
});

it('moves the catalog revision, so every cached client comes back for it', async () => {
  // The door caches list.txt and its per-archive panes against this
  // revision. A classification change nobody is told about is a
  // classification change the door never sees.
  const before = (await request(app).get('/api/door-repo/files/ADDOOR.ZIP')).headers[
    'x-door-repo-revision'
  ];
  const d = db();
  const stamp = d.prepare("SELECT indexed_at FROM door_catalog WHERE id='id1'").get() as {
    indexed_at: number;
  };
  d.close();

  expect(stamp.indexed_at).toBeGreaterThan(1700000000);
  expect(before).toBeDefined();
});

it('does not move the revision when nothing changed', async () => {
  // Re-reading a settled archive must be free of side effects, or the
  // revision churns on every request and every cache in the fleet
  // re-downloads the catalog forever.
  await request(app).get('/api/door-repo/files/ADDOOR.ZIP');
  const d1 = db();
  const first = (d1.prepare("SELECT indexed_at FROM door_catalog WHERE id='id1'").get() as {
    indexed_at: number;
  }).indexed_at;
  d1.close();

  await request(app).get('/api/door-repo/files/ADDOOR.ZIP');
  const d2 = db();
  const second = (d2.prepare("SELECT indexed_at FROM door_catalog WHERE id='id1'").get() as {
    indexed_at: number;
  }).indexed_at;
  d2.close();

  expect(second).toBe(first);
});

it('applies a learned pattern added after the archive was indexed', async () => {
  await request(app).get('/api/door-repo/files/ADDOOR.ZIP');

  const d = db();
  d.prepare('INSERT INTO learned_junk_patterns (pattern) VALUES (?)').run('calc.rexx');
  d.close();

  const res = await request(app).get('/api/door-repo/files/ADDOOR.ZIP');
  const rows = filesOf(res.text);
  const learned = rows.find((r) => r.endsWith('|CALC.rexx'));

  expect(learned!.split('|')[1]).toBe('1');
  expect(res.text.split('\r\n')[0]).toBe('FILES|2|2');
});

it('honours a per-archive keep-list entry over the classifier', async () => {
  const d = db();
  d.prepare('INSERT INTO door_not_junk (archive_name, file_path) VALUES (?, ?)').run(
    'ADDOOR.ZIP',
    'sanctuary.txt'
  );
  d.close();

  const res = await request(app).get('/api/door-repo/files/ADDOOR.ZIP');
  const ad = filesOf(res.text).find((r) => r.endsWith('|sanctuary.txt'));

  // The operator said keep it; the classifier does not get to overrule that.
  expect(ad!.split('|')[1]).toBe('0');
});

it('falls back to the stored rows when the archive is unreadable', async () => {
  // A listing that is slightly stale beats an endpoint that 500s - and LZX
  // archives have no reader on this server at all.
  fs.writeFileSync(path.join(dir, 'Archives', 'ADDOOR.ZIP'), Buffer.from([0, 1, 2, 3]));

  const res = await request(app).get('/api/door-repo/files/ADDOOR.ZIP');

  expect(res.status).toBe(200);
  expect(filesOf(res.text)).toHaveLength(2);
});

it('serves a missing archive from the stored rows rather than failing', async () => {
  fs.rmSync(path.join(dir, 'Archives', 'ADDOOR.ZIP'));

  const res = await request(app).get('/api/door-repo/files/ADDOOR.ZIP');

  expect(res.status).toBe(200);
  expect(filesOf(res.text)).toHaveLength(2);
});
