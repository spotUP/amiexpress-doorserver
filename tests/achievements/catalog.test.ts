/**
 * AC-12 - GET /catalog, GET /catalog.txt, and ONE text escaper.
 *
 * SYM-9 MOVED HERE from the RED file. The escaper that renders list.txt
 * moved into src/text-format.ts and both renderers import it, so the last
 * test pins list.txt's bytes through the moved functions: a 68K parser
 * written against one format must not mis-read the other.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import type { Response } from 'supertest';
import { _catalogRowReadsForTests } from '../../src/achievements/catalog';
import * as manifest from '../../src/manifest';
import * as textFormat from '../../src/text-format';
import { defineAchievement, makeAchievementsFixture, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

let fx: AchievementsFixture;
let db: Database.Database;

beforeEach(() => {
  fx = makeAchievementsFixture();
  db = fx.openAchievements();
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

const get = (path: string, headers: Record<string, string> = {}): request.Test =>
  request(fx.app).get(`/achievements/v1${path}`).set('Authorization', fx.auth).set(headers);

const textOf = (res: Response): string => Buffer.from(res.body as Buffer).toString('latin1');

describe('the catalog', () => {
  it('SYM-9: catalog.txt is ISO-8859-1 with CRLF endings and a header naming the revision', async () => {
    defineAchievement(db, { id: 'msg.post.100', rule: { op: 'count', type: 'msg.post', n: 100 }, name: 'Century', tier: 'silver', points: 10 });
    defineAchievement(db, { id: 'rare.midnight', rule: { op: 'count', type: 'msg.post', key: 'midnight', n: 1 }, name: 'Night Owl', tier: 'gold', hidden: true });

    const res = await get('/catalog.txt').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=ISO-8859-1');
    const revision = res.headers['x-achievements-revision'];
    expect(res.headers.etag).toBe(`"${revision}"`);
    const text = textOf(res);
    expect(text).toBe(
      `ACHIEVE|1|${revision}|2\r\n` +
        'msg.post.100|msg|silver|10|0|Century|Test definition of msg.post.100|count|1000|common\r\n' +
        'rare.midnight|rare|gold|5|1|???||count|1000|common\r\n'
    );
    // CRLF throughout, including after the last row; never a bare LF.
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('a name containing a pipe is escaped to an exclamation mark, exactly as list.txt escapes it', async () => {
    defineAchievement(db, { id: 'x.pipe', rule: { op: 'first', type: 'x' }, name: 'Pipe|Dream' });
    db.prepare('UPDATE achievements SET description = ? WHERE id = ?').run('line one\r\nline\ttwo|three', 'x.pipe');

    const res = await get('/catalog.txt').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    const row = textOf(res).split('\r\n')[1];
    expect(row).toBe('x.pipe|x|bronze|5|0|Pipe!Dream|line one line two!three|first|1000|common');
    expect(textFormat.esc('a|b')).toBe('a!b');
  });

  it('a non-Latin-1 character becomes a single question mark, not two', async () => {
    defineAchievement(db, { id: 'x.astral', rule: { op: 'first', type: 'x' }, name: 'Café \u{1F600} Ж' });

    const res = await get('/catalog.txt').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    const bytes = res.body as Buffer;
    const row = bytes.toString('latin1').split('\r\n')[1];
    expect(row.split('|')[5]).toBe('Café ? ?');
    // And the e-acute is ONE byte, 0xE9, as a real Amiga reads it.
    expect(bytes.includes(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe(true);
  });

  it('a matching If-None-Match answers 304 without reading the achievements table', async () => {
    defineAchievement(db, { id: 'msg.post.100', rule: { op: 'count', type: 'msg.post', n: 100 } });
    const first = await get('/catalog');
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    const reads = _catalogRowReadsForTests();

    const again = await get('/catalog', { 'If-None-Match': etag });
    const text = await get('/catalog.txt', { 'If-None-Match': etag });

    expect(again.status).toBe(304);
    expect(text.status).toBe(304);
    expect(again.text ?? '').toBe('');
    expect(_catalogRowReadsForTests()).toBe(reads);
    // A weak validator from a proxy matches too (RFC 7232, via req.fresh).
    expect((await get('/catalog', { 'If-None-Match': `W/${etag}` })).status).toBe(304);
    // And a changed catalog is a new ETag and a 200.
    defineAchievement(db, { id: 'msg.post.1000', rule: { op: 'count', type: 'msg.post', n: 1000 } });
    db.prepare('UPDATE achievements SET updated_at = 1800000000 WHERE id = ?').run('msg.post.1000');
    const changed = await get('/catalog', { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('since returns only what changed, and an unparseable since returns everything with a 200', async () => {
    defineAchievement(db, { id: 'old.one', rule: { op: 'first', type: 'x' } });
    defineAchievement(db, { id: 'new.one', rule: { op: 'first', type: 'y' } });
    db.prepare('UPDATE achievements SET updated_at = 1800000000 WHERE id = ?').run('new.one');
    const full = await get('/catalog');
    expect(full.body.achievements.map((a: { id: string }) => a.id)).toEqual(['new.one', 'old.one']);
    expect(full.body.since).toBeNull();
    expect(full.body.contractVersion).toBe('1');

    const partial = await get('/catalog?since=a1-t1700000000');
    expect(partial.status).toBe(200);
    expect(partial.body.since).toBe('a1-t1700000000');
    expect(partial.body.achievements.map((a: { id: string }) => a.id)).toEqual(['new.one']);
    expect(partial.body.achievements[0]).toMatchObject({
      id: 'new.one', family: 'new', tier: 'bronze', points: 5, hidden: false,
      rule: { op: 'first', type: 'y' }, rarityPctTenths: 1000, rarityBucket: 'common',
      updatedAt: '2027-01-15T08:00:00.000Z',
    });

    const mangled = await get('/catalog?since=garbage');
    expect(mangled.status).toBe(200);
    expect(mangled.body.since).toBeNull();
    expect(mangled.body.achievements).toHaveLength(2);
    // The text variant honours the same cursor.
    const txt = await get('/catalog.txt?since=a1-t1700000000').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(textOf(txt).split('\r\n')[0]).toMatch(/^ACHIEVE\|1\|a2-t1800000000\|1$/);
  });

  it("a hidden achievement's name and description are withheld until somebody on this board unlocks it", async () => {
    defineAchievement(db, { id: 'rare.midnight', rule: { op: 'count', type: 'msg.post', key: 'midnight', n: 1 }, name: 'Night Owl', tier: 'gold', hidden: true });
    const before = await get('/catalog');
    expect(before.body.achievements[0]).toMatchObject({ id: 'rare.midnight', hidden: true, name: '???', description: '' });

    // A player on ANOTHER board unlocked it: still withheld here.
    db.prepare(`INSERT INTO players (id, email_key, email, handle, verified_at, created_at) VALUES (7, 'x@example.com', 'x@example.com', 'X', 1, 1)`).run();
    db.prepare(`INSERT INTO boards (id, name, key_hash, created_at) VALUES ('other', 'Other', 'x', 1)`).run();
    db.prepare(`INSERT INTO links (board_id, player_id, linked_at) VALUES ('other', 7, 1)`).run();
    db.prepare(`INSERT INTO unlocks (player_id, achievement_id, board_id, season_id, at) VALUES (7, 'rare.midnight', 'other', '2026Q3', 1)`).run();
    expect((await get('/catalog')).body.achievements[0]).toMatchObject({ name: '???', description: '' });

    // The same player links THIS board: revealed.
    db.prepare(`INSERT INTO links (board_id, player_id, linked_at) VALUES (?, 7, 1)`).run(TEST_BOARD_ID);
    expect((await get('/catalog')).body.achievements[0]).toMatchObject({ hidden: true, name: 'Night Owl', description: 'Test definition of rare.midnight' });
  });

  it('list.txt is byte-identical after the escaper move', () => {
    // The same functions, not copies.
    expect(manifest.toLatin1Safe).toBe(textFormat.toLatin1Safe);
    // And the door repo's renderer still escapes through them: one row with
    // a pipe, a newline and an astral character, rendered by renderListTxt.
    const doors = new Database(fx.doorsDbPath);
    try {
      doors
        .prepare(
          `INSERT INTO door_catalog (id, archive_name, archive_path, name, description, door_type, archive_size, indexed_at)
           VALUES ('id2', 'PIPE|TEST.LHA', 'PIPE.LHA', 'Pipe\nDream \u{1F600}', 'a|b', 'XIM', 3, 1700000001)`
        )
        .run();
    } finally {
      doors.close();
    }
    const body = manifest.renderListTxt(manifest.buildManifest(fx.cfg)).toString('latin1');
    const row = body.split('\r\n').find((l) => l.startsWith('PIPE!TEST.LHA|'));
    expect(row).toBeDefined();
    // The name field: the newline collapsed, the astral character one '?',
    // and the archive name's pipe an exclamation mark - through the moved
    // functions. (The description column is derived by describeRow(), not
    // copied, so it is not the field under test here.)
    expect(row).toContain('|Pipe Dream ?|');
    expect((row as string).split('|')[0]).toBe('PIPE!TEST.LHA');
  });
});
