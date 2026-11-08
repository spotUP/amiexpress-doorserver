/**
 * Self-service board registration (A2). Unit tests for the pure slug and
 * validation functions, plus ONE reachability test: register over HTTP, use
 * the returned key on POST /chat/v1/sessions, see board_joined with the name.
 */
import request from 'supertest';
import { makeAchievementsFixture } from './helpers';
import type { AchievementsFixture } from './helpers';
import { deriveBoardSlug, slugCandidates, validateRegistration } from '../../src/achievements/boards';
import { _stopChatSweepersForTests } from '../../src/chat/sessions';

describe('deriveBoardSlug', () => {
  it('lowercases, collapses and trims', () => {
    expect(deriveBoardSlug('  The Up-Rough  BBS!! ')).toBe('the-up-rough-bbs');
  });
  it('caps at 32 characters without a trailing dash', () => {
    const s = deriveBoardSlug('a'.repeat(31) + ' bbb');
    expect(s.length).toBeLessThanOrEqual(32);
    expect(s.endsWith('-')).toBe(false);
  });
  it('falls back to "board" under 2 characters', () => {
    expect(deriveBoardSlug('!!')).toBe('board');
    expect(deriveBoardSlug('x')).toBe('board');
  });
});

describe('slugCandidates', () => {
  it('suffixes -2..-99 and stays within 32 characters', () => {
    const c = slugCandidates('a'.repeat(40));
    expect(c).toHaveLength(99);
    expect(c[1].endsWith('-2')).toBe(true);
    expect(c[98].endsWith('-99')).toBe(true);
    for (const id of c) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{1,31}$/);
  });
});

describe('validateRegistration', () => {
  it('builds the contact column', () => {
    expect(validateRegistration({ name: 'My BBS', sysop: 'Bob' }).contact).toBe('Bob');
    expect(validateRegistration({ name: 'My BBS', sysop: 'Bob', contact: 'b@x.org' }).contact).toBe('Bob b@x.org');
  });
  it.each([
    [{ name: '', sysop: 'a' }],
    [{ name: 'a', sysop: '' }],
    [{ name: 'a'.repeat(41), sysop: 'a' }],
    [{ name: 'a', sysop: 'a', contact: 'c'.repeat(81) }],
    [{ name: 'bad\x1bname', sysop: 'a' }],
    [{ name: 'a', sysop: 'line\nbreak' }],
    [{ name: 'café', sysop: 'a' }],
    [{ name: 5, sysop: 'a' }],
    [null],
  ])('rejects %j', (body) => {
    expect(() => validateRegistration(body)).toThrow(expect.objectContaining({ code: 'bad_request', status: 400 }));
  });
});

describe('POST /achievements/v1/boards/register', () => {
  let fx: AchievementsFixture;
  beforeEach(() => { fx = makeAchievementsFixture(); });
  afterEach(() => { _stopChatSweepersForTests(); fx.cleanup(); });

  it('registers with no auth; the key opens a chat session that announces the board', async () => {
    const reg = await request(fx.app).post('/achievements/v1/boards/register').send({ name: 'Fresh Board', sysop: 'Ann' });
    expect(reg.status).toBe(201);
    expect(reg.body.id).toBe('fresh-board');
    const auth = `Board ${reg.body.key}`;

    const s = await request(fx.app).post('/chat/v1/sessions').set('Authorization', auth).send({ handle: 'ann' });
    expect(s.status).toBe(201);
    const ev = await request(fx.app).get('/chat/v1/events.txt?since=0&wait=0').set('Authorization', auth).set('X-Chat-Session', s.body.sid);
    const rows = ev.text.split('\r\n').filter((l) => l !== '').slice(1).map((l) => l.split('|'));
    expect(rows.filter((c) => c[1] === 'board_joined' && c[7] === 'Fresh Board')).toHaveLength(1);
  });

  it('answers OK <id>.<secret> as text/plain, suffixes a colliding name, rejects bad input', async () => {
    const a = await request(fx.app).post('/achievements/v1/boards/register').set('Accept', 'text/plain').send({ name: 'Dup', sysop: 'A' });
    expect(a.status).toBe(201);
    expect(a.headers['content-type']).toMatch(/^text\/plain/);
    expect(a.text).toMatch(/^OK dup\.[A-Za-z0-9_-]+\n$/);
    const b = await request(fx.app).post('/achievements/v1/boards/register').send({ name: 'Dup', sysop: 'B' });
    expect(b.body.id).toBe('dup-2');
    const bad = await request(fx.app).post('/achievements/v1/boards/register').send({ name: 'x\x07y', sysop: 'B' });
    expect(bad.status).toBe(400);
  });
});
