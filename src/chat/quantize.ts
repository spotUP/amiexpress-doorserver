/**
 * Palette pictures for 68K callers: reduce an RGB picture to at most
 * PALETTE_MAX colours (median cut, no dither) and write it as an indexed PNG
 * (colour type 3, bit depth 8, PLTE, no tRNS).
 *
 * The limit is 255, not 256: DCTelnet (vtcon) shows a picture of 255 colours
 * or fewer in its exact colours, and falls back to a dithered 6x6x6 cube at
 * 256. A picture that already has 255 colours or fewer keeps them exactly.
 */
import * as zlib from 'zlib';
import type { Rgb } from './image-decode';

export const PALETTE_MAX = 255;

export interface Indexed {
  w: number;
  h: number;
  /** PALETTE entries x 3 bytes. */
  palette: Buffer;
  /** One palette index per pixel. */
  index: Buffer;
}

/** Exact colours when there are few enough; else a median-cut palette over a 5-bit-per-channel histogram. */
export function quantize(src: Rgb, max = PALETTE_MAX): Indexed {
  const n = src.w * src.h;
  const exact = new Map<number, number>();
  for (let i = 0; i < n && exact.size <= max; i += 1) {
    const c = (src.rgb[i * 3] << 16) | (src.rgb[i * 3 + 1] << 8) | src.rgb[i * 3 + 2];
    if (!exact.has(c)) exact.set(c, exact.size);
  }
  if (exact.size <= max) {
    const palette = Buffer.alloc(exact.size * 3);
    for (const [c, k] of exact) {
      palette[k * 3] = c >> 16;
      palette[k * 3 + 1] = (c >> 8) & 255;
      palette[k * 3 + 2] = c & 255;
    }
    const index = Buffer.alloc(n);
    for (let i = 0; i < n; i += 1) index[i] = exact.get((src.rgb[i * 3] << 16) | (src.rgb[i * 3 + 1] << 8) | src.rgb[i * 3 + 2]) as number;
    return { w: src.w, h: src.h, palette, index };
  }
  return medianCut(src, max);
}

const bin5 = (r: number, g: number, b: number): number => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
const chan = (bin: number, c: number): number => (bin >> (10 - c * 5)) & 31;

function medianCut(src: Rgb, max: number): Indexed {
  const n = src.w * src.h;
  const count = new Uint32Array(32768);
  const sum = new Float64Array(32768 * 3);
  for (let i = 0; i < n; i += 1) {
    const r = src.rgb[i * 3];
    const g = src.rgb[i * 3 + 1];
    const b = src.rgb[i * 3 + 2];
    const k = bin5(r, g, b);
    count[k] += 1;
    sum[k * 3] += r;
    sum[k * 3 + 1] += g;
    sum[k * 3 + 2] += b;
  }
  const used: number[] = [];
  for (let k = 0; k < 32768; k += 1) if (count[k] > 0) used.push(k);

  interface Box { bins: number[]; pop: number; axis: number; range: number }
  const describe = (bins: number[]): Box => {
    let pop = 0;
    const lo = [31, 31, 31];
    const hi = [0, 0, 0];
    for (const k of bins) {
      pop += count[k];
      for (let c = 0; c < 3; c += 1) {
        const v = chan(k, c);
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    let axis = 0;
    for (let c = 1; c < 3; c += 1) if (hi[c] - lo[c] > hi[axis] - lo[axis]) axis = c;
    return { bins, pop, axis, range: hi[axis] - lo[axis] };
  };
  const boxes: Box[] = [describe(used)];
  while (boxes.length < max) {
    let pick = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i += 1) {
      const score = boxes[i].pop * boxes[i].range;
      if (boxes[i].bins.length > 1 && boxes[i].range > 0 && score > best) { best = score; pick = i; }
    }
    if (pick < 0) break;
    const box = boxes[pick];
    const sorted = box.bins.slice().sort((a, b) => chan(a, box.axis) - chan(b, box.axis));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      acc += count[sorted[i]];
      cut = i + 1;
      if (acc * 2 >= box.pop) break;
    }
    boxes.splice(pick, 1, describe(sorted.slice(0, cut)), describe(sorted.slice(cut)));
  }

  const palette = Buffer.alloc(boxes.length * 3);
  boxes.forEach((box, p) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const k of box.bins) { r += sum[k * 3]; g += sum[k * 3 + 1]; b += sum[k * 3 + 2]; }
    palette[p * 3] = Math.round(r / box.pop);
    palette[p * 3 + 1] = Math.round(g / box.pop);
    palette[p * 3 + 2] = Math.round(b / box.pop);
  });

  // Each histogram bin maps to the palette colour nearest its mean (not merely the box it fell in).
  const map = new Int16Array(32768).fill(-1);
  for (const k of used) {
    const r = sum[k * 3] / count[k];
    const g = sum[k * 3 + 1] / count[k];
    const b = sum[k * 3 + 2] / count[k];
    let bestP = 0;
    let bestD = Infinity;
    for (let p = 0; p < boxes.length; p += 1) {
      const dr = palette[p * 3] - r;
      const dg = palette[p * 3 + 1] - g;
      const db = palette[p * 3 + 2] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bestD) { bestD = d; bestP = p; }
    }
    map[k] = bestP;
  }
  const index = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) index[i] = map[bin5(src.rgb[i * 3], src.rgb[i * 3 + 1], src.rgb[i * 3 + 2])];
  return { w: src.w, h: src.h, palette, index };
}

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Colour type 3, bit depth 8, filter 0 on every row (palette pictures compress best unfiltered). */
export function writeIndexedPng(pic: Indexed): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pic.w, 0);
  ihdr.writeUInt32BE(pic.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const raw = Buffer.alloc((pic.w + 1) * pic.h);
  for (let y = 0; y < pic.h; y += 1) pic.index.copy(raw, y * (pic.w + 1) + 1, y * pic.w, (y + 1) * pic.w);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', pic.palette),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
