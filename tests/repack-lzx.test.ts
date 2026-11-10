/**
 * Two bugs in how repackLzxToLha() invoked `lha` on the extracted file
 * list, both found while repacking real archives:
 *  - it built a shell command string by concatenating filenames into
 *    `sh -c "lha c ... <names>"`, escaping only double-quotes - a 1990s
 *    Amiga filename can contain almost any byte, and a backtick or
 *    `$(...)` corrupts the command or executes as a shell substitution;
 *  - even after that fix, a filename starting with '-' ("-BRD-.TXT") gets
 *    read by lha's own argument parser as an option flag, not a name.
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

  it('prefixes a filename starting with "-" so lha does not read it as an option', () => {
    // Same guard lha-member-delete.ts already needs for the same binary:
    // a leading '-' makes lha's own argument parser treat "-BRD-.TXT" as
    // a flag, not a filename, and the whole invocation fails with a
    // usage error - the archive genuinely has a member named that.
    (childProcess.spawnSync as jest.Mock).mockImplementation((bin: string) => {
      if (bin.endsWith('unlzx')) return { status: 0, stdout: '', stderr: '' };
      if (bin === 'find') return { status: 0, stdout: './-BRD-.TXT\n', stderr: '' };
      if (bin.endsWith('lha')) return { status: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected spawnSync call: ${bin}`);
    });

    repackLzxToLha('/data/Archives/AmiExpress/AHEVSTAT.LZX');

    const [, args] = (childProcess.spawnSync as jest.Mock).mock.calls.find(([bin]) => bin.endsWith('lha'));
    expect(args).not.toContain('-BRD-.TXT');
    expect(args).toContain('./-BRD-.TXT');
  });
});
