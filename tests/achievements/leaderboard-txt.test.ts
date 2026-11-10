/**
 * AC-16 - GET /leaderboard.txt: the house format, the same escaper.
 *
 * The expected bytes are built in code as Latin-1 byte arrays and compared
 * with Buffer.compare, never written as UTF-8 source text.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import { defineAchievement, makeAchievementsFixture, TEST_BOARD_ID } from './helpers';
import type { AchievementsFixture } from './helpers';

let fx: AchievementsFixture;
let db: Database.Database;

beforeEach(() => {
  fx = makeAchievementsFixture();
  db = fx.openAchievements();
  defineAchievement(db, { id: 'msg.post.1', rule: { op: 'count', type: 'msg.post', n: 1 }, points: 5 });
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

const raw = (path: string, headers: Record<string, string> = {}): request.Test =>
  request(fx.app)
    .get(`/achievements/v1${path}`)
    .set('Authorization', fx.auth)
    .set(headers)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

let nextId = 100;
function player(handle: string, at: number): void {
  const id = nextId++;
  db.prepare(`INSERT INTO players (id, email_key, email, handle, verified_at, private, created_at) VALUES (?, ?, ?, ?, 1, 0, 1)`).run(id, `${id}@example.com`, `${id}@example.com`, handle);
  db.prepare('INSERT INTO links (board_id, player_id, linked_at) VALUES (?, ?, 1)').run(TEST_BOARD_ID, id);
  db.prepare('INSERT INTO unlocks (player_id, achievement_id, board_id, season_id, at) VALUES (?, ?, ?, ?, ?)').run(id, 'msg.post.1', TEST_BOARD_ID, '2026Q3', at);
}

describe('leaderboard.txt', () => {
  it('is ISO-8859-1 with CRLF and a header naming the row count', async () => {
    player('Spot', 1000);
    player('Phantasm', 2000);

    const res = await raw('/leaderboard.txt?scope=global');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=ISO-8859-1');
    const expected = Buffer.from('ACHIEVE|1|l2-t2000|2\r\n1|Spot|5|1\r\n2|Phantasm|5|1\r\n', 'latin1');
    expect(Buffer.compare(res.body as Buffer, expected)).toBe(0);
  });

  it('a handle containing a pipe is escaped, and the row count still matches the line count', async () => {
    player('Pi|pe\nLine', 1000);
    player('Café \u{1F600}', 2000);

    const res = await raw('/leaderboard.txt?scope=global');

    const bytes = res.body as Buffer;
    const expected = Buffer.concat([
      Buffer.from('ACHIEVE|1|l2-t2000|2\r\n1|Pi!pe Line|5|1\r\n2|Caf', 'latin1'),
      Buffer.from([0xe9]),
      Buffer.from(' ?|5|1\r\n', 'latin1'),
    ]);
    expect(Buffer.compare(bytes, expected)).toBe(0);
    const lines = bytes.toString('latin1').split('\r\n');
    expect(lines.length - 2).toBe(Number(lines[0].split('|')[3]));
  });

  it('the same query twice returns byte-identical output', async () => {
    player('Beta', 400);
    player('Alpha', 400);
    player('Gamma', 500);

    const one = await raw('/leaderboard.txt?scope=global&limit=10');
    const two = await raw('/leaderboard.txt?scope=global&limit=10');

    expect(Buffer.compare(one.body as Buffer, two.body as Buffer)).toBe(0);
    expect((one.body as Buffer).toString('latin1')).toBe('ACHIEVE|1|l3-t500|3\r\n1|Alpha|5|1\r\n2|Beta|5|1\r\n3|Gamma|5|1\r\n');
  });

  it('a scope naming an unknown board answers an empty listing with a valid header, not a 404', async () => {
    const res = await raw('/leaderboard.txt?scope=board:nowhere');
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, Buffer.from('ACHIEVE|1|l0-t0|0\r\n', 'latin1'))).toBe(0);
  });

  it('an If-None-Match matching the leaderboard revision answers 304', async () => {
    player('Spot', 1000);
    const first = await raw('/leaderboard.txt?scope=global');
    expect(first.headers.etag).toBe('"l1-t1000"');

    const again = await raw('/leaderboard.txt?scope=global', { 'If-None-Match': '"l1-t1000"' });
    expect(again.status).toBe(304);
    expect((again.body as Buffer).length).toBe(0);

    // A new unlock is a new revision.
    player('Late', 3000);
    expect((await raw('/leaderboard.txt?scope=global', { 'If-None-Match': '"l1-t1000"' })).status).toBe(200);
  });
});
