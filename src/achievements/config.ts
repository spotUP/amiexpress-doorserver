/**
 * Configuration for the achievements surface.
 *
 * Two rules, and they pull in opposite directions on purpose (D7):
 *
 * - **Unset `ACHIEVEMENTS_DB` disables the surface entirely.** A sysop who
 *   never configured achievements still gets a door server that serves the
 *   door repo, and one [INFO] line saying the surface is off. Refusing to
 *   start would make an optional feature mandatory for every existing
 *   deployment.
 * - **Set-but-incomplete is a startup failure**, in the fail-loud style of
 *   src/config.ts. A /players endpoint that takes an email address and
 *   cannot send a code is worse than one that is absent, because the player
 *   has already given their address. A half-mounted surface would also
 *   reproduce the "a 404 means two different things" complaint
 *   docs/DOOR-REPO-API.md already makes about the door repo.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ConfigError } from '../config';

export interface AchievementsConfig {
  /** ACHIEVEMENTS_DB - the SECOND database file, never doors.db. */
  dbPath: string;
  /** ACHIEVEMENTS_SMTP_URL - where verification codes are posted. */
  smtpUrl: string;
  /** ACHIEVEMENTS_MAIL_FROM - the envelope sender. */
  mailFrom: string;
  /** ACHIEVEMENTS_BASE_URL - for the mail body only, never for routing. */
  publicBaseUrl: string;
}

/**
 * The base URL only ever appears inside a verification mail, so a wrong one
 * costs a reader one confusing line - not a broken surface. It therefore
 * carries a default rather than being a fourth way to fail startup, and the
 * default is the same value docker-compose.yml substitutes.
 */
const DEFAULT_BASE_URL = 'https://doors.uprough.net';

function requiredWhenEnabled(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `${name} is not set, but ACHIEVEMENTS_DB is; the achievements surface refuses to start without mail`
    );
  }
  return value;
}

/**
 * Returns null when the surface is switched off, the config when it is on,
 * and throws ConfigError when it is half-configured.
 *
 * The DIRECTORY of ACHIEVEMENTS_DB must exist; the file need not (D6).
 * src/config.ts's mustExist() refuses a missing path, which is right for a
 * seeded catalog volume and wrong for a database that is born empty -
 * better-sqlite3 creates the file and the migrations fill it.
 */
export function loadAchievementsConfig(env: NodeJS.ProcessEnv = process.env): AchievementsConfig | null {
  const dbPath = env.ACHIEVEMENTS_DB?.trim();
  if (!dbPath) {
    return null;
  }
  const dir = path.dirname(path.resolve(dbPath));
  if (!fs.existsSync(dir)) {
    throw new ConfigError(`ACHIEVEMENTS_DB points at ${dbPath}, whose directory ${dir} does not exist`);
  }
  return {
    dbPath,
    smtpUrl: requiredWhenEnabled(env, 'ACHIEVEMENTS_SMTP_URL'),
    mailFrom: requiredWhenEnabled(env, 'ACHIEVEMENTS_MAIL_FROM'),
    publicBaseUrl: env.ACHIEVEMENTS_BASE_URL?.trim() || DEFAULT_BASE_URL,
  };
}
