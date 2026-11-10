// Ported from amiexpress-web/web/backend/src/doors/door-repo-checksums.ts
import * as crypto from 'crypto';
import * as fs from 'fs';

export interface ArchiveChecksums { md5: string; sha256: string; }
const cache = new Map<string, ArchiveChecksums>();

/**
 * Chunk size for hashing. Large enough that syscall overhead disappears,
 * small enough that a dozen concurrent requests cost single megabytes.
 */
const CHUNK = 256 * 1024;

/**
 * Both digests of an archive, hashed in CHUNKS rather than by reading the
 * whole file into memory.
 *
 * readFileSync held the entire archive as one Buffer - and this runs on the
 * same request that has already extracted every member into buffers of its
 * own, so the peak was the archive plus its own contents. The doorserver
 * died of that three times on 2026-08-31, heap climbing to ~1.9 GB
 * ("Ineffective mark-compacts near heap limit"), the first crash seven
 * minutes after the release that added a re-digest to the classify path.
 *
 * Chunked hashing is what this should have been from the start: identical
 * digests, a peak of one chunk, and no change to the contract. Deliberately
 * still SYNCHRONOUS - freshArchiveFiles and the indexer both are, and making
 * them async to save memory they no longer use would be a much larger change
 * for nothing further.
 */
export function getArchiveChecksums(absPath: string): ArchiveChecksums {
  const st = fs.statSync(absPath); // throws if missing — loud by design
  const key = `${absPath}:${st.mtimeMs}:${st.size}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const md5 = crypto.createHash('md5');
  const sha256 = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK);
  const fd = fs.openSync(absPath, 'r');
  try {
    for (;;) {
      const read = fs.readSync(fd, buf, 0, CHUNK, null);
      if (read <= 0) break;
      const chunk = buf.subarray(0, read);
      md5.update(chunk);
      sha256.update(chunk);
    }
  } finally {
    fs.closeSync(fd);
  }

  const result: ArchiveChecksums = {
    md5: md5.digest('hex'),
    sha256: sha256.digest('hex'),
  };
  cache.set(key, result);
  return result;
}

export function _clearChecksumCacheForTests(): void { cache.clear(); }
