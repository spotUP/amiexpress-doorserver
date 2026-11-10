/**
 * The story every example in docs/ACHIEVEMENTS-API.md is captured from.
 *
 * The document promised (and its own status paragraph admitted) that its
 * examples were written from the contract rather than captured from a
 * running server - the opposite of docs/DOOR-REPO-API.md's rule. This
 * module is what makes them real: one ordered walk through the whole
 * surface, driven through `createApp` by supertest, so every JSON block in
 * that document is bytes a caller actually received.
 *
 * It lives under tests/ rather than scripts/ because BOTH the capture
 * script and the drift suite run it: the script writes the document, the
 * suite re-runs the same walk and fails if the document no longer matches
 * what the server says. A capture nobody re-runs goes stale exactly once,
 * silently, in the direction of the reader.
 *
 * Randomness is unavoidable here - codes, refs and timestamps differ every
 * run - so the suite compares NORMALIZED bodies (see `normalize`), which
 * keeps every key, every type and every constant while masking the values
 * that cannot repeat.
 */
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { AchievementsFixture } from './helpers';

export interface CapturedExample {
  /** The anchor `<!-- capture: id -->` this replaces in the document. */
  id: string;
  method: string;
  /** Path below /achievements/v1, or an absolute path when it is elsewhere. */
  path: string;
  requestBody?: unknown;
  status: number;
  contentType: string;
  /** Parsed JSON, or the raw text for the two .txt endpoints. */
  body: unknown;
  /**
   * The response headers a 68K door reads, for the two plain-text
   * endpoints: the contract version and the revision are what its `since`
   * and its cache are built on, so an example that showed the rows without
   * them would be missing half the answer.
   */
  responseHeaders?: Record<string, string>;
  /**
   * Print the rows alone, with no request line and no headers: section 7
   * documents the ROW SHAPE, and the exchange around it belongs to the
   * endpoint sections that already show one.
   */
  rowsOnly?: boolean;
  /** Overrides the generated elision note, when "the first N" is not true. */
  note?: string;
  /**
   * What a listing was cut down to for the document, and what it really
   * held: `{ progress: [2, 14] }` means two of fourteen entries are shown.
   * A reference that pasted sixty-seven catalog rows would be unreadable,
   * and one that silently showed two of fourteen would be a lie - so the
   * cut is recorded here and printed under the fence.
   */
  elided?: Record<string, [number, number]>;
}

/** Keep the first `n` entries of each named array, recording what was cut. */
function trim(ex: CapturedExample, keep: Record<string, number>): CapturedExample {
  const body = ex.body as Record<string, unknown>;
  const elided: Record<string, [number, number]> = {};
  const out: Record<string, unknown> = { ...body };
  for (const [field, n] of Object.entries(keep)) {
    const list = body[field];
    if (!Array.isArray(list) || list.length <= n) continue;
    out[field] = list.slice(0, n);
    elided[field] = [n, list.length];
  }
  return Object.keys(elided).length === 0 ? ex : { ...ex, body: out, elided };
}

/** The same, by line, for the two plain-text endpoints. */
function trimText(ex: CapturedExample, keepRows: number): CapturedExample {
  const lines = (ex.body as string).split('\r\n').filter((l) => l.length > 0);
  if (lines.length - 1 <= keepRows) return ex;
  const kept = [lines[0], ...lines.slice(1, 1 + keepRows)];
  return {
    ...ex,
    body: `${kept.join('\r\n')}\r\n`,
    elided: { rows: [keepRows, lines.length - 1] },
  };
}

const CODE_ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

function assert(ok: unknown, what: string): void {
  if (!ok) throw new Error(`doc story: ${what}`);
}

/** The code a caller reads off the mail the server queued. */
function codeFromMail(db: Database.Database, email: string): string {
  const rows = db
    .prepare('SELECT body FROM mail_queue WHERE to_addr = ? ORDER BY id')
    .all(email) as { body: string }[];
  assert(rows.length > 0, `no mail queued for ${email}`);
  const lines = rows[rows.length - 1].body.split('\n').filter((l) => CODE_ALPHABET.test(l.trim()));
  assert(lines.length === 1, `mail for ${email} carries ${lines.length} code lines`);
  return lines[0].trim();
}

export async function runDocStory(fx: AchievementsFixture): Promise<CapturedExample[]> {
  const captured: CapturedExample[] = [];
  const db = fx.openAchievements();

  const send = async (
    id: string | null,
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: unknown,
    opts: { auth?: boolean; absolute?: boolean } = {}
  ) => {
    const url = opts.absolute ? path : `/achievements/v1${path}`;
    let req = request(fx.app)[method](url);
    if (opts.auth !== false) req = req.set('Authorization', fx.auth);
    if (body !== undefined) req = req.send(body as object);
    const res = await req;
    const contentType = String(res.headers['content-type'] ?? '');
    if (id !== null) {
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'x-achievements-contract', 'x-achievements-revision', 'etag']) {
        const v = res.headers[name];
        if (typeof v === 'string') headers[name] = v;
      }
      captured.push({
        id,
        method: method.toUpperCase(),
        path: url,
        ...(body === undefined ? {} : { requestBody: body }),
        status: res.status,
        contentType,
        responseHeaders: headers,
        body: contentType.includes('json') ? res.body : res.text,
      });
    }
    return res;
  };

  try {
    // ---- a player registers, verifies, and links this board ----------
    const email = 'caller@example.com';
    const register = { email, handle: 'Spot' };
    let res = await send('players.register.request', 'post', '/players', register);
    assert(res.status === 202, `register answered ${res.status}`);
    captured.push({
      id: 'players.register.response',
      method: 'POST',
      path: '/achievements/v1/players',
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body: res.body,
    });

    const code = codeFromMail(db, email);
    const verify = { email, code };
    res = await send('players.verify.request', 'post', '/players/verify', verify);
    assert(res.status === 200, `verify answered ${res.status}: ${res.text}`);
    captured.push({
      id: 'players.verify.response',
      method: 'POST',
      path: '/achievements/v1/players/verify',
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body: res.body,
    });
    const firstLinkCode = String((res.body as { linkCode: string }).linkCode);

    await send('players.resend.request', 'post', '/players/resend', { email });

    const link = { email, code: firstLinkCode };
    res = await send('links.link.request', 'post', '/links', link);
    assert(res.status === 200, `link answered ${res.status}: ${res.text}`);
    captured.push({
      id: 'links.link.response',
      method: 'POST',
      path: '/achievements/v1/links',
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body: res.body,
    });
    const nextLinkCode = String((res.body as { linkCode: string }).linkCode);

    res = await send('links.rotate.request', 'post', '/links/rotate', { email, code: nextLinkCode });
    assert(res.status === 200, `rotate answered ${res.status}: ${res.text}`);
    captured.push({
      id: 'links.rotate.response',
      method: 'POST',
      path: '/achievements/v1/links/rotate',
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body: res.body,
    });

    // ---- a second player, so a leaderboard has more than one row -----
    const other = 'phantasm@example.com';
    res = await send(null, 'post', '/players', { email: other, handle: 'Phantasm' });
    assert(res.status === 202, `second register answered ${res.status}`);
    res = await send(null, 'post', '/players/verify', { email: other, code: codeFromMail(db, other) });
    assert(res.status === 200, `second verify answered ${res.status}: ${res.text}`);
    res = await send(null, 'post', '/links', { email: other, code: String((res.body as { linkCode: string }).linkCode) });
    assert(res.status === 200, `second link answered ${res.status}: ${res.text}`);

    // A third player: verified, and deliberately NEVER linked to this
    // board, so the mixed batch below can show the `not_linked` verdict
    // and the `notLinked` list the document describes. A player who does
    // not exist at all answers `unknown_player` instead, which is a
    // different row and a different fix for the sender.
    const stranger = 'stranger@example.com';
    res = await send(null, 'post', '/players', { email: stranger, handle: 'Stranger' });
    assert(res.status === 202, `third register answered ${res.status}`);
    res = await send(null, 'post', '/players/verify', { email: stranger, code: codeFromMail(db, stranger) });
    assert(res.status === 200, `third verify answered ${res.status}: ${res.text}`);

    // The catalog revision BEFORE the door publishes, so the incremental
    // example below returns exactly what changed since a real cursor.
    const beforeDoor = await send(null, 'get', '/catalog');
    assert(beforeDoor.status === 200, `catalog answered ${beforeDoor.status}`);
    const sinceRevision = String((beforeDoor.body as { revision: string }).revision);

    // ---- a door registers its own definitions ------------------------
    const doorCatalog = {
      digest: 'sha256:2f1c8a3e5d7b9042c6e1f8a4b2d0c9e7f5a3b1d8c6e4f2a0b9d7c5e3f1a8b6d4',
      achievements: [
        {
          id: 'door.grandmaster.first_win',
          name: 'First Blood',
          description: 'Win a game of chess',
          family: 'door',
          tier: 'bronze',
          points: 5,
          hidden: false,
          rule: { op: 'count', type: 'door.grandmaster.win', n: 1 },
        },
      ],
    };
    res = await send('catalog.door.request', 'put', '/catalog/doors/grandmaster', doorCatalog);
    assert(res.status === 200, `door catalog answered ${res.status}: ${res.text}`);
    captured.push({
      id: 'catalog.door.response',
      method: 'PUT',
      path: '/achievements/v1/catalog/doors/grandmaster',
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body: res.body,
    });

    // ---- events: one clean batch, then a mixed one -------------------
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const clean = {
      events: [
        {
          ref: `${fx.boardId}:01J8Z4M0000000000000000001`,
          email,
          type: 'msg.post',
          at,
          value: 1,
          key: 'conf:2',
          door: null,
          client: 'amiga',
        },
      ],
    };
    res = await send('events.clean.request', 'post', '/events', clean);
    assert(res.status === 200, `events answered ${res.status}: ${res.text}`);
    captured.push({
      id: 'events.clean.response',
      method: 'POST',
      path: '/achievements/v1/events',
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body: res.body,
    });

    // Points for the leaderboard, and a door unlock for the door catalog.
    await send(null, 'post', '/events', {
      events: [
        ...Array.from({ length: 6 }, (_, i) => ({
          ref: `${fx.boardId}:01J8Z4M000000000000000010${i}`,
          email,
          type: 'msg.post',
          at,
          value: 1,
        })),
        { ref: `${fx.boardId}:01J8Z4M0000000000000000201`, email, type: 'door.grandmaster.win', at, value: 1 },
        { ref: `${fx.boardId}:01J8Z4M0000000000000000301`, email: other, type: 'msg.post', at, value: 1 },
      ],
    });

    // The mixed batch the document shows: a duplicate, an unlinked player
    // and an unknown type, none of which take the batch down.
    const mixed = {
      events: [
        { ref: `${fx.boardId}:01J8Z4M0000000000000000401`, email, type: 'msg.post', at, value: 1 },
        { ref: `${fx.boardId}:01J8Z4M0000000000000000001`, email, type: 'msg.post', at, value: 1 },
        { ref: `${fx.boardId}:01J8Z4M0000000000000000402`, email: 'stranger@example.com', type: 'msg.post', at, value: 1 },
        { ref: `${fx.boardId}:01J8Z4M0000000000000000403`, email, type: 'no.such.type', at, value: 1 },
      ],
    };
    res = await send('events.mixed.request', 'post', '/events', mixed);
    assert(res.status === 200, `mixed events answered ${res.status}: ${res.text}`);
    captured.push({
      id: 'events.mixed.response',
      method: 'POST',
      path: '/achievements/v1/events',
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body: res.body,
    });

    // ---- the catalog, JSON and text ----------------------------------
    // Incremental, from the cursor taken before the door published: the
    // answer is that one door achievement, which is both the example the
    // document wants and the reason `since` exists.
    await send('catalog.since.response', 'get', `/catalog?since=${encodeURIComponent(sinceRevision)}`);
    const catalogTxt = await send('catalog.txt.response', 'get', '/catalog.txt');
    // Section 7 documents the row shape, and the one row worth showing
    // twice is a HIDDEN achievement: `???`, an empty description, and the
    // `1` in the hidden column a C89 client tests without parsing. Both
    // rows below are real rows of the response captured just above.
    {
      const lines = String(catalogTxt.text).split('\r\n').filter((l) => l.length > 0);
      const header = lines[0];
      const rows = lines.slice(1);
      const plain = rows.find((r) => r.split('|')[4] === '0');
      const hidden = rows.find((r) => r.split('|')[4] === '1');
      assert(plain !== undefined && hidden !== undefined, 'catalog.txt has no hidden row to show');
      captured.push({
        id: 'format.catalog.rows',
        method: 'GET',
        path: '/achievements/v1/catalog.txt',
        status: catalogTxt.status,
        contentType: String(catalogTxt.headers['content-type'] ?? ''),
        rowsOnly: true,
        body: `${header}\r\n${plain as string}\r\n${hidden as string}\r\n`,
        note: `two real rows of the ${rows.length} this response carried: one plain, one hidden.`,
      });
    }

    // ---- the leaderboard, JSON and text ------------------------------
    await send('leaderboard.global.response', 'get', '/leaderboard?scope=global&period=all&limit=50');
    const boardTxt = await send('leaderboard.txt.response', 'get', `/leaderboard.txt?scope=board:${fx.boardId}&period=all`);
    captured.push({
      id: 'format.leaderboard.rows',
      method: 'GET',
      path: `/achievements/v1/leaderboard.txt?scope=board:${fx.boardId}&period=all`,
      status: boardTxt.status,
      contentType: String(boardTxt.headers['content-type'] ?? ''),
      rowsOnly: true,
      body: String(boardTxt.text),
    });

    // ---- the profile, and a flag change ------------------------------
    await send('players.profile.response', 'get', `/players/${encodeURIComponent(email)}`);
    res = await send('players.patch.request', 'patch', `/players/${encodeURIComponent(email)}`, { private: true });
    assert(res.status === 200, `patch answered ${res.status}: ${res.text}`);
    captured.push({
      id: 'players.patch.response',
      method: 'PATCH',
      path: `/achievements/v1/players/${encodeURIComponent(email)}`,
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body: res.body,
    });
    // Put it back, so the leaderboard example above is not contradicted by
    // a private player nobody can see.
    await send(null, 'patch', `/players/${encodeURIComponent(email)}`, { private: false });

    // ---- unlinking, and the two health objects -----------------------
    res = await send('links.unlink.request', 'delete', '/links', { email: other });
    assert(res.status === 200, `unlink answered ${res.status}: ${res.text}`);
    captured.push({
      id: 'links.unlink.response',
      method: 'DELETE',
      path: '/achievements/v1/links',
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body: res.body,
    });

    await send('health.response', 'get', '/health', undefined, { auth: false });
    await send('health.doorrepo.response', 'get', '/api/door-repo/health', undefined, {
      auth: false,
      absolute: true,
    });

    // A GET has no body, so its `.request` anchor documents the request
    // LINE - and it has to be the line this walk sent, not a cursor
    // somebody typed into the document once.
    for (const id of ['catalog.since.response', 'leaderboard.global.response']) {
      const ex = captured.find((c) => c.id === id);
      if (ex !== undefined) captured.push({ ...ex, id: id.replace(/\.response$/, '.request') });
    }

    // Listings a reader cannot use whole are cut here, once, and the cut
    // is printed under the fence rather than hidden.
    return captured.map((ex) => {
      switch (ex.id) {
        case 'events.clean.response':
        case 'events.mixed.response':
          return trim(ex, { progress: 2 });
        case 'players.profile.response':
        case 'players.patch.response':
          return trim(ex, { unlocks: 2, progress: 2 });
        case 'catalog.txt.response':
          return trimText(ex, 2);
        default:
          return ex;
      }
    });
  } finally {
    db.close();
  }
}

/**
 * How an example is written into the document.
 *
 * JSON is pretty-printed at two spaces - the hand-written originals were
 * wrapped by eye, which no generator can reproduce and no reader needs.
 * The two `.txt` endpoints keep their real bytes with `<CR><LF>` standing
 * in for 0x0D 0x0A, so the document itself stays one line per row.
 */
const HEADER_ORDER = ['content-type', 'x-achievements-contract', 'x-achievements-revision'];
const HEADER_NAMES: Record<string, string> = {
  'content-type': 'Content-Type',
  'x-achievements-contract': 'X-Achievements-Contract',
  'x-achievements-revision': 'X-Achievements-Revision',
};

export function renderExample(ex: CapturedExample): string {
  if (typeof ex.body === 'string') {
    const rows = ex.body
      .split('\r\n')
      .filter((l) => l.length > 0)
      .map((l) => `${l}<CR><LF>`);
    const headers = HEADER_ORDER.filter((h) => ex.responseHeaders?.[h] !== undefined).map(
      (h) => `${HEADER_NAMES[h]}: ${ex.responseHeaders?.[h] ?? ''}`
    );
    if (ex.rowsOnly === true) return rows.join('\n');
    return [
      `${ex.method} ${ex.path}`,
      'Authorization: Board uprough.<key>',
      '',
      `HTTP/1.1 ${ex.status} OK`,
      ...headers,
      '',
      ...rows,
    ].join('\n');
  }
  return JSON.stringify(ex.body, null, 2);
}

/**
 * The request half: the body a caller sent, or - for a GET, which has none
 * - the request line itself, so a documented query string is the one this
 * walk actually asked for rather than a cursor invented in prose.
 */
export function renderRequest(ex: CapturedExample): string {
  if (ex.requestBody === undefined) return `${ex.method} ${ex.path}`;
  return JSON.stringify(ex.requestBody, null, 2);
}

const ANCHOR =
  /<!-- capture: ([a-z0-9.]+) -->\n(```[a-z]*\n)([\s\S]*?)(```)(?:\n\*\(the first[^\n]*\)\*)?/g;

/** `*(the first 2 of 14 `progress` entries.)*`, or nothing. */
export function elisionNote(ex: CapturedExample): string {
  if (ex.note !== undefined) return `\n*(${ex.note})*`;
  if (ex.elided === undefined) return '';
  const parts = Object.entries(ex.elided).map(
    ([field, [kept, total]]) => `the first ${kept} of ${total} \`${field}\` entries`
  );
  return `\n*(${parts.join(', ')}.)*`;
}

/**
 * Replace every anchored fence with what the walk captured.
 *
 * An anchor nothing captured is left alone and REPORTED: silently keeping
 * a hand-written example under a banner that says "captured from the real
 * server" is the exact failure this whole exercise exists to end.
 */
export function applyCaptures(
  doc: string,
  captured: CapturedExample[]
): { text: string; replaced: number; missing: string[] } {
  const byId = new Map<string, CapturedExample>();
  for (const ex of captured) byId.set(ex.id, ex);
  const missing: string[] = [];
  let replaced = 0;

  const text = doc.replace(ANCHOR, (whole, id: string, open: string, _body: string, close: string) => {
    const ex = byId.get(id);
    if (ex === undefined) {
      missing.push(id);
      return whole;
    }
    replaced += 1;
    const rendered = id.endsWith('.request') ? renderRequest(ex) : renderExample(ex);
    return `<!-- capture: ${id} -->\n${open}${rendered}\n${close}${elisionNote(ex)}`;
  });

  return { text, replaced, missing };
}

/**
 * A body with everything that cannot repeat between two runs masked, and
 * everything that must not change kept.
 *
 * The masking is by VALUE SHAPE, never by field name: a timestamp, a
 * six-character code, a revision and a season are the only things this walk
 * cannot reproduce. A season is the UTC calendar quarter the run falls in, so
 * it read 2026Q3 when the document was captured and 2026Q4 a quarter later,
 * and /health stopped matching without either side being wrong - the fixture is otherwise deterministic, so counts, points,
 * tiers, rarities and ids all repeat exactly and are compared for real. A
 * name-based mask would have hidden `boards: ["uprough"]` behind the same
 * token as `boards: 4` and stopped proving anything about either.
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const REVISION = /^[al]\d+-t\d+$/;
const SEASON = /^\d{4}Q[1-4]$/;

export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalize(v);
    return out;
  }
  if (typeof value === 'string') {
    if (TIMESTAMP.test(value)) return '<timestamp>';
    if (CODE.test(value)) return '<code>';
    if (REVISION.test(value)) return '<revision>';
    if (SEASON.test(value)) return '<season>';
  }
  return value;
}

/** The same masking for the two text formats: the header revision only. */
export function normalizeText(body: string): string[] {
  return body
    .split('\r\n')
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^ACHIEVE\|1\|[^|]+\|/, 'ACHIEVE|1|<revision>|'));
}
