/**
 * Leaderboards.
 *
 * scope=global ranks VERIFIED, NON-PRIVATE players by the points of their
 * unlocks, excluding unlocks earned on a SUSPENDED board - which is what
 * makes "a board can be suspended and its unlocks recomputed out of the
 * global leaderboard without touching anyone's local scoreboard" a fact
 * rather than a hope. scope=board:<id> ranks the players linked to that
 * board by points earned ON it; a private player IS listed there, because
 * a board's caller list is its sysop's own data.
 *
 * Ties break by earliest last-unlock, then handle, so the order is total
 * and two identical requests give the same rows - the text variant depends
 * on it. An unverified player is on no leaderboard at all.
 */
import type Database from 'better-sqlite3';
import { SurfaceError } from './errors';
import { esc, oneLine, toLatin1Safe } from '../text-format';
import { seasonIdAt } from './seasons';
import type { LeaderboardResponse, LeaderboardRow } from '../../contract/achievement-types';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const BOARD_SCOPE = /^board:([a-z0-9][a-z0-9-]{1,31})$/;

export interface LeaderboardQuery {
  scope: string;
  boardId: string | null;
  period: 'all' | 'season';
  limit: number;
}

export function parseLeaderboardQuery(q: Record<string, unknown>): LeaderboardQuery {
  const scope = typeof q.scope === 'string' ? q.scope : 'global';
  let boardId: string | null = null;
  if (scope !== 'global') {
    const m = BOARD_SCOPE.exec(scope);
    if (!m) throw new SurfaceError('bad_scope', 400, 'scope is global or board:<slug>');
    boardId = m[1];
  }
  const period = q.period === 'season' ? 'season' : 'all';
  let limit = DEFAULT_LIMIT;
  if (typeof q.limit === 'string' && /^\d+$/.test(q.limit)) limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit)));
  return { scope, boardId, period, limit };
}

interface StandingRow {
  handle: string;
  points: number;
  unlocks: number;
  last_at: number;
}

export interface Leaderboard extends LeaderboardResponse {
  /** The newest unlock among the rows, for the fingerprint. */
  newestAt: number;
}

export function leaderboard(db: Database.Database, q: LeaderboardQuery, nowSeconds: number): Leaderboard {
  const season = q.period === 'season' ? seasonIdAt(nowSeconds) : null;
  const where: string[] = ['p.verified_at IS NOT NULL'];
  const args: (string | number)[] = [];
  if (q.boardId === null) {
    where.push('p.private = 0', 'b.suspended_at IS NULL');
  } else {
    where.push('u.board_id = ?', 'EXISTS (SELECT 1 FROM links l WHERE l.board_id = u.board_id AND l.player_id = p.id)');
    args.push(q.boardId);
  }
  if (season !== null) {
    where.push('u.season_id = ?');
    args.push(season);
  }
  const rows = db
    .prepare(
      `SELECT p.handle, SUM(a.points) AS points, COUNT(*) AS unlocks, MAX(u.at) AS last_at
         FROM unlocks u
         JOIN players p ON p.id = u.player_id
         JOIN achievements a ON a.id = u.achievement_id
         JOIN boards b ON b.id = u.board_id
        WHERE ${where.join(' AND ')}
        GROUP BY p.id
        ORDER BY points DESC, last_at ASC, p.handle COLLATE NOCASE ASC
        LIMIT ?`
    )
    .all(...args, q.limit) as StandingRow[];
  const out: LeaderboardRow[] = rows.map((r, i) => ({ rank: i + 1, handle: r.handle, points: r.points, unlocks: r.unlocks }));
  const newestAt = rows.reduce((m, r) => Math.max(m, r.last_at), 0);
  return { scope: q.scope, period: q.period, season, revision: `l${out.length}-t${newestAt}`, rows: out, newestAt };
}

/**
 * leaderboard.txt, byte for byte (ACHIEVEMENTS-API.md, section 7):
 *   ACHIEVE|1|<revision>|<count>CRLF
 *   <rank>|<handle>|<points>|<unlocks>CRLF
 * Handles are capped at 16 - the registration cap, so the cap never
 * truncates; it bounds the line against future content.
 */
export function renderLeaderboardTxt(lb: LeaderboardResponse): Buffer {
  const lines = [`ACHIEVE|1|${lb.revision}|${lb.rows.length}`];
  for (const r of lb.rows) {
    lines.push([String(r.rank), toLatin1Safe(esc(oneLine(r.handle))).slice(0, 16), String(r.points), String(r.unlocks)].join('|'));
  }
  return Buffer.from(lines.join('\r\n') + '\r\n', 'latin1');
}
