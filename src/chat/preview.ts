/**
 * Picture previews: fit a decoded image into a cols x rows grid of 8x16 pixel
 * cells (never enlarging), as an RGB PNG of at most PREVIEW_MAX_BYTES or as
 * one averaged RGB pixel per cell.
 */
import { PNG } from 'pngjs';
import { resample } from './image-decode';
import type { Rgb } from './image-decode';

export const CELL_W = 8;
export const CELL_H = 16;
export const PREVIEW_MAX_BYTES = 64 * 1024;
export const COLS_MIN = 4;
export const COLS_MAX = 80;
export const ROWS_MIN = 2;
export const ROWS_MAX = 24;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Pixel size of the image fitted into cols x rows cells, aspect kept, never enlarged. */
export function fitSize(w: number, h: number, cols: number, rows: number): { w: number; h: number } {
  const s = Math.min((cols * CELL_W) / w, (rows * CELL_H) / h, 1);
  return { w: clamp(Math.round(w * s), 1, cols * CELL_W), h: clamp(Math.round(h * s), 1, rows * CELL_H) };
}

export const cellsOf = (w: number, h: number): { c: number; r: number } => ({ c: Math.ceil(w / CELL_W), r: Math.ceil(h / CELL_H) });

export interface PreviewOut {
  data: Buffer;
  cells: string;
}

export function makePng(src: Rgb, cols: number, rows: number): PreviewOut {
  let { w, h } = fitSize(src.w, src.h, cols, rows);
  for (;;) {
    const scaled = w === src.w && h === src.h ? src : resample(src, w, h);
    const png = new PNG({ width: w, height: h });
    for (let i = 0, o = 0; i < w * h; i += 1, o += 3) {
      png.data[i * 4] = scaled.rgb[o];
      png.data[i * 4 + 1] = scaled.rgb[o + 1];
      png.data[i * 4 + 2] = scaled.rgb[o + 2];
      png.data[i * 4 + 3] = 255;
    }
    const data = PNG.sync.write(png, { colorType: 2, inputColorType: 6, inputHasAlpha: true, deflateLevel: 6 });
    if (data.length <= PREVIEW_MAX_BYTES || (w === 1 && h === 1)) {
      const { c, r } = cellsOf(w, h);
      return { data, cells: `${c}x${r}` };
    }
    // Size grows with area: jump to the estimated fit (with margin) instead of creeping down.
    const k = Math.min(0.95, Math.sqrt(PREVIEW_MAX_BYTES / data.length) * 0.95);
    w = Math.max(1, Math.floor(w * k));
    h = Math.max(1, Math.floor(h * k));
  }
}

export function makeRgb(src: Rgb, cols: number, rows: number): PreviewOut {
  const fit = fitSize(src.w, src.h, cols, rows);
  const { c, r } = cellsOf(fit.w, fit.h);
  return { data: resample(src, c, r).rgb, cells: `${c}x${r}` };
}
