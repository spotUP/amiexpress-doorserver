/**
 * The ZIP reader (src/archive-reader.ts's readZipContents) has no npm
 * dependency to build test fixtures with either, so this file constructs
 * genuine ZIP archives by hand - a local file header + data per member,
 * a central directory, and an End Of Central Directory record - the same
 * three pieces any real zip tool writes. CRC32 fields are left at 0
 * throughout: the reader never validates them (matching the LHA reader's
 * own "never throws, extraction only" contract), so a fixture builder that
 * computed them correctly would be testing a property this code doesn't
 * claim to have.
 */
import * as zlib from 'zlib';
import { readZipContents } from '../src/archive-reader';

interface ZipMemberInput {
  name: string;
  data: Buffer;
  method: 0 | 8; // 0 = stored, 8 = deflate
}

function buildZip(members: ZipMemberInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const m of members) {
    const nameBytes = Buffer.from(m.name, 'latin1');
    const payload = m.method === 8 ? zlib.deflateRawSync(m.data) : m.data;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(m.method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (unvalidated by the reader)
    localHeader.writeUInt32LE(payload.length, 18); // compressed size
    localHeader.writeUInt32LE(m.data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    const localHeaderOffset = offset;
    const localEntry = Buffer.concat([localHeader, nameBytes, payload]);
    localParts.push(localEntry);
    offset += localEntry.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(m.method, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(payload.length, 20); // compressed size
    centralHeader.writeUInt32LE(m.data.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(localHeaderOffset, 42);

    centralParts.push(Buffer.concat([centralHeader, nameBytes]));
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(members.length, 8); // entries on this disk
  eocd.writeUInt16LE(members.length, 10); // total entries
  eocd.writeUInt32LE(centralSection.length, 12); // central dir size
  eocd.writeUInt32LE(localSection.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localSection, centralSection, eocd]);
}

describe('readZipContents', () => {
  it('reads a stored (uncompressed) FILE_ID.DIZ', () => {
    const zip = buildZip([
      { name: 'FILE_ID.DIZ', data: Buffer.from('A great new door.\r\n', 'latin1'), method: 0 },
      { name: 'UP-PL10.EXE', data: Buffer.from('binary', 'latin1'), method: 0 },
    ]);
    const result = readZipContents(zip);
    expect(result.fileIdDiz).toBe('A great new door.\r\n');
    expect(result.files).toEqual([
      { path: 'FILE_ID.DIZ', size: 19 },
      { path: 'UP-PL10.EXE', size: 6 },
    ]);
  });

  it('reads a deflated (compressed) FILE_ID.DIZ', () => {
    const dizText = 'Compressed description text that deflate will actually shrink.\r\n'.repeat(3);
    const zip = buildZip([{ name: 'file_id.diz', data: Buffer.from(dizText, 'latin1'), method: 8 }]);
    const result = readZipContents(zip);
    expect(result.fileIdDiz).toBe(dizText);
  });

  it('picks the largest doc file, matching the LHA reader\'s own rule', () => {
    const zip = buildZip([
      { name: 'short.readme', data: Buffer.from('short', 'latin1'), method: 0 },
      { name: 'full.doc', data: Buffer.from('a much longer document body', 'latin1'), method: 0 },
    ]);
    const result = readZipContents(zip);
    expect(result.docFilename).toBe('full.doc');
    expect(result.doc).toBe('a much longer document body');
  });

  it('skips directory entries (trailing slash)', () => {
    const zip = buildZip([
      { name: 'Docs/', data: Buffer.alloc(0), method: 0 },
      { name: 'Docs/readme.txt', data: Buffer.from('hi', 'latin1'), method: 0 },
    ]);
    const result = readZipContents(zip);
    expect(result.files).toEqual([{ path: 'Docs/readme.txt', size: 2 }]);
  });

  it('returns empty, never throws, on a truncated file', () => {
    const zip = buildZip([{ name: 'FILE_ID.DIZ', data: Buffer.from('x', 'latin1'), method: 0 }]);
    const truncated = zip.subarray(0, zip.length - 10);
    expect(() => readZipContents(truncated)).not.toThrow();
    const result = readZipContents(truncated);
    expect(result).toEqual({ files: [], fileIdDiz: null, docFilename: null, doc: null });
  });

  it('returns empty, never throws, on garbage bytes', () => {
    const garbage = Buffer.from('not a zip file at all, just plain text padding out past 22 bytes');
    expect(() => readZipContents(garbage)).not.toThrow();
    expect(readZipContents(garbage)).toEqual({ files: [], fileIdDiz: null, docFilename: null, doc: null });
  });

  it('returns empty, never throws, on an empty buffer', () => {
    expect(() => readZipContents(Buffer.alloc(0))).not.toThrow();
    expect(readZipContents(Buffer.alloc(0))).toEqual({ files: [], fileIdDiz: null, docFilename: null, doc: null });
  });

  it('a member with an unsupported compression method is listed but not read', () => {
    // Method 12 (bzip2) is a real PKZIP-registered method this reader does
    // not implement - proves an unreadable member degrades to "listed,
    // size known, content unavailable" rather than aborting the archive.
    const zip = buildZip([
      { name: 'FILE_ID.DIZ', data: Buffer.from('readable', 'latin1'), method: 12 as unknown as 0 },
    ]);
    const result = readZipContents(zip);
    expect(result.files).toEqual([{ path: 'FILE_ID.DIZ', size: 8 }]);
    expect(result.fileIdDiz).toBeNull();
  });
});
