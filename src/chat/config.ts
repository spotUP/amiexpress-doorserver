/**
 * The chat surface's limits, in one object, and its clock.
 *
 * The chat surface has no database of its own: it shares achievements.db and
 * the board registry with its siblings (migration step 2). The defaults are
 * CHAT_LIMITS from the contract; only a handful are tunable from the
 * environment, which is also what lets a test run a short poll.
 */
import type Database from 'better-sqlite3';
import { CHAT_LIMITS } from '../../contract/chat-types';

export interface ChatConfig {
  pollMaxWaitSeconds: number;
  pollDefaultWaitSeconds: number;
  sessionTtlSeconds: number;
  heldPollsPerBoard: number;
  sessionsPerBoard: number;
  eventsKept: number;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadChatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  const pollMax = positiveInt(env.CHAT_POLL_MAX_WAIT, CHAT_LIMITS.pollMaxWaitSeconds);
  return {
    pollMaxWaitSeconds: pollMax,
    pollDefaultWaitSeconds: Math.min(CHAT_LIMITS.pollDefaultWaitSeconds, pollMax),
    sessionTtlSeconds: positiveInt(env.CHAT_SESSION_TTL, CHAT_LIMITS.sessionTtlSeconds),
    heldPollsPerBoard: positiveInt(env.CHAT_MAX_HELD_POLLS, CHAT_LIMITS.heldPollsPerBoard),
    sessionsPerBoard: CHAT_LIMITS.sessionsPerBoard,
    eventsKept: CHAT_LIMITS.eventsKept,
  };
}

let clock: () => number = () => Math.floor(Date.now() / 1000);

/** Epoch seconds. Every timestamp the chat surface writes comes from here. */
export function nowSec(): number {
  return clock();
}

export function _setChatClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Math.floor(Date.now() / 1000));
}

/** Seconds a member stays active after typing or sending: the admin panel's setting, else CHAT_ACTIVE_WINDOW, else the contract default. */
export function activeWindowSeconds(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM chat_settings WHERE key = 'active_window_seconds'").get() as { value: string } | undefined;
  return positiveInt(row?.value, positiveInt(process.env.CHAT_ACTIVE_WINDOW, CHAT_LIMITS.activeWindowSeconds));
}

/** Store the admin panel's active window; null clears it back to CHAT_ACTIVE_WINDOW or the default. */
export function setActiveWindowSeconds(db: Database.Database, seconds: number | null): void {
  if (seconds === null) db.prepare("DELETE FROM chat_settings WHERE key = 'active_window_seconds'").run();
  else db.prepare("INSERT INTO chat_settings (key, value) VALUES ('active_window_seconds', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(seconds));
}
