/**
 * Admin authentication.
 *
 * The door server is on a public host, so these tests care about the ways in
 * which a stranger must NOT get in: no secret configured, no token, a token
 * this server did not sign, an expired one, one that asks for "none", and an
 * account that has since been deleted.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { openDb, applySchema } from '../src/db';
import { runMigrations } from '../src/migrations';
import { createApp } from '../src/app';
import { bootstrapAdmins, hashPassword, signToken, verifyPassword, verifyToken } from '../src/auth';
import { _clearLoginFailuresForTests } from '../src/admin-routes';
import type { ServerConfig } from '../src/config';

const SECRET = 'a-test-secret-that-is-long-enough-to-pass';
let dir: string;
let cfg: ServerConfig;

beforeEach(() => {
  _clearLoginFailuresForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-auth-'));
  const dbPath = path.join(dir, 'doors.db');
  fs.writeFileSync(dbPath, '');
  cfg = {
    dbPath,
    archivesRoot: dir,
    port: 3010,
    adminKeys: [{ label: 'spot', key: 'correct horse battery staple' }],
    jwtSecret: SECRET,
  };
  const db = openDb(cfg);
  applySchema(db);
  runMigrations(db);
  db.prepare(
    `INSERT INTO door_catalog (id, archive_name, archive_path, name, door_type, indexed_at)
     VALUES ('id1', 'ACC-V103.LHA', 'AmiExpress/ACC-V103.LHA', 'Account Editor', 'XIM', 1700000000)`
  ).run();
  bootstrapAdmins(db, cfg);
  db.close();
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function login(username: string, password: string) {
  return request(createApp(cfg)).post('/api/door-repo/admin/login').send({ username, password });
}

describe('password hashing', () => {
  it('accepts the right password and rejects the wrong one', () => {
    const stored = hashPassword('hunter2');
    expect(verifyPassword('hunter2', stored)).toBe(true);
    expect(verifyPassword('hunter3', stored)).toBe(false);
  });

  it('never stores the password, and salts every hash differently', () => {
    const a = hashPassword('hunter2');
    const b = hashPassword('hunter2');
    expect(a).not.toContain('hunter2');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
  });

  it('reads its cost parameters back out of the stored hash', () => {
    // A hash written with a lower cost must still verify after the default
    // is raised, or raising it locks everyone out.
    const cheap = hashPassword('hunter2').replace(/^scrypt\$\d+/, 'scrypt$16384');
    expect(verifyPassword('hunter2', cheap)).toBe(false); // different params, different key
    expect(verifyPassword('hunter2', hashPassword('hunter2'))).toBe(true);
  });

  it('rejects a stored value that is not a scrypt hash', () => {
    expect(verifyPassword('hunter2', 'hunter2')).toBe(false);
    expect(verifyPassword('hunter2', '')).toBe(false);
    expect(verifyPassword('hunter2', 'scrypt$only$four$parts')).toBe(false);
  });
});

describe('bootstrap accounts', () => {
  it('creates one account per DOORSERVER_ADMIN_KEYS entry', async () => {
    const res = await login('spot', 'correct horse battery staple');
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: expect.any(Number), username: 'spot', role: 'owner' });
    expect(typeof res.body.token).toBe('string');
  });

  it('never touches an account that already exists', () => {
    const db = openDb(cfg);
    db.prepare('UPDATE admin_users SET password_hash = ? WHERE username = ?').run(hashPassword('changed'), 'spot');
    expect(bootstrapAdmins(db, cfg)).toEqual([]);
    const row = db.prepare('SELECT password_hash FROM admin_users WHERE username = ?').get('spot') as {
      password_hash: string;
    };
    db.close();
    // The env key must NOT win back: rotating it would otherwise silently
    // undo a password someone set through the UI.
    expect(verifyPassword('changed', row.password_hash)).toBe(true);
  });
});

describe('login', () => {
  it('refuses the wrong password, and says nothing about which part was wrong', async () => {
    const wrongPassword = await login('spot', 'nope');
    const noSuchUser = await login('nobody', 'nope');
    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.body).toEqual(noSuchUser.body);
  });

  it('locks an account out after five failures', async () => {
    for (let i = 0; i < 5; i++) expect((await login('spot', 'nope')).status).toBe(401);
    const locked = await login('spot', 'nope');
    expect(locked.status).toBe(429);
    // Even the RIGHT password is refused while the lockout stands.
    expect((await login('spot', 'correct horse battery staple')).status).toBe(429);
  });

  it('a successful login clears the failure count', async () => {
    for (let i = 0; i < 4; i++) await login('spot', 'nope');
    expect((await login('spot', 'correct horse battery staple')).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await login('spot', 'nope')).status).toBe(401);
  });

  it('records the login in the audit trail', async () => {
    await login('spot', 'correct horse battery staple');
    const db = openDb(cfg);
    const rows = db.prepare("SELECT action, target FROM admin_audit WHERE action = 'login'").all();
    db.close();
    expect(rows).toEqual([{ action: 'login', target: 'spot' }]);
  });
});

describe('requireAdmin', () => {
  async function me(headers: Record<string, string>, config = cfg) {
    return request(createApp(config)).get('/api/door-repo/admin/me').set(headers);
  }

  it('lets a freshly issued token through', async () => {
    const res = await login('spot', 'correct horse battery staple');
    const authed = await me({ Authorization: `Bearer ${res.body.token}` });
    expect(authed.status).toBe(200);
    expect(authed.body.user.username).toBe('spot');
  });

  it('refuses a request with no token at all', async () => {
    expect((await me({})).status).toBe(401);
  });

  it('refuses a token signed with a different secret', async () => {
    const forged = signToken({ id: 1, username: 'spot', role: 'owner' }, 'a-different-secret-of-sufficient-size');
    expect((await me({ Authorization: `Bearer ${forged}` })).status).toBe(401);
  });

  it('refuses an unsigned "none" token', async () => {
    const none = jwt.sign({ id: 1, username: 'spot', role: 'owner' }, '', { algorithm: 'none' });
    expect((await me({ Authorization: `Bearer ${none}` })).status).toBe(401);
    expect(verifyToken(none, SECRET)).toBeNull();
  });

  it('refuses an expired token', async () => {
    const expired = jwt.sign({ id: 1, username: 'spot', role: 'owner' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: -60,
    });
    expect((await me({ Authorization: `Bearer ${expired}` })).status).toBe(401);
  });

  it('refuses a token whose account has been deleted, and keeps that account\'s audit trail', async () => {
    const res = await login('spot', 'correct horse battery staple');
    const db = openDb(cfg);
    db.prepare('DELETE FROM admin_users').run();
    const audit = db.prepare("SELECT admin_id, action, target FROM admin_audit WHERE action = 'login'").all();
    db.close();
    expect((await me({ Authorization: `Bearer ${res.body.token}` })).status).toBe(401);
    // The trail outlives the account: the row stays, its author becomes null.
    expect(audit).toEqual([{ admin_id: null, action: 'login', target: 'spot' }]);
  });

  it('refuses a malformed Authorization header', async () => {
    const res = await login('spot', 'correct horse battery staple');
    expect((await me({ Authorization: res.body.token })).status).toBe(401);
    expect((await me({ Authorization: `Basic ${res.body.token}` })).status).toBe(401);
  });
});

describe('a server with no signing secret', () => {
  it('has no admin surface at all, and still serves the public API', async () => {
    const noSecret = { ...cfg, jwtSecret: null };
    const app = createApp(noSecret);
    expect((await request(app).post('/api/door-repo/admin/login').send({ username: 'spot', password: 'x' })).status).toBe(503);
    expect((await request(app).get('/api/door-repo/admin/me')).status).toBe(503);
    expect((await request(app).get('/api/door-repo/health')).status).toBe(200);
  });
});
