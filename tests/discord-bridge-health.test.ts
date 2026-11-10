import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkHealth, healthLine, writeHealth } from '../src/discord-bridge/health';

const at = new Date('2026-11-10T12:00:00.000Z');
const later = (s: number) => new Date(at.getTime() + s * 1000);

describe('discord bridge health', () => {
  it('formats and accepts a fresh line with a ready gateway', () => {
    const line = healthLine({ seq: 42, gatewayReady: true, at });
    expect(line).toBe('seq=42 gateway=ready at=2026-11-10T12:00:00.000Z');
    expect(checkHealth(line, 80, later(79))).toBeNull();
  });

  it.each([
    ['stale', healthLine({ seq: 1, gatewayReady: true, at }), 81, 'last hub poll 81 s ago (limit 80 s)'],
    ['gateway down', healthLine({ seq: 1, gatewayReady: false, at }), 1, 'Discord gateway is not ready'],
    ['empty', '', 1, 'unreadable health line: (empty)'],
    ['garbage', 'hello', 1, 'unreadable health line: hello'],
    ['bad time', 'seq=1 gateway=ready at=never', 1, 'bad time in health line: never'],
  ])('rejects %s', (_name, line, ageSeconds, reason) => {
    expect(checkHealth(line, 80, later(ageSeconds))).toBe(reason);
  });

  it('writes atomically and the script exits by verdict', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-health-'));
    const file = path.join(dir, 'h');
    const script = path.join(__dirname, '..', 'src', 'discord-bridge', 'health.ts');
    const run = () => {
      try {
        execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', script, file, '80'], { stdio: 'pipe' });
        return 0;
      } catch (err) {
        return (err as { status: number }).status;
      }
    };
    expect(run()).toBe(1);
    writeHealth(file, { seq: 3, gatewayReady: true, at: new Date() });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(run()).toBe(0);
    writeHealth(file, { seq: 3, gatewayReady: false, at: new Date() });
    expect(run()).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
