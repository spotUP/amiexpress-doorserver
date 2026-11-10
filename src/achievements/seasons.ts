/**
 * Seasons: a quarter, named YYYYQn, with UTC boundaries.
 *
 * The season lives on the unlock row, so a "reset" is nothing but the next
 * id: nothing is deleted, recomputed or downgraded at a roll. The naming and
 * the ensure-the-row half arrived with AC-10; AC-15 added the CLOSE behind
 * the same ensureCurrentSeason() hook (D12: no scheduler - the top of every
 * write request is the clock, and scripts/achievements-season.ts is the
 * hand on it).
 *
 * CLOSING A SEASON grants the hidden rare.season.winner to the top global
 * player by that season's points (verified, not private, suspended boards
 * excluded), and to the top player of each board with at least FIVE
 * verified linked players - the floor exists so a one-caller board cannot
 * mint a legendary achievement every quarter. The winner's unlock is
 * stamped with the board of their highest-scoring unlock that season, and
 * with the season being closed. A season with no unlocks closes silently.
 */
import type Database from 'better-sqlite3';

export function seasonIdAt(nowSeconds: number): string {
  const d = new Date(nowSeconds * 1000);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}Q${q}`;
}

/** [starts_at, ends_at) of the quarter holding `nowSeconds`, epoch seconds. */
export function seasonBoundsAt(nowSeconds: number): { startsAt: number; endsAt: number } {
  const d = new Date(nowSeconds * 1000);
  const year = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3);
  const startsAt = Date.UTC(year, q * 3, 1) / 1000;
  const endsAt = (q === 3 ? Date.UTC(year + 1, 0, 1) : Date.UTC(year, (q + 1) * 3, 1)) / 1000;
  return { startsAt, endsAt };
}

/** The current season's id, creating its row if this is its first write. */
export function ensureCurrentSeason(db: Database.Database, nowSeconds: number): string {
  const id = seasonIdAt(nowSeconds);
  const { startsAt, endsAt } = seasonBoundsAt(nowSeconds);
  db.prepare(
    `INSERT INTO seasons (id, starts_at, ends_at, closed_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(id) DO NOTHING`
  ).run(id, startsAt, endsAt);
  closeDueSeasons(db, nowSeconds);
  return id;
}

export const SEASON_WINNER_ID = 'rare.season.winner';
export const BOARD_WINNER_FLOOR = 5;

export interface SeasonClose {
  seasonId: string;
  globalWinner: string | null;
  boardWinners: { boardId: string; handle: string }[];
}

interface Standing {
  player_id: number;
  handle: string;
  points: number;
  last_at: number;
  top_board: string;
}

/** The top player of a closed season, globally or on one board. */
function topOf(db: Database.Database, seasonId: string, boardId: string | null): Standing | undefined {
  const where = boardId === null
    ? `p.private = 0 AND b.suspended_at IS NULL`
    : `u.board_id = ? AND EXISTS (SELECT 1 FROM links l WHERE l.board_id = u.board_id AND l.player_id = p.id)`;
  const args = boardId === null ? [seasonId] : [seasonId, boardId];
  return db
    .prepare(
      `SELECT p.id AS player_id, p.handle, SUM(a.points) AS points, MAX(u.at) AS last_at,
              (SELECT u2.board_id FROM unlocks u2 JOIN achievements a2 ON a2.id = u2.achievement_id
                WHERE u2.player_id = p.id AND u2.season_id = u.season_id
                ORDER BY a2.points DESC, u2.at ASC LIMIT 1) AS top_board
         FROM unlocks u
         JOIN players p ON p.id = u.player_id
         JOIN achievements a ON a.id = u.achievement_id
         JOIN boards b ON b.id = u.board_id
        WHERE u.season_id = ? AND p.verified_at IS NOT NULL AND ${where}
        GROUP BY p.id
        ORDER BY points DESC, last_at ASC, p.handle COLLATE NOCASE ASC
        LIMIT 1`
    )
    .get(...args) as Standing | undefined;
}

/** Close every season whose end has passed. Returns what each close granted. */
export function closeDueSeasons(db: Database.Database, nowSeconds: number): SeasonClose[] {
  const due = db
    .prepare('SELECT id FROM seasons WHERE ends_at <= ? AND closed_at IS NULL ORDER BY ends_at')
    .all(nowSeconds) as { id: string }[];
  const closes: SeasonClose[] = [];
  const winnerExists = db.prepare('SELECT 1 FROM achievements WHERE id = ?').get(SEASON_WINNER_ID) !== undefined;
  const grant = db.prepare(
    `INSERT INTO unlocks (player_id, achievement_id, board_id, season_id, at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(player_id, achievement_id) DO NOTHING`
  );
  for (const { id } of due) {
    const close: SeasonClose = { seasonId: id, globalWinner: null, boardWinners: [] };
    if (winnerExists) {
      const global = topOf(db, id, null);
      if (global) {
        grant.run(global.player_id, SEASON_WINNER_ID, global.top_board, id, nowSeconds);
        close.globalWinner = global.handle;
      }
      const boards = db
        .prepare(
          `SELECT b.id FROM boards b
            WHERE (SELECT COUNT(*) FROM links l JOIN players p ON p.id = l.player_id
                    WHERE l.board_id = b.id AND p.verified_at IS NOT NULL) >= ?
            ORDER BY b.id`
        )
        .all(BOARD_WINNER_FLOOR) as { id: string }[];
      for (const b of boards) {
        const top = topOf(db, id, b.id);
        if (!top) continue;
        grant.run(top.player_id, SEASON_WINNER_ID, b.id, id, nowSeconds);
        close.boardWinners.push({ boardId: b.id, handle: top.handle });
      }
    }
    db.prepare('UPDATE seasons SET closed_at = ? WHERE id = ?').run(nowSeconds, id);
    closes.push(close);
  }
  return closes;
}
