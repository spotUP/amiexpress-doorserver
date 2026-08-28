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

function run(bin: string, args: string[], cwd: string): { ok: boolean; stderr: string } {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  return { ok: r.status === 0, stderr: r.stderr ?? '' };
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

    // Collect extracted files (skip any directories unlzx created)
    const files = fs.readdirSync(tmpDir).filter((f) => {
      const fp = path.join(tmpDir, f);
      return fs.statSync(fp).isFile();
    });
    if (files.length === 0) {
      return { ok: false, error: 'unlzx extracted no files' };
    }

    // Build output path: same name but .lha extension
    const base = path.basename(archivePath, path.extname(archivePath));
    const outputPath = path.join(path.dirname(archivePath), `${base}.lha`);

    // Repack as LHA
    const pack = run(LHA, ['a64', '-o1', '-r', outputPath, ...files], tmpDir);
    if (!pack.ok) {
      return { ok: false, error: `lha failed: ${pack.stderr.trim().slice(0, 200)}` };
    }

    return { ok: true, outputPath };
  } finally {
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
