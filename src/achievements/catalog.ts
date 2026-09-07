/**
 * The catalog: its fingerprint, its digest rule, and the seed.
 *
 * REVISION. `a<count>-t<newest updated_at>` - the same shape
 * getCatalogRevision() uses for the door repo (src/catalog.ts), and for the
 * same reason: never a git SHA, because a deploy that changed no
 * achievement must not invalidate a good client's cache. A 68K door that has
 * last week's catalog compares two short ASCII strings and stops.
 *
 * DIGEST (D8). sha256 over id, name, description, family, tier, points,
 * hidden and the rule, in that order, with the rule's keys sorted. "An
 * existing id's definition is IMMUTABLE" covers the display name too: a
 * player who unlocked "First Blood" does not wake up holding something
 * else. The same function judges a seed edit here and a door's PUT in
 * AC-13, so the two cannot disagree about what "different" means.
 *
 * SEED. seeds/achievements.seed.json is loaded at startup. An id that does
 * not exist is inserted with its digest and source 'seed', and indexed
 * under the types its rule reads. An id that DOES exist is left alone; if
 * the seed's digest differs the loader logs one [WARN] and moves on. A seed
 * edit can never rewrite a published achievement - the same immutability
 * the API enforces, applied to the file, because otherwise a careless edit
 * silently changes what people already earned.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { ruleTypes } from './engine';
import { rarityOf } from './rarity';
import { esc, oneLine, toLatin1Safe } from '../text-format';
import type { AchievementDef, CatalogAchievement, RarityBucket, Rule, Tier } from '../../contract/achievement-types';

export function catalogRevision(db: Database.Database): string {
  const row = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS t FROM achievements')
    .get() as { n: number; t: number };
  return `a${row.n}-t${row.t}`;
}

/** Points by tier, unless an entry says otherwise. */
export const TIER_POINTS: Record<Tier, number> = { bronze: 5, silver: 10, gold: 25, platinum: 50 };

/** A seed entry: an AchievementDef whose points may be left to the tier. */
export interface SeedAchievement extends Omit<AchievementDef, 'points'> {
  points?: number;
}

export interface Seed {
  formatVersion: 1;
  achievements: SeedAchievement[];
}

/** The rule with its keys in a fixed order, so the digest is stable. */
function canonicalRule(rule: Rule): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(rule).sort()) sorted[k] = (rule as unknown as Record<string, unknown>)[k];
  return JSON.stringify(sorted);
}

export function definitionDigest(def: AchievementDef): string {
  const h = crypto.createHash('sha256');
  for (const part of [
    def.id,
    def.name,
    def.description,
    def.family,
    def.tier,
    String(def.points),
    def.hidden ? '1' : '0',
    canonicalRule(def.rule),
  ]) {
    h.update(part);
    h.update('\n');
  }
  return h.digest('hex');
}

export function pointsFor(entry: SeedAchievement): number {
  return entry.points ?? TIER_POINTS[entry.tier];
}

/** seeds/achievements.seed.json, beside src/ in both layouts. */
export const SEED_PATH = path.join(__dirname, '..', '..', 'seeds', 'achievements.seed.json');

export function loadSeed(file: string = SEED_PATH): Seed {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Seed;
}

export interface SeedResult {
  inserted: string[];
  /** Ids the seed defines differently from what is published. Left alone. */
  differs: string[];
}

/**
 * Insert what is new; never touch what is published. Idempotent: the
 * second run of the same seed inserts nothing.
 */
export function seedCatalog(
  db: Database.Database,
  seed: Seed,
  now: number = Math.floor(Date.now() / 1000),
  log: (line: string) => void = (line) => console.warn(line)
): SeedResult {
  const existing = db.prepare('SELECT digest FROM achievements WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO achievements (id, name, description, family, tier, points, hidden, rule, digest, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?, ?)`
  );
  const index = db.prepare('INSERT OR IGNORE INTO achievement_types (achievement_id, type) VALUES (?, ?)');
  const result: SeedResult = { inserted: [], differs: [] };

  const run = db.transaction(() => {
    for (const entry of seed.achievements) {
      const def: AchievementDef = { ...entry, points: pointsFor(entry) };
      const digest = definitionDigest(def);
      const row = existing.get(def.id) as { digest: string } | undefined;
      if (row) {
        if (row.digest !== digest) {
          result.differs.push(def.id);
          log(`[WARN] seed definition for ${def.id} differs from the published one; the published one stands`);
        }
        continue;
      }
      insert.run(
        def.id,
        def.name,
        def.description,
        def.family,
        def.tier,
        def.points,
        def.hidden ? 1 : 0,
        JSON.stringify(def.rule),
        digest,
        now,
        now
      );
      for (const t of ruleTypes(def.rule)) index.run(def.id, t);
      result.inserted.push(def.id);
    }
  });
  run();
  return result;
}

// ---------------------------------------------------------------------------
// Serving the catalog: JSON rows, the text rows, and `since`.
// ---------------------------------------------------------------------------

/**
 * The `-t<epoch>` suffix of a revision this server once returned, or null
 * when it does not parse. null means THE WHOLE CATALOG and a 200 - never a
 * 400: an old client with a mangled cursor must be able to recover.
 */
export function parseSince(since: string | undefined): number | null {
  if (typeof since !== 'string') return null;
  const m = /^a\d+-t(\d{1,12})$/.exec(since.trim());
  return m ? Number(m[1]) : null;
}

/** Re-exported: the floor is defined next to the arithmetic it mirrors. */
export { RARITY_FLOOR } from './rarity';

interface CatalogRow {
  id: string;
  name: string;
  description: string;
  family: string;
  tier: Tier;
  points: number;
  hidden: number;
  rule: string;
  updated_at: number;
  pct_tenths: number | null;
  bucket: RarityBucket | null;
  /** 1 when a player linked to the asking board has unlocked it. */
  revealed: number;
}

/** How many times catalogRows() ran; the 304 test proves it did not. */
let rowReads = 0;
export function _catalogRowReadsForTests(): number {
  return rowReads;
}

/**
 * The catalog as the asking board may see it. A hidden achievement is
 * LISTED with hidden: true, but its name is `???` and its description empty
 * until a player linked to THIS board has unlocked it: the catalog is
 * per-board, not per-player, and the flag alone would let any client print
 * the surprise.
 */
export function catalogRows(db: Database.Database, boardId: string, sinceEpoch: number | null): CatalogAchievement[] {
  rowReads += 1;
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.description, a.family, a.tier, a.points, a.hidden, a.rule, a.updated_at,
              r.pct_tenths, r.bucket,
              EXISTS (SELECT 1 FROM unlocks u JOIN links l ON l.player_id = u.player_id
                       WHERE u.achievement_id = a.id AND l.board_id = ?) AS revealed
         FROM achievements a
         LEFT JOIN rarity r ON r.achievement_id = a.id
        WHERE a.updated_at > ?
        ORDER BY a.id`
    )
    .all(boardId, sinceEpoch ?? -1) as CatalogRow[];
  return rows.map((r) => {
    const withheld = r.hidden !== 0 && r.revealed === 0;
    return {
      id: r.id,
      name: withheld ? '???' : r.name,
      description: withheld ? '' : r.description,
      family: r.family,
      tier: r.tier,
      points: r.points,
      hidden: r.hidden !== 0,
      rule: JSON.parse(r.rule) as Rule,
      rarityPctTenths: rarityOf(r.pct_tenths, r.bucket).pctTenths,
      rarityBucket: rarityOf(r.pct_tenths, r.bucket).bucket,
      updatedAt: new Date(r.updated_at * 1000).toISOString(),
    };
  });
}

/** One text field: pipes to `!`, line breaks to spaces, Latin-1 only. */
function textField(s: string): string {
  return toLatin1Safe(esc(oneLine(s)));
}

/**
 * catalog.txt, byte for byte (ACHIEVEMENTS-API.md, section 7):
 *   ACHIEVE|1|<revision>|<count>CRLF
 *   <id>|<family>|<tier>|<points>|<hidden>|<name>|<description>|<op>|<rarity_tenths>|<bucket>CRLF
 * Append-only: a new field goes on the END of a row.
 */
export function renderCatalogTxt(rows: CatalogAchievement[], revision: string): Buffer {
  const lines = [`ACHIEVE|1|${revision}|${rows.length}`];
  for (const a of rows) {
    lines.push(
      [
        textField(a.id),
        textField(a.family),
        a.tier,
        String(a.points),
        a.hidden ? '1' : '0',
        textField(a.name),
        textField(a.description).slice(0, 120),
        a.rule.op,
        String(a.rarityPctTenths),
        a.rarityBucket,
      ].join('|')
    );
  }
  return Buffer.from(lines.join('\r\n') + '\r\n', 'latin1');
}
