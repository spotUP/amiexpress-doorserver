import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getArchiveChecksums, _clearChecksumCacheForTests } from '../src/checksums';

describe('getArchiveChecksums', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    _clearChecksumCacheForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorsrv-sum-'));
    file = path.join(dir, 'A.LHA');
    fs.writeFileSync(file, Buffer.from([0x00, 0xa1, 0xff, 0x41]));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('hashes the exact bytes on disk', () => {
    const buf = fs.readFileSync(file);
    expect(getArchiveChecksums(file)).toEqual({
      md5: crypto.createHash('md5').update(buf).digest('hex'),
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    });
  });

  it('recomputes after the file changes', () => {
    const first = getArchiveChecksums(file).md5;
    fs.writeFileSync(file, Buffer.from([0x01, 0x02]));
    expect(getArchiveChecksums(file).md5).not.toBe(first);
  });

  it('throws for a missing file rather than returning a fake digest', () => {
    expect(() => getArchiveChecksums(path.join(dir, 'gone.LHA'))).toThrow();
  });
});
