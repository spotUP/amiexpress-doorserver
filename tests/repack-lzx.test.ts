/**
 * repackLzxToLha() used to build a shell command string by concatenating
 * extracted filenames into `sh -c "lha c ... <names>"`, escaping only
 * double-quotes. Amiga filenames from a 1990s archive can contain almost
 * any byte - a backtick or `$(...)` in one would corrupt the command or
 * execute as a shell substitution. Verifies `lha` is now invoked directly
 * (spawnSync with an argv array, no shell), so such a filename reaches it
 * as a literal argument instead.
 */
import * as fs from 'fs';
import * as childProcess from 'child_process';

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  mkdtempSync: jest.fn(() => '/tmp/lzx-repack-test'),
  rmSync: jest.fn(),
}));

jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
}));

import { repackLzxToLha } from '../src/repack-lzx';

describe('repackLzxToLha', () => {
  const DANGEROUS_NAME = 'Docs/`rm -rf /`$(whoami).txt';

  beforeEach(() => {
    jest.clearAllMocks();
    (fs.existsSync as jest.Mock).mockReturnValue(true);
  });

  it('invokes lha with an argv array, not a shell string containing the filenames', () => {
    (childProcess.spawnSync as jest.Mock).mockImplementation((bin: string, args: string[]) => {
      if (bin.endsWith('unlzx')) return { status: 0, stdout: '', stderr: '' };
      if (bin === 'find') return { status: 0, stdout: `./${DANGEROUS_NAME}\n`, stderr: '' };
      if (bin.endsWith('lha')) {
        // The real binary would create outputPath; the mock stands in.
        (fs.existsSync as jest.Mock).mockReturnValue(true);
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected spawnSync call: ${bin} ${JSON.stringify(args)}`);
    });

    const result = repackLzxToLha('/data/Archives/AmiExpress/WEIRD.LZX');

    expect(result.ok).toBe(true);
    const lhaCall = (childProcess.spawnSync as jest.Mock).mock.calls.find(([bin]) => bin.endsWith('lha'));
    expect(lhaCall).toBeDefined();
    const [, args] = lhaCall;
    // No shell in the middle: 'sh' is never invoked, and the dangerous
    // filename is one literal argv element, not part of a command string.
    expect(childProcess.spawnSync).not.toHaveBeenCalledWith('sh', expect.anything(), expect.anything());
    expect(args).toContain(DANGEROUS_NAME);
    expect(args.some((a: string) => a.includes('lha c'))).toBe(false);
  });
});
