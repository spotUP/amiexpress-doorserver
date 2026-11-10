/**
 * AC-11 - the seed catalog.
 *
 * The id list is PINNED here, transcribed from the design spec's catalog
 * tables (docs/superpowers/specs/2026-09-03-global-achievements-design.md,
 * "The catalog"), so a dropped achievement is a test failure today and not
 * a discovery in six months. The meta awards - one `all` per family, which
 * the spec names by role and not by id - are pinned under <family>.all.
 */
import Database from 'better-sqlite3';
import { REJECT_REASONS } from '../../contract/achievement-types';
import type { Rule } from '../../contract/achievement-types';
import { definitionDigest, loadSeed, pointsFor, seedCatalog, TIER_POINTS } from '../../src/achievements/catalog';
import { ruleTypes } from '../../src/achievements/engine';
import { makeAchievementsFixture } from './helpers';
import type { AchievementsFixture } from './helpers';

const SPEC_IDS = [
  'msg.post.1', 'msg.post.10', 'msg.post.100', 'msg.post.1000', 'msg.reply.50', 'msg.thread.10',
  'msg.private.25', 'msg.conf.distinct.10', 'msg.long.1', 'msg.fastreply', 'msg.burst.3', 'msg.comment.10', 'msg.all',
  'file.up.1', 'file.up.10', 'file.up.100', 'file.dl.1', 'file.dl.100', 'file.dl.1000',
  'file.up.bytes.100mb', 'file.up.bytes.1gb', 'file.desc.1', 'file.ratio.silver', 'file.ratio.gold', 'file.old.1', 'file.all',
  'wall.tag.1', 'wall.tag.10', 'wall.tag.100', 'wall.everyconf', 'bull.read.all', 'wall.all',
  'presence.call.1', 'presence.call.10', 'presence.call.100', 'presence.call.1000', 'presence.streak.7', 'presence.streak.30',
  'presence.minutes.600', 'presence.minutes.6000', 'presence.everyhour', 'presence.return30', 'presence.all',
  'social.chat.1', 'social.nodechat.1', 'social.sysop_paged.1', 'social.olm.10', 'social.vote.1', 'social.greet.1', 'social.all',
  'doors.distinct.5', 'doors.distinct.10', 'doors.distinct.25', 'doors.minutes.600', 'doors.all',
  'boards.linked.2', 'boards.linked.5', 'boards.linked.10', 'boards.same.3',
  'rare.caller.1000', 'rare.midnight', 'rare.realc64', 'rare.realamiga', 'rare.petscii', 'rare.newboard.first', 'rare.season.winner',
];

const OPS = ['count', 'first', 'sum', 'distinct', 'streak', 'within', 'all', 'granted'];

let fx: AchievementsFixture;
let db: Database.Database;

beforeEach(() => {
  fx = makeAchievementsFixture({ seed: true });
  db = fx.openAchievements();
});

afterEach(() => {
  db.close();
  fx.cleanup();
});

const seed = loadSeed();
const ids = (): string[] => (db.prepare('SELECT id FROM achievements ORDER BY id').all() as { id: string }[]).map((r) => r.id);

describe('the seed catalog', () => {
  it('contains every achievement id named in the design spec', () => {
    const seeded = seed.achievements.map((a) => a.id).sort();
    expect(seeded).toEqual([...SPEC_IDS].sort());
    expect(ids()).toEqual([...SPEC_IDS].sort());
    expect(SPEC_IDS).toHaveLength(66);
  });

  it('every seeded rule parses into a known operator and names a type', () => {
    for (const a of seed.achievements) {
      const rule = a.rule as Rule;
      expect(OPS).toContain(rule.op);
      if (rule.op === 'all') {
        expect(rule.ids.length).toBeGreaterThan(0);
        for (const id of rule.ids) expect(SPEC_IDS).toContain(id);
      } else if (rule.op !== 'granted') {
        expect(typeof rule.type).toBe('string');
        expect(rule.type.length).toBeGreaterThan(0);
      }
      // The ONE rule a board may never satisfy by posting: the meta types
      // belong to the server, and the seed reads them, never posts them.
      expect(REJECT_REASONS).toContain('unknown_event_type');
    }
  });

  it('every seeded achievement indexes at least one candidate type, except the granted one', () => {
    for (const a of seed.achievements) {
      const types = (
        db.prepare('SELECT type FROM achievement_types WHERE achievement_id = ? ORDER BY type').all(a.id) as { type: string }[]
      ).map((r) => r.type);
      if ((a.rule as Rule).op === 'granted') expect(types).toEqual([]);
      else {
        expect(types.length).toBeGreaterThan(0);
        expect(types).toEqual(ruleTypes(a.rule as Rule));
      }
    }
  });

  it('seeding twice inserts nothing the second time', () => {
    const before = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM achievements').get();
    const warnings: string[] = [];

    const again = seedCatalog(db, seed, 1900000000, (l) => warnings.push(l));

    expect(again.inserted).toEqual([]);
    expect(again.differs).toEqual([]);
    expect(warnings).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM achievements').get()).toEqual(before);
  });

  it('a seed whose definition differs from a published id warns and does not overwrite', () => {
    const renamed = {
      ...seed,
      achievements: seed.achievements.map((a) => (a.id === 'msg.post.100' ? { ...a, name: 'Hundred Club' } : a)),
    };
    const warnings: string[] = [];

    const r = seedCatalog(db, renamed, 1900000000, (l) => warnings.push(l));

    expect(r.differs).toEqual(['msg.post.100']);
    expect(warnings).toEqual(['[WARN] seed definition for msg.post.100 differs from the published one; the published one stands']);
    expect(db.prepare('SELECT name FROM achievements WHERE id = ?').get('msg.post.100')).toEqual({ name: 'Century' });
    // The digest covers the name (D8): the same rule under a new name is a
    // different definition.
    const a = seed.achievements.find((x) => x.id === 'msg.post.100');
    if (!a) throw new Error('msg.post.100 missing from the seed');
    const def = { ...a, points: pointsFor(a) };
    expect(definitionDigest({ ...def, name: 'Hundred Club' })).not.toBe(definitionDigest(def));
  });

  it('every tier maps to its default points unless the entry overrides', () => {
    expect(TIER_POINTS).toEqual({ bronze: 5, silver: 10, gold: 25, platinum: 50 });
    const rows = db.prepare('SELECT id, tier, points FROM achievements').all() as { id: string; tier: keyof typeof TIER_POINTS; points: number }[];
    for (const row of rows) {
      const entry = seed.achievements.find((a) => a.id === row.id);
      expect(row.points).toBe(entry?.points ?? TIER_POINTS[row.tier]);
    }
    // And an override is honoured, not flattened to the tier.
    const overridden = seedCatalog(
      db,
      { formatVersion: 1, achievements: [{ id: 'test.override', name: 'Override', description: 'x', family: 'test', tier: 'bronze', hidden: false, points: 42, rule: { op: 'first', type: 'test.x' } }] },
      1900000000
    );
    expect(overridden.inserted).toEqual(['test.override']);
    expect(db.prepare('SELECT points FROM achievements WHERE id = ?').get('test.override')).toEqual({ points: 42 });
  });

  it('no two achievements share an id, and no id is outside family.slug or door.<name>.<slug> shape', () => {
    const all = seed.achievements.map((a) => a.id);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) {
      expect(id).toMatch(/^(?:[a-z]+(?:\.[a-z0-9_]+)+|door\.[a-z0-9-]+\.[a-z0-9_]+)$/);
      expect(id.startsWith('door.')).toBe(false);
    }
    for (const a of seed.achievements) expect(a.id.startsWith(`${a.family}.`) || a.family === 'wall').toBe(true);
  });
});
