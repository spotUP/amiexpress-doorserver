/**
 * PUT /catalog/doors/<door> - a door's own achievement definitions.
 *
 * A door declares its achievements in its manifest and pushes them the
 * first time it reports and whenever the manifest's digest changes. What
 * this module enforces, per definition and for the whole request at once:
 *
 * - the NAMESPACE: every id is `door.<door>.<slug>` for the door in the
 *   URL. A door cannot define into another door's space or a BBS family.
 * - the RULE: a known operator, never `granted` (server-only, D11), never a
 *   `meta.*` type - a door cannot hook the server's internal stream.
 * - the SHAPE: one of four tiers, 1-100 points, a 1-64 name, a 1-160
 *   description, at most 64 achievements in one door.
 * - IMMUTABILITY: an id that exists with a different digest is a 409 and
 *   the original stands. The digest is catalog.ts's - the same one the seed
 *   is judged by - and covers the name and description too (D8).
 *
 * Rejection is whole-request: the transaction writes nothing when any id
 * fails. Partial acceptance would leave a door's catalog half-old and
 * half-new with no way for the author to tell.
 */
import type Database from 'better-sqlite3';
import { auditBoard } from './boards';
import { definitionDigest } from './catalog';
import { ruleTypes } from './engine';
import { SurfaceError } from './errors';
import type { AchievementDef, DoorCatalogResponse, Rule, Tier } from '../../contract/achievement-types';

export const DOOR_SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const MAX_DOOR_ACHIEVEMENTS = 64;
export const TIERS: Tier[] = ['bronze', 'silver', 'gold', 'platinum'];
const OPS = new Set(['count', 'first', 'sum', 'distinct', 'streak', 'within', 'all']);

function bad(code: 'bad_rule' | 'bad_definition' | 'bad_namespace', detail: string): SurfaceError {
  return new SurfaceError(code, 400, detail);
}

/** A rule a door may define, or the refusal. Keys the engine does not read are dropped. */
function checkRule(id: string, raw: unknown): Rule {
  if (raw === null || typeof raw !== 'object') throw bad('bad_rule', `${id}: rule must be an object`);
  const r = raw as Record<string, unknown>;
  const op = r.op;
  if (op === 'granted') throw bad('bad_rule', `${id}: granted rules are the server's alone`);
  if (typeof op !== 'string' || !OPS.has(op)) throw bad('bad_rule', `${id}: unknown operator ${String(op)}`);
  const n = (): number => {
    if (typeof r.n !== 'number' || !Number.isInteger(r.n) || r.n < 1) throw bad('bad_rule', `${id}: n must be a positive integer`);
    return r.n;
  };
  const type = (): string => {
    if (typeof r.type !== 'string' || r.type.length === 0 || r.type.length > 64) throw bad('bad_rule', `${id}: type is required`);
    if (r.type.startsWith('meta.')) throw bad('bad_rule', `${id}: ${r.type} is the server's own event stream`);
    return r.type;
  };
  const key = (): { key?: string } => (typeof r.key === 'string' && r.key.length > 0 ? { key: r.key } : {});
  switch (op) {
    case 'count':
      return { op, type: type(), n: n(), ...key() };
    case 'first':
      return { op, type: type(), ...key() };
    case 'sum':
      return { op, type: type(), field: 'value', n: n() };
    case 'distinct': {
      if (r.dim !== 'key' && r.dim !== 'board') throw bad('bad_rule', `${id}: distinct needs dim key or board`);
      return { op, type: type(), dim: r.dim, n: n(), ...(r.group === 'key' ? { group: 'key' as const } : {}) };
    }
    case 'streak':
      return { op, type: type(), unit: 'day', n: n() };
    case 'within': {
      if (typeof r.window_s !== 'number' || !Number.isInteger(r.window_s) || r.window_s < 1) {
        throw bad('bad_rule', `${id}: within needs window_s`);
      }
      return { op, type: type(), n: n(), window_s: r.window_s };
    }
    case 'all': {
      if (!Array.isArray(r.ids) || r.ids.length === 0 || !r.ids.every((x) => typeof x === 'string')) {
        throw bad('bad_rule', `${id}: all needs a list of ids`);
      }
      return { op, ids: r.ids as string[] };
    }
    default:
      throw bad('bad_rule', `${id}: unknown operator ${op}`);
  }
}

/** One definition, validated into the shape the catalog stores. */
export function checkDefinition(door: string, raw: unknown, index: number): AchievementDef {
  if (raw === null || typeof raw !== 'object') throw bad('bad_definition', `achievements[${index}] is not an object`);
  const d = raw as Record<string, unknown>;
  const id = typeof d.id === 'string' ? d.id : '';
  const ns = new RegExp(`^door\\.${door}\\.[a-z0-9_]+$`);
  if (!ns.test(id)) throw bad('bad_namespace', `${id || `achievements[${index}]`} is outside door.${door}.<slug>`);
  if (typeof d.name !== 'string' || d.name.length < 1 || d.name.length > 64) throw bad('bad_definition', `${id}: name is 1 to 64 characters`);
  if (typeof d.description !== 'string' || d.description.length < 1 || d.description.length > 160) {
    throw bad('bad_definition', `${id}: description is 1 to 160 characters`);
  }
  if (typeof d.tier !== 'string' || !TIERS.includes(d.tier as Tier)) throw bad('bad_definition', `${id}: tier is one of ${TIERS.join(', ')}`);
  if (typeof d.points !== 'number' || !Number.isInteger(d.points) || d.points < 1 || d.points > 100) {
    throw bad('bad_definition', `${id}: points is 1 to 100`);
  }
  return {
    id,
    name: d.name,
    description: d.description,
    family: 'door',
    tier: d.tier as Tier,
    points: d.points,
    hidden: d.hidden === true,
    rule: checkRule(id, d.rule),
  };
}

/**
 * Register a door's definitions for the key's board. Must run inside a
 * transaction: the 409 thrown mid-loop is what makes rejection whole.
 */
export function registerDoorCatalog(
  db: Database.Database,
  boardId: string,
  door: string,
  body: unknown,
  now: number
): DoorCatalogResponse {
  if (!DOOR_SLUG.test(door)) throw new SurfaceError('bad_door', 400, 'the door segment is a slug: ^[a-z0-9][a-z0-9-]{1,31}$');
  const b = (body ?? {}) as { digest?: unknown; achievements?: unknown };
  if (typeof b.digest !== 'string' || !Array.isArray(b.achievements)) {
    throw new SurfaceError('bad_request', 400, 'the body is {digest, achievements:[...]}');
  }
  if (b.achievements.length > MAX_DOOR_ACHIEVEMENTS) {
    throw new SurfaceError('too_many', 400, `a door defines at most ${MAX_DOOR_ACHIEVEMENTS} achievements`);
  }
  const defs = b.achievements.map((raw, i) => checkDefinition(door, raw, i));
  const seen = new Set<string>();
  for (const d of defs) {
    if (seen.has(d.id)) throw bad('bad_definition', `${d.id} appears twice`);
    seen.add(d.id);
  }

  const existing = db.prepare('SELECT digest FROM achievements WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO achievements (id, name, description, family, tier, points, hidden, rule, digest, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const index = db.prepare('INSERT OR IGNORE INTO achievement_types (achievement_id, type) VALUES (?, ?)');
  let added = 0;
  let unchanged = 0;
  for (const d of defs) {
    const digest = definitionDigest(d);
    const row = existing.get(d.id) as { digest: string } | undefined;
    if (row) {
      if (row.digest !== digest) {
        throw new SurfaceError('definition_changed', 409, `${d.id} is published with a different definition; publish a new id`);
      }
      unchanged += 1;
      continue;
    }
    insert.run(d.id, d.name, d.description, d.family, d.tier, d.points, d.hidden ? 1 : 0, JSON.stringify(d.rule), digest, `door:${door}`, now, now);
    for (const t of ruleTypes(d.rule)) index.run(d.id, t);
    added += 1;
  }
  db.prepare(
    `INSERT INTO door_catalog_digests (door, digest, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(door) DO UPDATE SET digest = excluded.digest, updated_at = excluded.updated_at`
  ).run(door, b.digest, now);
  auditBoard(db, boardId, `catalog:${door}`, defs.length, now);
  return { added, unchanged, total: defs.length };
}
