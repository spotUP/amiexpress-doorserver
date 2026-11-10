// tests/config.test.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, ConfigError } from '../src/config';

describe('loadConfig', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-'));
    fs.writeFileSync(path.join(tmp, 'doors.db'), '');
    fs.mkdirSync(path.join(tmp, 'Archives'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads db path, archives root and port from the environment', () => {
    const cfg = loadConfig({
      DOORSERVER_DB: path.join(tmp, 'doors.db'),
      DOOR_ARCHIVES_ROOT: path.join(tmp, 'Archives'),
      PORT: '3010',
    });
    expect(cfg.dbPath).toBe(path.join(tmp, 'doors.db'));
    expect(cfg.archivesRoot).toBe(path.join(tmp, 'Archives'));
    expect(cfg.port).toBe(3010);
  });

  it('defaults the port to 3010 when PORT is unset', () => {
    const cfg = loadConfig({
      DOORSERVER_DB: path.join(tmp, 'doors.db'),
      DOOR_ARCHIVES_ROOT: path.join(tmp, 'Archives'),
    });
    expect(cfg.port).toBe(3010);
  });

  it('refuses to start when DOORSERVER_DB is missing', () => {
    expect(() => loadConfig({ DOOR_ARCHIVES_ROOT: path.join(tmp, 'Archives') }))
      .toThrow(ConfigError);
  });

  it('refuses to start when the archives root does not exist', () => {
    expect(() => loadConfig({
      DOORSERVER_DB: path.join(tmp, 'doors.db'),
      DOOR_ARCHIVES_ROOT: path.join(tmp, 'nope'),
    })).toThrow(/DOOR_ARCHIVES_ROOT/);
  });

  it('parses labelled admin keys', () => {
    const cfg = loadConfig({
      DOORSERVER_DB: path.join(tmp, 'doors.db'),
      DOOR_ARCHIVES_ROOT: path.join(tmp, 'Archives'),
      DOORSERVER_ADMIN_KEYS: 'spot:abc123,phantasm:def456',
    });
    expect(cfg.adminKeys).toEqual([
      { label: 'spot', key: 'abc123' },
      { label: 'phantasm', key: 'def456' },
    ]);
  });

  it('trims whitespace around the key after the colon', () => {
    const cfg = loadConfig({
      DOORSERVER_DB: path.join(tmp, 'doors.db'),
      DOOR_ARCHIVES_ROOT: path.join(tmp, 'Archives'),
      DOORSERVER_ADMIN_KEYS: 'spot: secret',
    });
    expect(cfg.adminKeys).toEqual([{ label: 'spot', key: 'secret' }]);
  });

  it('yields no admin keys when the variable is unset', () => {
    const cfg = loadConfig({
      DOORSERVER_DB: path.join(tmp, 'doors.db'),
      DOOR_ARCHIVES_ROOT: path.join(tmp, 'Archives'),
    });
    expect(cfg.adminKeys).toEqual([]);
  });
});
