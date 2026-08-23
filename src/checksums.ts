// Ported from amiexpress-web/web/backend/src/doors/door-repo-checksums.ts
import * as crypto from 'crypto';
import * as fs from 'fs';

export interface ArchiveChecksums { md5: string; sha256: string; }
const cache = new Map<string, ArchiveChecksums>();

export function getArchiveChecksums(absPath: string): ArchiveChecksums {
  const st = fs.statSync(absPath); // throws if missing — loud by design
  const key = `${absPath}:${st.mtimeMs}:${st.size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const buf = fs.readFileSync(absPath);
  const result: ArchiveChecksums = {
    md5: crypto.createHash('md5').update(buf).digest('hex'),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
  cache.set(key, result);
  return result;
}

export function _clearChecksumCacheForTests(): void { cache.clear(); }
