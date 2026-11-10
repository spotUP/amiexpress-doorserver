/**
 * Health line of the Discord bridge: one text file, rewritten after every
 * successful hub poll. The compose healthcheck runs this module as a script
 * (`node dist/src/discord-bridge/health.js <path> <maxAgeSeconds>`), which
 * exits 0 only when the line is fresh and the Discord gateway is ready.
 *
 * Line format: `seq=<n> gateway=<ready|down> at=<ISO time>`.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface HealthState {
  seq: number;
  gatewayReady: boolean;
  at: Date;
}

export function healthLine(h: HealthState): string {
  return `seq=${h.seq} gateway=${h.gatewayReady ? 'ready' : 'down'} at=${h.at.toISOString()}`;
}

/** Write through a temp file and rename, so the check never reads half a line. */
export function writeHealth(path: string, h: HealthState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${healthLine(h)}\n`);
  renameSync(tmp, path);
}

/** Null when healthy, else the reason. */
export function checkHealth(line: string, maxAgeSeconds: number, now: Date): string | null {
  const m = /^seq=(\d+) gateway=(ready|down) at=(\S+)$/.exec(line.trim());
  if (!m) return `unreadable health line: ${line.trim() || '(empty)'}`;
  const at = Date.parse(m[3]);
  if (Number.isNaN(at)) return `bad time in health line: ${m[3]}`;
  const age = (now.getTime() - at) / 1000;
  if (age > maxAgeSeconds) return `last hub poll ${Math.round(age)} s ago (limit ${maxAgeSeconds} s)`;
  if (m[2] !== 'ready') return 'Discord gateway is not ready';
  return null;
}

if (require.main === module) {
  const [path, maxAge] = process.argv.slice(2);
  let reason: string | null;
  try {
    reason = checkHealth(readFileSync(path ?? '', 'utf8'), Number(maxAge ?? 80), new Date());
  } catch (err) {
    reason = `no health file: ${(err as Error).message}`;
  }
  if (reason) {
    console.error(`[ERROR] ${reason}`);
    process.exit(1);
  }
  console.log('[OK] discord bridge healthy');
}
