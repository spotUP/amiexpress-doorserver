/**
 * One decoder for every picture the chat hub understands: PNG, JPEG, GIF
 * (first frame) and IFF ILBM. Returns RGB bytes (no alpha; transparent pixels
 * are composited over black) or null when the bytes are not a decodable
 * picture or are larger than MAX_PIXELS. Also the scaler the previews use.
 */
import { decode as decodeJpeg } from 'jpeg-js';
import { GifReader } from 'omggif';
import { PNG } from 'pngjs';
import { decodeIlbm } from './ilbm';
import type { Rgb } from './ilbm';

export type { Rgb } from './ilbm';

export const MAX_PIXELS = 16 * 1024 * 1024;

function flatten(rgba: Uint8Array, w: number, h: number): Rgb {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, o = 0; i < w * h * 4; i += 4, o += 3) {
    const a = rgba[i + 3] / 255;
    rgb[o] = Math.round(rgba[i] * a);
    rgb[o + 1] = Math.round(rgba[i + 1] * a);
    rgb[o + 2] = Math.round(rgba[i + 2] * a);
  }
  return { w, h, rgb };
}

export function decodeImage(buf: Buffer): Rgb | null {
  try {
    const m4 = buf.toString('latin1', 0, 4);
    if (m4 === '\x89PNG') {
      if (buf.length < 24 || buf.readUInt32BE(16) * buf.readUInt32BE(20) > MAX_PIXELS) return null;
      const png = PNG.sync.read(buf);
      return flatten(png.data, png.width, png.height);
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const j = decodeJpeg(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 16 });
      return flatten(j.data, j.width, j.height);
    }
    if (m4 === 'GIF8') {
      const g = new GifReader(buf);
      if (g.width * g.height > MAX_PIXELS) return null;
      const rgba = new Uint8Array(g.width * g.height * 4);
      g.decodeAndBlitFrameRGBA(0, rgba);
      return flatten(rgba, g.width, g.height);
    }
    if (m4 === 'FORM') return decodeIlbm(buf);
  } catch {
    return null;
  }
  return null;
}

/** Area-average (box) resample to dw x dh. Works for up- and down-scaling. */
export function resample(src: Rgb, dw: number, dh: number): Rgb {
  const out = Buffer.alloc(dw * dh * 3);
  const xs = src.w / dw;
  const ys = src.h / dh;
  for (let y = 0; y < dh; y += 1) {
    const y0 = y * ys;
    const y1 = (y + 1) * ys;
    for (let x = 0; x < dw; x += 1) {
      const x0 = x * xs;
      const x1 = (x + 1) * xs;
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.min(src.h, Math.ceil(y1)); sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.min(src.w, Math.ceil(x1)); sx += 1) {
          const wt = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const i = (sy * src.w + sx) * 3;
          r += src.rgb[i] * wt;
          g += src.rgb[i + 1] * wt;
          b += src.rgb[i + 2] * wt;
          wsum += wt;
        }
      }
      const o = (y * dw + x) * 3;
      if (wsum > 0) {
        out[o] = Math.round(r / wsum);
        out[o + 1] = Math.round(g / wsum);
        out[o + 2] = Math.round(b / wsum);
      }
    }
  }
  return { w: dw, h: dh, rgb: out };
}
