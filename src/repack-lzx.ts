/**
 * Repack LZX archives to LHA format.
 *
 * The doorserver can read LHA natively but has no LZX decoder.  This module
 * shells out to `unlzx` (extract) and `lha` (repack) to convert LZX → LHA
 * in a temp directory, then replaces the original file.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const UNLZX = process.env.UNLZX_COMMAND || '/usr/local/bin/unlzx';
const LHA = process.env.LHA_COMMAND || '/usr/local/bin/lha';

export interface RepackResult {
  ok: boolean;
  outputPath?: string;
  error?: string;
}

function run(bin: string, args: string[], cwd: string): { ok: boolean; stderr: string; stdout: string } {
  const r = spawnSync(bin, args, { cwd, encoding: 'latin1', timeout: 120_000 });
  return { ok: r.status === 0, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

/**
 * Repack an LZX archive as LHA.  The output is written to the same directory
 * with a .lha extension.  The original file is left untouched; the caller
 * decides whether to replace it.
 */
export function repackLzxToLha(archivePath: string): RepackResult {
  if (!fs.existsSync(UNLZX)) {
    return { ok: false, error: `unlzx not found at ${UNLZX}` };
  }
  if (!fs.existsSync(LHA)) {
    return { ok: false, error: `lha not found at ${LHA}` };
  }
  if (!fs.existsSync(archivePath)) {
    return { ok: false, error: `archive not found: ${archivePath}` };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lzx-repack-'));
  try {
    // Extract LZX to temp dir
    const extract = run(UNLZX, [archivePath], tmpDir);
    if (!extract.ok) {
      return { ok: false, error: `unlzx failed: ${extract.stderr.trim().slice(0, 200)}` };
    }

    // Build file list via find (handles non-UTF8 filenames that break readdirSync)
    const findResult = run('find', ['.', '-type', 'f'], tmpDir);
    const fileList = findResult.stdout.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
    if (fileList.length === 0) {
      return { ok: false, error: 'unlzx extracted no files' };
    }

    // Build output path: same name but .lha extension
    const base = path.basename(archivePath, path.extname(archivePath));
    const outputPath = path.join(path.dirname(archivePath), `${base}.lha`);

    // Repack as LHA — shell expansion handles non-UTF8 filenames
    const quoted = fileList.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(' ');
    const pack = run('sh', ['-c', `${LHA} c "${outputPath}" ${quoted}`], tmpDir);
    if (!pack.ok || !fs.existsSync(outputPath)) {
      return { ok: false, error: `lha failed: ${(pack.stderr || pack.stdout).trim().slice(0, 200)}` };
    }

    return { ok: true, outputPath };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
