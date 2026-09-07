/**
 * Links: which boards report for a player.
 *
 * A link is (board, player). It is made at the board's ACHIEVE door with a
 * single-use code the player read out of a mail (or out of the previous
 * link's response), and it is what lets that board's key post events for
 * that address - without it every event is `not_linked`.
 *
 * THE BOARD IS THE KEY'S BOARD. No route here takes a board id in the body:
 * a board links itself and unlinks itself, and a key can no more unlink a
 * rival than it can mint one. Unlinking takes no code at all, because the
 * player is standing at that board's door, which is the proof.
 *
 * Linking appends the server's own `meta.link` event (type 'meta.link', key
 * <board id>), which is what makes the boards.linked.* achievements
 * reachable. Unlinking does not remove it: the player DID link that board,
 * and a rule about how many boards you have linked is not a rule about how
 * many you are linked to right now. Its ref is deterministic
 * (<board>:meta.link:<player>), so linking the same board a second time -
 * after an unlink - is a duplicate by construction and folds nothing.
 */
import type Database from 'better-sqlite3';
import { SurfaceError } from './errors';
import { recordEvent } from './counters';
import { evaluate } from './engine';
import { findPlayerByEmail, issueCode, spendCode } from './players';
import type { PlayerRow } from './players';
import type { LinkResponse, RotateLinkResponse } from '../../contract/achievement-types';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Every board currently linked to the player, sorted. */
export function linkedBoards(db: Database.Database, playerId: number): string[] {
  return (
    db.prepare('SELECT board_id FROM links WHERE player_id = ? ORDER BY board_id').all(playerId) as {
      board_id: string;
    }[]
  ).map((r) => r.board_id);
}

export function isLinked(db: Database.Database, boardId: string, playerId: number): boolean {
  return (
    db.prepare('SELECT 1 FROM links WHERE board_id = ? AND player_id = ?').get(boardId, playerId) !==
    undefined
  );
}

/**
 * The player a link route is about, or the refusal.
 *
 * An unknown address is `bad_code`, exactly as the verify route answers it:
 * a link route must not become a register of who has signed up. Only a
 * player who exists AND is verified gets as far as having their code read.
 */
function requireVerified(db: Database.Database, email: string): PlayerRow {
  const player = findPlayerByEmail(db, email);
  if (!player) {
    throw new SurfaceError('bad_code', 400, 'that code is not the one this address is waiting for');
  }
  if (player.verified_at === null) {
    throw new SurfaceError('unverified_player', 403, 'verify the address before linking a board');
  }
  return player;
}

function freshLinkCode(db: Database.Database, playerId: number, now: number): RotateLinkResponse {
  const issued = issueCode(db, playerId, 'link', now);
  return { linkCode: issued.code, linkCodeExpiresAt: new Date(issued.expiresAt * 1000).toISOString() };
}

/**
 * Link the key's board. Single-use code in, the NEXT code out.
 *
 * An already-linked board is an idempotent success that changes nothing -
 * the code is not spent, no event is appended, and no fresh code is issued,
 * because the one the player holds is still theirs to use elsewhere.
 */
export function linkBoard(
  db: Database.Database,
  boardId: string,
  email: string,
  code: string,
  now: number = nowSeconds()
): LinkResponse {
  const player = requireVerified(db, email);
  if (isLinked(db, boardId, player.id)) {
    return { linked: true, boards: linkedBoards(db, player.id) };
  }

  spendCode(db, player, 'link', code, now);
  db.prepare('INSERT INTO links (board_id, player_id, linked_at) VALUES (?, ?, ?)').run(
    boardId,
    player.id,
    now
  );
  const appended = recordEvent(db, {
    boardId,
    ref: `${boardId}:meta.link:${player.id}`,
    playerId: player.id,
    type: 'meta.link',
    key: boardId,
    value: 1,
    at: now,
    receivedAt: now,
    clamped: false,
  });
  // The link is an event like any other, so the rules that read it run
  // here: boards.linked.2/5/10 unlock at the link, not at the next message.
  // The link response has no unlocks field (the contract is frozen); the
  // unlock is in the profile, where the door shows it.
  if (appended) evaluate(db, [player.id], ['meta.link'], boardId, now);

  return { linked: true, boards: linkedBoards(db, player.id), ...freshLinkCode(db, player.id, now) };
}

/**
 * Unlink the key's board, and only it. No code. Unlocks stay: they record
 * the board they were earned on, and unlinking is not un-earning.
 *
 * An unknown address, or one this board never linked, is the same 200 as a
 * successful unlink - the state the caller asked for is the state they get,
 * and the response says nothing about whether the address exists.
 */
export function unlinkBoard(db: Database.Database, boardId: string, email: string): LinkResponse {
  const player = findPlayerByEmail(db, email);
  if (!player) return { linked: false, boards: [] };
  db.prepare('DELETE FROM links WHERE board_id = ? AND player_id = ?').run(boardId, player.id);
  return { linked: false, boards: linkedBoards(db, player.id) };
}

/**
 * A new link code for a player whose last one expired before they reached
 * the next board. The expired code is the proof of identity here - it is
 * checked against the hash, but its age is not held against it. A code that
 * was SPENT on a link is not accepted: that response already carried the
 * next one.
 */
export function rotateLinkCode(
  db: Database.Database,
  email: string,
  code: string,
  now: number = nowSeconds()
): RotateLinkResponse {
  const player = requireVerified(db, email);
  spendCode(db, player, 'link', code, now, { allowExpired: true });
  return freshLinkCode(db, player.id, now);
}
