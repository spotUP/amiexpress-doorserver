/**
 * GET and PATCH /players/<email> - the profile, from a linked board.
 *
 * GATED BY THE LINK, NOT BY THE PRIVACY FLAG. A board that is not linked to
 * the address gets 403 not_linked whether the player is private or not,
 * and whether or not the player exists: this endpoint is not an address
 * oracle, and a private player is still a person standing at the door of a
 * board they chose to link.
 *
 * `progress` here is every achievement the player has moved toward and not
 * unlocked, closest first, capped at 200 - what the ACHIEVE door's progress
 * screen pages through. Hidden achievements the player has not unlocked
 * are omitted entirely: "you are 3/5 towards a secret" is the same leak as
 * naming it.
 */
import type Database from 'better-sqlite3';
import { SurfaceError } from './errors';
import { progressOf } from './engine';
import { isLinked } from './links';
import { findPlayerByEmail, HANDLE, handleOwner, playerProfile } from './players';
import type { PlayerRow } from './players';
import type { PlayerProfile, ProgressOut, Rule } from '../../contract/achievement-types';

export const MAX_PROFILE_PROGRESS = 200;

/** The player behind a profile route, or the one refusal it ever gives. */
export function requireLinkedPlayer(db: Database.Database, boardId: string, email: string): PlayerRow {
  const player = findPlayerByEmail(db, email);
  if (!player || !isLinked(db, boardId, player.id)) {
    throw new SurfaceError('not_linked', 403, 'this board is not linked to that address');
  }
  return player;
}

export function profileProgress(db: Database.Database, playerId: number): ProgressOut[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.rule FROM achievements a
        WHERE a.hidden = 0
          AND NOT EXISTS (SELECT 1 FROM unlocks u WHERE u.player_id = ? AND u.achievement_id = a.id)
        ORDER BY a.id`
    )
    .all(playerId) as { id: string; rule: string }[];
  const out: ProgressOut[] = [];
  for (const r of rows) {
    const p = progressOf(db, playerId, JSON.parse(r.rule) as Rule);
    if (p && p.have > 0) out.push({ id: r.id, have: p.have, need: p.need });
  }
  return out
    .sort((a, b) => b.have / b.need - a.have / a.need || a.id.localeCompare(b.id))
    .slice(0, MAX_PROFILE_PROGRESS);
}

export function readProfile(db: Database.Database, boardId: string, email: string): PlayerProfile {
  const player = requireLinkedPlayer(db, boardId, email);
  return { ...playerProfile(db, player), progress: profileProgress(db, player.id) };
}

export interface ProfilePatch {
  private?: boolean;
  handle?: string;
}

/** Only the player's own flags, only from a linked board. */
export function patchProfile(db: Database.Database, boardId: string, email: string, patch: ProfilePatch): PlayerProfile {
  const player = requireLinkedPlayer(db, boardId, email);
  if (patch.handle !== undefined) {
    const wanted = patch.handle.trim();
    if (!HANDLE.test(wanted)) {
      throw new SurfaceError('bad_handle', 400, 'a handle is 3 to 16 characters, starting with a letter or a digit');
    }
    const owner = handleOwner(db, wanted);
    if (owner !== null && owner !== player.id) {
      throw new SurfaceError('handle_taken', 409, 'that handle belongs to another player');
    }
    db.prepare('UPDATE players SET handle = ? WHERE id = ?').run(wanted, player.id);
    player.handle = wanted;
  }
  if (patch.private !== undefined) {
    db.prepare('UPDATE players SET private = ? WHERE id = ?').run(patch.private ? 1 : 0, player.id);
    player.private = patch.private ? 1 : 0;
  }
  return { ...playerProfile(db, player), progress: profileProgress(db, player.id) };
}
