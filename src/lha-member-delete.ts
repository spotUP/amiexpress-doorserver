/**
 * Delete members from an LHA/LZH archive IN PLACE, preserving the format.
 *
 * Ported from amiexpress-web/web/backend/src/doors/lha-member-delete.ts.
 * The real `lha` CLI can remove members in place (`lha d <archive> <member>`),
 * which is all "strip the ads out of the published archive" needs. LZX is
 * deliberately unsupported: no LZX writer exists.
 *
 * Nothing here builds a shell command string. The archive path and every
 * member name come from the catalog, and real scene filenames contain '$',
 * '&' and '!' — they are passed as argv entries so the shell never sees them.
 */
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Injectable for tests: runs the archiver and reports how it went. */
export type ArchiveRunner = (bin: string, args: string[]) => {
  status: number | null;
  stderr: string;
};

const defaultRunner: ArchiveRunner = (bin, args) => {
  console.log(`[lha-debug] running ${bin} with args ${JSON.stringify(args)}`);
  const r: SpawnSyncReturns<string> = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, LC_ALL: 'C' },
  });
  console.log(`[lha-debug] result status: ${r.status}, stderr: ${r.stderr?.slice(0, 100)}`);
  return { status: r.status, stderr: r.stderr ?? '' };
};

/** The archiver to use, or null when none is installed. */
export function findLhaBinary(existsSync: (p: string) => boolean = fs.existsSync): string | null {
  const override = process.env.LHA_COMMAND;
  if (override && existsSync(override)) return override;
  for (const candidate of ['/usr/local/bin/lha', '/usr/bin/lha', '/opt/homebrew/bin/lha']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface MemberDeleteCapability {
  ok: boolean;
  reason?: string;
}

/**
 * Whether members can be removed from this archive in place. Format is
 * checked before tooling so the message names the real obstacle.
 */
export function canDeleteMembers(
  archivePath: string,
  binary: string | null = findLhaBinary()
): MemberDeleteCapability {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext !== '.lha' && ext !== '.lzh') {
    return {
      ok: false,
      reason: ext === '.lzx'
        ? 'LZX archives cannot be rewritten here: this server can read LZX but has no LZX writer.'
        : `Unsupported archive format for in-place editing: ${ext || '(none)'}`,
    };
  }
  if (!binary) {
    return { ok: false, reason: 'No lha binary available on this server.' };
  }
  return { ok: true };
}

export interface MemberDeleteResult {
  ok: boolean;
  removed: number;
  reason?: string;
}

/**
 * Removes `members` from `archivePath`. Returns how many the archiver was
 * asked to remove; a member that was already absent is not an error.
 */
export function deleteMembers(
  archivePath: string,
  members: string[],
  opts: { binary?: string | null; runner?: ArchiveRunner } = {}
): MemberDeleteResult {
  const binary = opts.binary === undefined ? findLhaBinary() : opts.binary;
  const runner = opts.runner ?? defaultRunner;

  const capability = canDeleteMembers(archivePath, binary);
  if (!capability.ok) {
    return { ok: false, removed: 0, reason: capability.reason };
  }
  if (members.length === 0) {
    return { ok: true, removed: 0 };
  }

  const result = runner(binary as string, ['d', archivePath, ...members]);
  if (result.status !== 0) {
    return {
      ok: false,
      removed: 0,
      reason: `lha (${binary}) exited ${result.status ?? 'null'}: ${(result.stderr || '').trim().slice(0, 200)}`,
    };
  }

  return { ok: true, removed: members.length };
}
