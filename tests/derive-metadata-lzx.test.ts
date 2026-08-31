/**
 * deriveMetadata() silently returned empty metadata for .lzx archives -
 * the kind===lha/zip ternary in submissions.ts had no lzx branch, even
 * though sniffArchive() correctly identifies lzx bytes and a real
 * readLzxContents() reader already exists. This blanked out name/
 * description/requires_bbs/file_id_diz for every .lzx door re-extracted
 * via the admin /reextract route (and the bulk stillEmpty fixer), even
 * when the archive carries a perfectly good FILE_ID.DIZ.
 */
import { readLzxContents } from '../src/archive-reader';

jest.mock('../src/archive-reader', () => {
  const actual = jest.requireActual('../src/archive-reader');
  return {
    ...actual,
    readLzxContents: jest.fn(),
  };
});

import { deriveMetadata } from '../src/submissions';

describe('deriveMetadata with an LZX archive', () => {
  it('reads the LZX archive instead of returning empty metadata', () => {
    const lzxBytes = Buffer.from('LZX archive bytes, contents irrelevant - reader is mocked', 'latin1');
    (readLzxContents as jest.Mock).mockReturnValue({
      files: [{ path: 'DOOR.EXE', size: 100 }, { path: 'FILE_ID.DIZ', size: 40 }],
      fileIdDiz: 'MyDoor v1.0\nRequires /X 4.x\n',
      docFilename: null,
      doc: null,
    });

    const derived = deriveMetadata(lzxBytes, 'MYDOOR.LZX', new Set());

    expect(readLzxContents).toHaveBeenCalledWith(lzxBytes);
    expect(derived.fileIdDiz).toBe('MyDoor v1.0\nRequires /X 4.x\n');
    expect(derived.requiresBbs).toBe('AmiExpress');
  });
});
