/**
 * The rule engine. Rules are DATA, read out of achievements.rule; nothing
 * in this file names an achievement, and a test reads this source to make
 * sure of it.
 *
 * ONE question, asked of an index: which achievements name a type this
 * batch touched (achievement_types, by type)? Only those are evaluated,
 * only for the players the batch moved, and only if the player has not
 * already unlocked them. Never a scan of the catalog.
 *
 * Eight operators, one question each - see `progressOf()`. An achievement
 * unlocks once, globally, for ever: the unlock row's primary key is
 * (player, achievement), and the insert is ON CONFLICT DO NOTHING.
 *
 * THE CASCADE. An unlock appends the server's own events - meta.unlock,
 * keyed by the achievement id, and meta.board_first when it is the first
 * unlock the board ever recorded (D9) - through the same fold every event
 * takes, and re-enters evaluate() for those types. `all` rules index under
 * the pseudo-type meta.unlock, which is the only way a meta award can fire.
 * Five levels, then a [WARN] and a stop.
 *
 * EARNED AGAIN, ELSEWHERE. An achievement unlocks once, globally - so what
 * does "earn the same achievement on three boards" (boards.same.3) count?
 * The boards from which the player satisfied it. When a board's events
 * move a rule the player has ALREADY unlocked and the rule still holds,
 * the server appends meta.unlock for that board too (its ref names the
 * board, so once per board), inserts no unlock and reports no progress.
 * counter_dims then holds one board row per (player, achievement), which
 * is exactly the distinct the rule reads. Found by AC-18's replay, where
 * the cascade the plan promised could not fire.
 */
import type Database from 'better-sqlite3';
import { recordEvent } from './counters';
import { ensureCurrentSeason } from './seasons';
import { rarityOf } from './rarity';
import type { ProgressOut, Rule, Tier, UnlockOut } from '../../contract/achievement-types';

export const MAX_CASCADE_DEPTH = 5;
export const MAX_PROGRESS = 20;

/** The event types a rule reads - what the candidate index lists it under. */
export function ruleTypes(rule: Rule): string[] {
  switch (rule.op) {
    case 'all':
      return ['meta.unlock'];
    case 'granted':
      return [];
    default:
      return [rule.type];
  }
}

interface CandidateRow {
  id: string;
  name: string;
  tier: Tier;
  points: number;
  hidden: number;
  rule: string;
  /** The stored rarity, or null when nothing has recomputed it yet. */
  pct_tenths: number | null;
  /** 1 when this player already holds it. */
  unlocked: number;
}

export interface Progress {
  have: number;
  need: number;
}

/** The longest run of consecutive UTC days in a sorted list of 'YYYY-MM-DD'. */
export function longestStreak(days: string[]): number {
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const day of days) {
    const t = Date.parse(`${day}T00:00:00Z`) / 86400000;
    run = prev !== null && t === prev + 1 ? run + 1 : 1;
    prev = t;
    if (run > best) best = run;
  }
  return best;
}

/** The most events any window of `windowSeconds` holds, over sorted times. */
export function densestWindow(times: number[], windowSeconds: number): number {
  let best = 0;
  let i = 0;
  for (let j = 0; j < times.length; j += 1) {
    while (times[j] - times[i] > windowSeconds) i += 1;
    if (j - i + 1 > best) best = j - i + 1;
  }
  return best;
}

/** have/need for one rule and one player. `granted` is never earned here. */
export function progressOf(db: Database.Database, playerId: number, rule: Rule): Progress | null {
  switch (rule.op) {
    case 'count':
    case 'first': {
      const key = rule.key ?? '';
      const row = db
        .prepare('SELECT n FROM counters WHERE player_id = ? AND type = ? AND key = ?')
        .get(playerId, rule.type, key) as { n: number } | undefined;
      let have = row?.n ?? 0;
      if (key === '') {
        const snap = db
          .prepare('SELECT value FROM snapshots WHERE player_id = ? AND name = ?')
          .get(playerId, rule.type) as { value: number } | undefined;
        if (snap && snap.value > have) have = snap.value;
      }
      return { have, need: rule.op === 'first' ? 1 : rule.n };
    }
    case 'sum': {
      const row = db
        .prepare(`SELECT sum_value FROM counters WHERE player_id = ? AND type = ? AND key = ''`)
        .get(playerId, rule.type) as { sum_value: number } | undefined;
      return { have: row?.sum_value ?? 0, need: rule.n };
    }
    case 'distinct': {
      const row = rule.group
        ? (db
            .prepare(
              `SELECT COALESCE(MAX(c), 0) AS have FROM (
                 SELECT COUNT(*) AS c FROM counter_dims
                  WHERE player_id = ? AND type = ? AND dim = ? AND grp <> '' GROUP BY grp)`
            )
            .get(playerId, rule.type, rule.dim) as { have: number })
        : (db
            .prepare(
              `SELECT COUNT(*) AS have FROM counter_dims WHERE player_id = ? AND type = ? AND dim = ? AND grp = ''`
            )
            .get(playerId, rule.type, rule.dim) as { have: number });
      return { have: row.have, need: rule.n };
    }
    case 'streak': {
      const days = (
        db.prepare('SELECT day FROM counter_days WHERE player_id = ? AND type = ? ORDER BY day').all(playerId, rule.type) as {
          day: string;
        }[]
      ).map((r) => r.day);
      return { have: longestStreak(days), need: rule.n };
    }
    case 'within': {
      const times = (
        db.prepare('SELECT at FROM events WHERE player_id = ? AND type = ? ORDER BY at').all(playerId, rule.type) as {
          at: number;
        }[]
      ).map((r) => r.at);
      return { have: densestWindow(times, rule.window_s), need: rule.n };
    }
    case 'all': {
      if (rule.ids.length === 0) return { have: 0, need: 1 };
      const marks = rule.ids.map(() => '?').join(',');
      const row = db
        .prepare(`SELECT COUNT(*) AS have FROM unlocks WHERE player_id = ? AND achievement_id IN (${marks})`)
        .get(playerId, ...rule.ids) as { have: number };
      return { have: row.have, need: rule.ids.length };
    }
    case 'granted':
      return null;
    default:
      return null;
  }
}

function candidates(db: Database.Database, playerId: number, types: string[]): CandidateRow[] {
  if (types.length === 0) return [];
  const marks = types.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT DISTINCT a.id, a.name, a.tier, a.points, a.hidden, a.rule, r.pct_tenths,
              EXISTS (SELECT 1 FROM unlocks u WHERE u.player_id = ? AND u.achievement_id = a.id) AS unlocked
         FROM achievement_types t JOIN achievements a ON a.id = t.achievement_id
         LEFT JOIN rarity r ON r.achievement_id = a.id
        WHERE t.type IN (${marks})
        ORDER BY a.id`
    )
    .all(playerId, ...types) as CandidateRow[];
}

/** Every achievement id the last evaluate() considered, for the index test. */
let lastEvaluated: string[] = [];
export function _lastEvaluatedForTests(): string[] {
  return lastEvaluated;
}

export interface Evaluation {
  unlocks: UnlockOut[];
  progress: ProgressOut[];
}

/**
 * Evaluate every achievement that COULD have moved, for every player the
 * batch touched, and insert what unlocked. Must run inside the write
 * transaction, after the fold.
 */
export function evaluate(
  db: Database.Database,
  playerIds: number[],
  types: string[],
  boardId: string,
  now: number
): Evaluation {
  lastEvaluated = [];
  const unlocks: UnlockOut[] = [];
  const progress = new Map<string, ProgressOut>();
  if (playerIds.length === 0 || types.length === 0) return { unlocks, progress: [] };

  const seasonId = ensureCurrentSeason(db, now);
  const insertUnlock = db.prepare(
    `INSERT INTO unlocks (player_id, achievement_id, board_id, season_id, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(player_id, achievement_id) DO NOTHING`
  );
  const boardUnlockCount = db.prepare('SELECT COUNT(*) AS n FROM unlocks WHERE board_id = ?');

  for (const playerId of playerIds) {
    let pending = types;
    for (let depth = 0; pending.length > 0; depth += 1) {
      if (depth >= MAX_CASCADE_DEPTH) {
        console.warn(
          `[WARN] achievement cascade depth exceeded for player ${playerId} on ${boardId}: ${pending.join(',')}`
        );
        break;
      }
      const next = new Set<string>();
      for (const c of candidates(db, playerId, pending)) {
        lastEvaluated.push(c.id);
        const rule = JSON.parse(c.rule) as Rule;
        // A meta rule re-asked from its own meta event would loop on itself.
        if (c.unlocked !== 0 && rule.op !== 'count' && rule.op !== 'first' && rule.op !== 'sum' && rule.op !== 'distinct' && rule.op !== 'streak' && rule.op !== 'within') continue;
        const p = progressOf(db, playerId, rule);
        if (p === null) continue;
        if (p.have < p.need) {
          if (c.unlocked === 0) progress.set(c.id, { id: c.id, have: p.have, need: p.need });
          continue;
        }
        if (c.unlocked !== 0) {
          // Earned again, from this board: one meta.unlock per board, no
          // second unlock, no progress. The ref makes the "once per board".
          if (recordEvent(db, {
            boardId,
            ref: `${boardId}:meta.unlock:${playerId}:${c.id}`,
            playerId,
            type: 'meta.unlock',
            key: c.id,
            value: 1,
            at: now,
            receivedAt: now,
            clamped: false,
          })) {
            next.add('meta.unlock');
          }
          continue;
        }
        const wasFirst = (boardUnlockCount.get(boardId) as { n: number }).n === 0;
        if (insertUnlock.run(playerId, c.id, boardId, seasonId, now).changes === 0) continue;
        progress.delete(c.id);
        unlocks.push({
          id: c.id,
          name: c.name,
          tier: c.tier,
          points: c.points,
          hidden: c.hidden !== 0,
          rarityPctTenths: rarityOf(c.pct_tenths).pctTenths,
          at: new Date(now * 1000).toISOString(),
        });

        // The server's own events, through the same fold as every other.
        recordEvent(db, {
          boardId,
          ref: `${boardId}:meta.unlock:${playerId}:${c.id}`,
          playerId,
          type: 'meta.unlock',
          key: c.id,
          value: 1,
          at: now,
          receivedAt: now,
          clamped: false,
        });
        next.add('meta.unlock');
        if (wasFirst) {
          recordEvent(db, {
            boardId,
            ref: `${boardId}:meta.board_first`,
            playerId,
            type: 'meta.board_first',
            key: null,
            value: 1,
            at: now,
            receivedAt: now,
            clamped: false,
          });
          next.add('meta.board_first');
        }
      }
      pending = [...next];
    }
  }

  const ordered = [...progress.values()]
    .sort((a, b) => b.have / b.need - a.have / a.need || a.id.localeCompare(b.id))
    .slice(0, MAX_PROGRESS);
  return { unlocks, progress: ordered };
}
