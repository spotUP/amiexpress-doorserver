/**
 * Configuration for the releases surface (the AquaScan file-listing database).
 *
 * Same shape as the achievements surface, minus mail: unset RELEASES_DB
 * disables the surface entirely (the door repo is unaffected, one [INFO]
 * line); set, it must point inside an existing directory, and the file is
 * created on first open. There is no half-configured state to fail on.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ConfigError } from '../config';

export interface ReleasesConfig {
  /** RELEASES_DB - the THIRD database file, never doors.db. */
  dbPath: string;
}

export function loadReleasesConfig(env: NodeJS.ProcessEnv = process.env): ReleasesConfig | null {
  const raw = env.RELEASES_DB?.trim();
  if (!raw) return null;
  const dir = path.dirname(raw);
  if (!fs.existsSync(dir)) {
    throw new ConfigError(
      `RELEASES_DB points inside ${dir}, which does not exist; create the directory first`
    );
  }
  return { dbPath: raw };
}
