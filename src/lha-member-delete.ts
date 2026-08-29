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
  stdout: string;
  stderr: string;
};

const defaultRunner: ArchiveRunner = (bin, args) => {
  console.log(`[lha-debug] running ${bin} with args ${JSON.stringify(args)}`);
  const r: SpawnSyncReturns<string> = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' },
  });
  console.log(`[lha-debug] result status: ${r.status}, signal: ${r.signal}, stderr: ${r.stderr?.slice(0, 200)}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** The archiver to use, or null when none is installed. */
export function findArchiverBinary(existsSync: (p: string) => boolean = fs.existsSync): string | null {
  const override = process.env.ARCHIVER_COMMAND;
  if (override && existsSync(override)) return override;
  for (const candidate of ['/opt/homebrew/bin/7z', '/usr/bin/7z', '/usr/local/bin/lha', '/usr/bin/lha']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface MemberDeleteCapability {
  ok: boolean;
  reason?: string;
}

/**
 * Whether members can be removed from this archive in place.
 */
export function canDeleteMembers(
  archivePath: string,
  binary: string | null = findArchiverBinary()
): MemberDeleteCapability {
  const ext = path.extname(archivePath).toLowerCase();
  // lha CLI: only supports .lha / .lzh. 7z supports those plus .zip and
  // .7z. Pick the supported set per binary.
  const is7z = !!binary && (binary.endsWith('7z') || binary.includes('/7z'));
  const supported = is7z
    ? new Set(['.lha', '.lzh', '.zip', '.7z'])
    : new Set(['.lha', '.lzh']);
  if (!supported.has(ext)) {
    return {
      ok: false,
      reason: ext === '.lzx'
        ? 'LZX archives cannot be rewritten here: this server can read LZX but has no LZX writer.'
        : `Unsupported archive format for in-place editing: ${ext || '(none)'}`,
    };
  }
  if (!binary) {
    return { ok: false, reason: 'No archiver binary available on this server.' };
  }
  return { ok: true };
}

export interface MemberDeleteResult {
  ok: boolean;
  removed: number;
  reason?: string;
}

/**
 * Removes `members` from `archivePath`.
 */
export function deleteMembers(
  archivePath: string,
  members: string[],
  opts: { binary?: string | null; runner?: ArchiveRunner } = {}
): MemberDeleteResult {
  const binary = opts.binary === undefined ? findArchiverBinary() : opts.binary;
  const runner = opts.runner ?? defaultRunner;

  const capability = canDeleteMembers(archivePath, binary);
  if (!capability.ok) {
    return { ok: false, removed: 0, reason: capability.reason };
  }
  if (members.length === 0) {
    return { ok: true, removed: 0 };
  }

  // 7z uses "d" to delete, just like lha. Filenames starting with `-` would
  // be parsed by lha as options (exit 2 + usage message); prefix with `./`
  // to force positional interpretation.
  const safeMembers = members.map((m) => (m.startsWith('-') ? `./${m}` : m));
  const useLha = binary!.endsWith('lha') || binary!.includes('/lha');
  // 7z needs a different syntax for zip: `7z d archive.zip member` works
  // for lha, but for zip 7z needs `-bb` to print byte-level detail and
  // `-sccUTF-8` for utf-8 output, plus `7z d` exits 1 on warnings
  // (like "no files matched") so we accept that. Some 7z builds also
  // want `-y` to auto-confirm the delete.
  const is7zDelete = !useLha;
  const args = is7zDelete
    ? ['d', '-y', '-bb0', '-sccUTF-8', archivePath, ...safeMembers]
    : ['dq', '--archive-kanji-code=latin1', '--system-kanji-code=utf8', archivePath, ...safeMembers];
  // First try: explicit latin1/utf8 encoding flags (correct for Amiga archives).
  // Fallback: 'cap' encoding which doesn't need iconv - works on filenames
  // whose bytes aren't valid in any standard 8-bit encoding.
  const fallbackArgs = useLha
    ? ['dq', '--archive-kanji-code=cap', '--system-kanji-code=utf8', archivePath, ...safeMembers]
    : args;
  let result = runner(binary as string, args);
  if (!is7zDelete && result.status !== 0 && /iconv/.test(result.stderr || '')) {
    result = runner(binary as string, fallbackArgs);
  }
  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || '').trim().slice(0, 300);
    return {
      ok: false,
      removed: 0,
      reason: `archiver (${binary}) exited ${result.status ?? 'null'}${output ? ': ' + output : ''}`,
    };
  }

  return { ok: true, removed: members.length };
}
