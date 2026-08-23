/**
 * Configuration for the door server.
 *
 * Every path is explicit. The BBS's resolveArchiveRoot() had a fallback
 * chain ending in a hardcoded developer path; a server that silently serves
 * the wrong corpus - or an empty catalog - publishes a valid revision and
 * poisons every client's cache. So: configured, or refuse to start.
 */
import * as fs from 'fs';

export class ConfigError extends Error {}

export interface AdminKey {
  label: string;
  key: string;
}

export interface ServerConfig {
  dbPath: string;
  archivesRoot: string;
  port: number;
  adminKeys: AdminKey[];
}

const DEFAULT_PORT = 3010;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new ConfigError(`${name} is not set; the door server refuses to start without it`);
  }
  return value;
}

function mustExist(name: string, value: string): string {
  if (!fs.existsSync(value)) {
    throw new ConfigError(`${name} points at ${value}, which does not exist`);
  }
  return value;
}

function parseAdminKeys(raw: string | undefined): AdminKey[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const idx = pair.indexOf(':');
      if (idx <= 0 || idx === pair.length - 1) {
        throw new ConfigError(`DOORSERVER_ADMIN_KEYS entry "${pair}" is not <label>:<key>`);
      }
      return { label: pair.slice(0, idx), key: pair.slice(idx + 1) };
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dbPath = mustExist('DOORSERVER_DB', required(env, 'DOORSERVER_DB'));
  const archivesRoot = mustExist('DOOR_ARCHIVES_ROOT', required(env, 'DOOR_ARCHIVES_ROOT'));
  const port = env.PORT ? Number(env.PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    throw new ConfigError(`PORT is "${env.PORT}", which is not a usable port number`);
  }
  return { dbPath, archivesRoot, port, adminKeys: parseAdminKeys(env.DOORSERVER_ADMIN_KEYS) };
}
