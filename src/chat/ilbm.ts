/**
 * Small IFF ILBM decoder: BMHD, CMAP, CAMG, BODY with ByteRun1 or raw rows.
 * Handles 1-8 plane indexed pictures, EHB, HAM6/HAM8 and 24-bit. Returns
 * null for anything malformed or too large; never throws.
 */
export interface Rgb {
  w: number;
  h: number;
  rgb: Buffer;
}

const MAX_PIXELS = 16 * 1024 * 1024;

function unpackRow(src: Buffer, pos: number, out: Buffer): number {
  let o = 0;
  let p = pos;
  while (o < out.length) {
    if (p >= src.length) return -1;
    const n = src.readInt8(p);
    p += 1;
    if (n >= 0) {
      const len = n + 1;
      if (p + len > src.length || o + len > out.length) return -1;
      src.copy(out, o, p, p + len);
      p += len;
      o += len;
    } else if (n !== -128) {
      const len = 1 - n;
      if (p >= src.length || o + len > out.length) return -1;
      out.fill(src[p], o, o + len);
      p += 1;
      o += len;
    }
  }
  return p;
}

export function decodeIlbm(buf: Buffer): Rgb | null {
  try {
    if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'FORM' || buf.toString('latin1', 8, 12) !== 'ILBM') return null;
    let w = 0;
    let h = 0;
    let planes = 0;
    let masking = 0;
    let compression = 0;
    let cmap: Buffer | null = null;
    let camg = 0;
    let body: Buffer | null = null;
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('latin1', pos, pos + 4);
      const len = buf.readUInt32BE(pos + 4);
      const data = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + len));
      if (id === 'BMHD' && data.length >= 20) {
        w = data.readUInt16BE(0);
        h = data.readUInt16BE(2);
        planes = data[8];
        masking = data[9];
        compression = data[10];
      } else if (id === 'CMAP') cmap = data;
      else if (id === 'CAMG' && data.length >= 4) camg = data.readUInt32BE(0);
      else if (id === 'BODY') body = data;
      pos += 8 + len + (len & 1);
    }
    if (!w || !h || !body || w * h > MAX_PIXELS || compression > 1 || planes < 1 || planes > 32) return null;
    const deep = planes === 24 || planes === 32;
    if (!deep && planes > 8) return null;
    if (!deep && !cmap) return null;
    const ham = !deep && (camg & 0x800) !== 0 && (planes === 6 || planes === 8);
    const ehb = !deep && !ham && (camg & 0x80) !== 0 && planes === 6;
    const stored = planes + (masking === 1 ? 1 : 0);
    const rowBytes = ((w + 15) >> 4) * 2;
    const row = Buffer.alloc(rowBytes);
    const out = Buffer.alloc(w * h * 3);
    const pal = (i: number): [number, number, number] => {
      if (!cmap) return [0, 0, 0];
      if (ehb && i >= 32) {
        const j = (i - 32) * 3;
        return [(cmap[j] ?? 0) >> 1, (cmap[j + 1] ?? 0) >> 1, (cmap[j + 2] ?? 0) >> 1];
      }
      return [cmap[i * 3] ?? 0, cmap[i * 3 + 1] ?? 0, cmap[i * 3 + 2] ?? 0];
    };
    let p = 0;
    const idx = new Uint32Array(w);
    for (let y = 0; y < h; y += 1) {
      idx.fill(0);
      for (let pl = 0; pl < stored; pl += 1) {
        if (compression === 1) {
          p = unpackRow(body, p, row);
          if (p < 0) return null;
        } else {
          if (p + rowBytes > body.length) return null;
          body.copy(row, 0, p, p + rowBytes);
          p += rowBytes;
        }
        if (pl >= planes) continue;
        for (let x = 0; x < w; x += 1) if ((row[x >> 3] >> (7 - (x & 7))) & 1) idx[x] |= 1 << pl;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      for (let x = 0; x < w; x += 1) {
        const v = idx[x];
        const o = (y * w + x) * 3;
        if (deep) {
          out[o] = v & 0xff;
          out[o + 1] = (v >> 8) & 0xff;
          out[o + 2] = (v >> 16) & 0xff;
        } else if (ham) {
          const bits = planes - 2;
          const val = v & ((1 << bits) - 1);
          const ctl = v >> bits;
          const scaled = bits === 4 ? val * 17 : val << 2 | val >> 4;
          if (ctl === 0) [r, g, b] = pal(val);
          else if (ctl === 1) b = scaled;
          else if (ctl === 2) r = scaled;
          else g = scaled;
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
        } else {
          const [pr, pg, pb] = pal(v);
          out[o] = pr;
          out[o + 1] = pg;
          out[o + 2] = pb;
        }
      }
    }
    return { w, h, rgb: out };
  } catch {
    return null;
  }
}
