/**
 * Anonymous submissions.
 *
 * This is the only endpoint on the server a stranger can write to, so most
 * of what follows is about what it refuses: the wrong size, the wrong kind
 * of file, a file lying about what it is, a name that tries to escape the
 * directory, a duplicate, and too many in one day. The rest is the promise
 * that nothing published itself - a pending submission is invisible until a
 * curator says otherwise.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { openDb, applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { createApp } from '../src/app';
import { bootstrapAdmins } from '../src/auth';
import { _clearLoginFailuresForTests } from '../src/admin-routes';
import { _clearIndexTsvCacheForTests } from '../src/index-tsv';
import { _clearListCacheForTests } from '../src/manifest';
import { quarantineDir, safeArchiveName, sniffArchive } from '../src/submissions';
import type { ServerConfig } from '../src/config';

const SECRET = 'a-test-secret-that-is-long-enough-to-pass';
let dir: string;
let cfg: ServerConfig;
let token: string;

/** A minimal but genuine LHA header: the "-lh5-" marker sits at offset 2. */
function lhaBytes(payload = 'door'): Buffer {
  const head = Buffer.alloc(22, 0);
  head.write('-lh5-', 2, 'latin1');
  return Buffer.concat([head, Buffer.from(payload, 'latin1')]);
}

/** What is sitting in quarantine - and an absent directory means nothing is. */
function quarantineFiles(): string[] {
  const dir = quarantineDir(cfg);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

const app = () => createApp(cfg);
const auth = () => ({ Authorization: `Bearer ${token}` });

function submit(bytes: Buffer, filename: string, note?: string) {
  const req = request(app()).post('/api/door-repo/submissions').attach('file', bytes, filename);
  return note ? req.field('note', note) : req;
}

beforeEach(async () => {
  _clearLoginFailuresForTests();
  _clearIndexTsvCacheForTests();
  _clearListCacheForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-sub-'));
  fs.mkdirSync(path.join(dir, 'archives'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = {
    dbPath,
    archivesRoot: path.join(dir, 'archives'),
    port: 3010,
    adminKeys: [{ label: 'spot', key: 'correct horse battery staple' }],
    jwtSecret: SECRET,
  };
  const db = openDb(cfg);
  applySchema(db);
  runMigrations(db);
  bootstrapAdmins(db, cfg);
  db.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, sha256, indexed_at)
     VALUES ('id1', 'KNOWN.LHA', 'AmiExpress/KNOWN.LHA', 'Known', 'XIM',
             'e0f1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff', 1700000000)`
  ).run();
  db.close();

  const res = await request(app())
    .post('/api/door-repo/admin/login')
    .send({ username: 'spot', password: 'correct horse battery staple' });
  token = res.body.token;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('what a submission may be', () => {
  it('accepts an Amiga archive and puts it in the queue', async () => {
    const res = await submit(lhaBytes(), 'NEWDOOR.LHA', 'found this on a floppy');
    expect(res.status).toBe(202);
    expect(res.body.archiveName).toBe('NEWDOOR.LHA');

    const queue = await request(app()).get('/api/door-repo/admin/submissions').set(auth());
    expect(queue.body.rows).toHaveLength(1);
    expect(queue.body.rows[0]).toMatchObject({ archiveName: 'NEWDOOR.LHA', note: 'found this on a floppy', status: 'pending' });
  });

  it('publishes nothing: a pending door is invisible everywhere', async () => {
    await submit(lhaBytes(), 'NEWDOOR.LHA');
    expect((await request(app()).get('/api/door-repo/doors')).body.total).toBe(1);
    expect((await request(app()).get('/api/door-repo/index.tsv')).text).not.toContain('NEWDOOR');
    expect((await request(app()).get('/api/door-repo/archive/NEWDOOR.LHA')).status).toBe(404);
  });

  it('never writes the submitted filename to disk', async () => {
    await submit(lhaBytes(), 'NEWDOOR.LHA');
    const files = quarantineFiles();
    expect(files).toHaveLength(1);
    // Named after the submission id, so two uploads cannot collide and a
    // crafted name cannot decide where bytes go.
    expect(files[0]).toMatch(/^[0-9a-f-]{36}\.bin$/);
  });

  it('refuses a file that is not an archive, whatever it is called', async () => {
    const res = await submit(Buffer.from('#!/bin/sh\nrm -rf /\n'), 'EVIL.LHA');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not an Amiga archive');
  });

  it('refuses an extension that is not an Amiga archive', async () => {
    expect((await submit(lhaBytes(), 'door.exe')).status).toBe(400);
    expect((await submit(lhaBytes(), 'door.php')).status).toBe(400);
  });

  it('refuses a name that tries to leave the directory', async () => {
    expect(safeArchiveName('../../etc/passwd.lha')).toBe('passwd.lha');
    expect(safeArchiveName('/etc/shadow')).toBeNull();
    expect(safeArchiveName('..')).toBeNull();
    expect(safeArchiveName('.hidden.lha')).toBeNull();
  });

  it('refuses an empty file', async () => {
    expect((await submit(Buffer.alloc(0), 'EMPTY.LHA')).status).toBe(400);
  });

  it('refuses one over 8 MB', async () => {
    const big = Buffer.concat([lhaBytes(), Buffer.alloc(9 * 1024 * 1024, 0x41)]);
    // Two acceptable outcomes, and both are refusals. The server answers 413
    // from the declared Content-Length before reading the body, then drains
    // a bounded amount so a slightly-oversized upload can still READ that
    // answer; a wildly oversized one exhausts the drain budget and has its
    // socket closed under it, which surfaces here as EPIPE/ECONNRESET. What
    // must never happen is a 202.
    let status = 0;
    try {
      status = (await submit(big, 'BIG.LHA')).status;
    } catch (error) {
      expect(['EPIPE', 'ECONNRESET']).toContain((error as NodeJS.ErrnoException).code);
      status = 413;
    }
    expect(status).toBe(413);

    const queue = await request(app()).get('/api/door-repo/admin/submissions').set(auth());
    expect(queue.body.rows).toHaveLength(0);
    expect(quarantineFiles()).toHaveLength(0);
  });

  it('answers a slightly-oversized upload with a message the sender can read', async () => {
    // Just over the cap: the drain budget covers it, so the refusal arrives
    // as JSON rather than as a broken connection.
    const overCap = Buffer.concat([lhaBytes(), Buffer.alloc(8 * 1024 * 1024 + 1024, 0x41)]);
    const res = await submit(overCap, 'JUSTBIG.LHA');
    expect(res.status).toBe(413);
    expect(res.body.error).toContain('8 MB');
  });

  it('refuses an archive the repository already has', async () => {
    const first = await submit(lhaBytes('unique-one'), 'FIRST.LHA');
    expect(first.status).toBe(202);
    const again = await submit(lhaBytes('unique-one'), 'DIFFERENT-NAME.LHA');
    expect(again.status).toBe(409);
    expect(again.body.error).toContain('already waiting');
  });

  it('counts what an address has already sent today', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await submit(lhaBytes(`payload-${i}`), `DOOR${i}.LHA`)).status).toBe(202);
    }
    const eleventh = await submit(lhaBytes('payload-11'), 'DOOR11.LHA');
    expect(eleventh.status).toBe(429);
  });

  it('knows an archive by its first bytes', () => {
    expect(sniffArchive(lhaBytes())).toBe('lha');
    expect(sniffArchive(Buffer.from('LZX...', 'latin1'))).toBe('lzx');
    expect(sniffArchive(Buffer.from('DMS!..', 'latin1'))).toBe('dms');
    expect(sniffArchive(Buffer.from('PK\x03\x04', 'latin1'))).toBe('zip');
    expect(sniffArchive(Buffer.from('MZ......', 'latin1'))).toBeNull();
  });
});

describe('the queue', () => {
  async function queueOne(name = 'NEWDOOR.LHA') {
    const res = await submit(lhaBytes(name), name);
    return res.body.id as string;
  }

  it('is admin-only', async () => {
    const id = await queueOne();
    expect((await request(app()).get('/api/door-repo/admin/submissions')).status).toBe(401);
    expect((await request(app()).post(`/api/door-repo/admin/submissions/${id}/approve`)).status).toBe(401);
    expect((await request(app()).post(`/api/door-repo/admin/submissions/${id}/reject`)).status).toBe(401);
  });

  it('approving publishes the door and moves the file out of quarantine', async () => {
    const id = await queueOne();
    const res = await request(app()).post(`/api/door-repo/admin/submissions/${id}/approve`).set(auth());
    expect(res.status).toBe(200);
    _clearIndexTsvCacheForTests();
    _clearListCacheForTests();

    const listed = await request(app()).get('/api/door-repo/doors?q=NEWDOOR');
    expect(listed.body.total).toBe(1);
    expect(listed.body.rows[0].system).toBe('Submitted');

    // The file is where the catalog row says it is, and downloads.
    expect(fs.existsSync(path.join(cfg.archivesRoot, 'Submitted', 'NEWDOOR.LHA'))).toBe(true);
    expect(quarantineFiles()).toHaveLength(0);
    expect((await request(app()).get('/api/door-repo/archive/NEWDOOR.LHA')).status).toBe(200);
  });

  it('refuses to approve over an archive name the repository already uses', async () => {
    const db = openDb(cfg);
    db.prepare(
      `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
       VALUES ('id2', 'NEWDOOR.LHA', 'AmiExpress/NEWDOOR.LHA', 'Existing', 'XIM', 1700000000)`
    ).run();
    db.close();
    const id = await queueOne();
    const res = await request(app()).post(`/api/door-repo/admin/submissions/${id}/approve`).set(auth());
    expect(res.status).toBe(409);
    // Nothing moved: the file is still in quarantine and still pending.
    expect(quarantineFiles()).toHaveLength(1);
  });

  it('rejecting deletes the file and keeps the reason', async () => {
    const id = await queueOne();
    const res = await request(app())
      .post(`/api/door-repo/admin/submissions/${id}/reject`)
      .set(auth())
      .send({ reason: 'not a door' });
    expect(res.status).toBe(200);
    expect(quarantineFiles()).toHaveLength(0);

    const rejected = await request(app()).get('/api/door-repo/admin/submissions?status=rejected').set(auth());
    expect(rejected.body.rows[0]).toMatchObject({ status: 'rejected', rejectReason: 'not a door', decidedBy: 'spot' });
    expect((await request(app()).get('/api/door-repo/doors?q=NEWDOOR')).body.total).toBe(0);
  });

  it('will not decide the same submission twice', async () => {
    const id = await queueOne();
    await request(app()).post(`/api/door-repo/admin/submissions/${id}/reject`).set(auth()).send({});
    const again = await request(app()).post(`/api/door-repo/admin/submissions/${id}/approve`).set(auth());
    expect(again.status).toBe(409);
  });

  it('records both decisions in the audit trail', async () => {
    const approved = await queueOne('KEEPER.LHA');
    const refused = await queueOne('REFUSED.LHA');
    await request(app()).post(`/api/door-repo/admin/submissions/${approved}/approve`).set(auth());
    await request(app()).post(`/api/door-repo/admin/submissions/${refused}/reject`).set(auth()).send({});
    const audit = await request(app()).get('/api/door-repo/admin/audit').set(auth());
    const actions = audit.body.rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['approve', 'reject']));
  });
});
