/**
 * The requests surface has no config of its own.
 *
 * It reuses the achievements config verbatim: the same achievements.db holds
 * both the `boards` registry it authenticates against and the `requests`
 * tables it reads and writes (migration step 1). A second config object would
 * be a second place for the database path to be wrong. This module exists so
 * that src/requests/ reads as a self-contained surface - it names the one
 * dependency it has on its sibling and nothing more.
 */
import type { AchievementsConfig } from '../achievements/config';
import { withAchievementsDb } from '../achievements/db';

export type RequestsConfig = AchievementsConfig;

/** Open achievements.db, run fn, close - the requests store's only handle. */
export const withRequestsDb = withAchievementsDb;
