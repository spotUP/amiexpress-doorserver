/**
 * Picture previews: fit a decoded image into a cols x rows grid of 8x16 pixel
 * cells (never enlarging), as an RGB PNG of at most PREVIEW_MAX_BYTES or as
 * one averaged RGB pixel per cell.
 */
import { PNG } from 'pngjs';
import { resample } from './image-decode';
import type { Rgb } from './image-decode';
import { quantize, writeIndexedPng } from './quantize';

export const CELL_W = 8;
export const CELL_H = 16;
export const PREVIEW_MAX_BYTES = 64 * 1024;
/** Byte cap of a palette preview (`q=pal`): the size of LIVECHAT68's preview buffer. */
export const PALETTE_PREVIEW_MAX_BYTES = 128 * 1024;
export const COLS_MIN = 4;
export const COLS_MAX = 80;
export const ROWS_MIN = 2;
export const ROWS_MAX = 64;

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

/**
 * The cells are the display size: the fit before any shrink to the byte cap.
 * A big picture shrunk to stay under 64 KB still fills the cells it was fitted
 * to (the terminal scales the PNG up), so a chat log asking for its full width
 * gets its full width.
 */
export function makePng(src: Rgb, cols: number, rows: number): PreviewOut {
  const fit = fitSize(src.w, src.h, cols, rows);
  const shown = cellsOf(fit.w, fit.h);
  let { w, h } = fit;
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
      return { data, cells: `${shown.c}x${shown.r}` };
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

/**
 * Preview quality a caller asks for with `?q=`:
 * - `fit` (default, the original route): RGB PNG shrunk to 64 KB, cells from the fit.
 * - `full`: full-colour RGB PNG at exactly cells x 8 by cells x 16 pixels, no byte cap
 *   (web terminal and TS LiveChat: drawn 1:1, sharp).
 * - `pal`: indexed PNG of at most 255 colours at exactly cells x 8 by cells x 16 pixels,
 *   at most PALETTE_PREVIEW_MAX_BYTES (LIVECHAT68 and DCTelnet: 1:1, no dither).
 * The exact pixel box makes every row of cells a whole 16 px band, so a caller cropping
 * a picture to the rows it shows never cuts a pixel row in two.
 */
export type PreviewQuality = 'fit' | 'full' | 'pal';

/** Whole cells for the fitted picture, nearest (not ceil) so the stretch to the box is under half a cell. */
export function cellBox(w: number, h: number, cols: number, rows: number): { c: number; r: number } {
  const fit = fitSize(w, h, cols, rows);
  return { c: clamp(Math.round(fit.w / CELL_W), 1, cols), r: clamp(Math.round(fit.h / CELL_H), 1, rows) };
}

function rgbPng(pic: Rgb): Buffer {
  const png = new PNG({ width: pic.w, height: pic.h });
  for (let i = 0, o = 0; i < pic.w * pic.h; i += 1, o += 3) {
    png.data[i * 4] = pic.rgb[o];
    png.data[i * 4 + 1] = pic.rgb[o + 1];
    png.data[i * 4 + 2] = pic.rgb[o + 2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png, { colorType: 2, inputColorType: 6, inputHasAlpha: true, deflateLevel: 9 });
}

/**
 * `full` and `pal` previews. Cells are what the PNG is drawn into, always its exact
 * pixel size / 8x16; a palette picture over its byte cap gets fewer cells (smaller
 * but still 1:1), never a scaled-up blur.
 */
export function makeCellPng(src: Rgb, cols: number, rows: number, q: 'full' | 'pal'): PreviewOut {
  let { c, r } = cellBox(src.w, src.h, cols, rows);
  for (;;) {
    const pic = resample(src, c * CELL_W, r * CELL_H);
    const data = q === 'full' ? rgbPng(pic) : writeIndexedPng(quantize(pic));
    if (q === 'full' || data.length <= PALETTE_PREVIEW_MAX_BYTES || (c === 1 && r === 1)) {
      return { data, cells: `${c}x${r}` };
    }
    const k = Math.min(0.95, Math.sqrt(PALETTE_PREVIEW_MAX_BYTES / data.length) * 0.95);
    c = Math.max(1, Math.floor(c * k));
    r = Math.max(1, Math.floor(r * k));
  }
}
