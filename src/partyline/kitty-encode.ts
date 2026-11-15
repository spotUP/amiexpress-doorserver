/**
 * Mirror of amiexpress-web web/backend/src/utils/kitty-graphics.util.ts (the
 * encode half) and encodeKittyImage from services/kitty-graphics.service.ts.
 * The Partyline hub runs LIVECHAT with the board's bbs.sendImage/placeImage/
 * deleteImage contract, so it must emit the same APC bytes the board does.
 * Change both copies together.
 */

/** Raw bytes per APC chunk: 3072 raw = 4096 base64 chars, kitty's chunk limit. */
const RAW_CHUNK = 3072;

/** The display keys every transmit takes (kout_opts). */
export interface KittyImageOptions {
  /** c=: scale to this many cells wide; 0 or absent = natural size. */
  readonly cols?: number;
  /** r=: scale to this many cells high; 0 or absent = natural size. */
  readonly rows?: number;
  /** q=: 1 hides OK replies, 2 hides every reply. */
  readonly quiet?: 0 | 1 | 2;
  /** i=: an image id, so a later delete can name it. */
  readonly id?: number;
  /**
   * false: store the picture only (a=t) and draw it later with a=p. Default
   * true (a=T, store and draw at the cursor). A transmit-and-draw moves the
   * cursor below the picture, and a picture reaching past the screen bottom
   * scrolls the whole terminal - LiveChat's inline pictures did exactly that
   * when they first came into view as a slice (sysop report 2026-11-10: "the
   * whole livechat door scrolls up with the images now").
   */
  readonly place?: boolean;
}

function transmitAction(o: KittyImageOptions | undefined): 't' | 'T' {
  return o?.place === false ? 't' : 'T';
}

function commonKeys(o: KittyImageOptions | undefined): string {
  let k = '';
  if (o?.id !== undefined && o.id > 0) k += `,i=${Math.floor(o.id)}`;
  if (o?.cols !== undefined && o.cols > 0) k += `,c=${Math.floor(o.cols)}`;
  if (o?.rows !== undefined && o.rows > 0) k += `,r=${Math.floor(o.rows)}`;
  if (o?.quiet !== undefined && o.quiet > 0) k += `,q=${o.quiet}`;
  return k;
}

/** The payload in APC chunks; `keys` is the first chunk's key list without m=. */
function sendChunks(keys: string, data: Uint8Array): string {
  let out = '';
  let off = 0;
  let first = true;
  do {
    const take = Math.min(RAW_CHUNK, data.length - off);
    const more = off + take < data.length;
    out += `\x1b_G${first ? `${keys},` : ''}m=${more ? 1 : 0};`;
    out += Buffer.from(data.subarray(off, off + take)).toString('base64');
    out += '\x1b\\';
    off += take;
    first = false;
  } while (off < data.length);
  return out;
}

/**
 * Raw pixels at the cursor: bpp 3 is f=24 (RGB), bpp 4 is f=32 (RGBA).
 * Null for a size that does not match the buffer (kout_pixels returns 0).
 */
export function encodeKittyPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  bpp: 3 | 4,
  opts?: KittyImageOptions,
): string | null {
  if (width <= 0 || height <= 0 || pixels.length !== width * height * bpp) return null;
  const keys = `a=${transmitAction(opts)},f=${bpp === 3 ? 24 : 32},s=${width},v=${height}${commonKeys(opts)}`;
  return sendChunks(keys, pixels);
}

/** A PNG file's bytes as they are (f=100), at the cursor. Null for no bytes. */
export function encodeKittyPng(png: Uint8Array, opts?: KittyImageOptions): string | null {
  if (png.length === 0) return null;
  return sendChunks(`a=${transmitAction(opts)},f=100${commonKeys(opts)}`, png);
}

/** Delete every placement and free the image data (a=d, d=A). */
export const KITTY_DELETE_ALL = '\x1b_Ga=d,d=A,q=2\x1b\\';

/**
 * Draw an already transmitted image (a=p) at the cursor on `cols` x `rows`
 * cells, the whole picture or only `crop` of it. C=1 keeps the cursor where it was, q=2 asks for no reply. A redraw
 * costs these few bytes, not the picture again.
 */
/**
 * Kitty z (stacking order) below which a picture draws under cells that have a
 * background colour of their own (menus, bars) and over default-background cells.
 */
export const KITTY_Z_UNDER_BACKGROUNDS = -1073741824;

export function encodeKittyPlace(id: number, cols: number, rows: number, crop?: KittyCrop, placement?: number, z?: number): string {
  let k = '';
  // A placement id (p=) makes this place replace the picture's earlier
  // placement with the same id, wherever it was: a door that moves a picture
  // (scrolling) sends no delete first, so the terminal never shows a gap.
  if (placement && placement > 0) k += `,p=${Math.floor(placement)}`;
  // z is signed: below zero the picture draws under the text.
  if (z) k += `,z=${Math.trunc(z)}`;
  if (crop) {
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      const v = Math.max(0, Math.floor(crop[key]));
      if (v > 0) k += `,${key}=${v}`;
    }
  }
  return `\x1b_Ga=p,i=${Math.floor(id)},c=${Math.floor(cols)},r=${Math.floor(rows)}${k},C=1,q=2\x1b\\`;
}

/**
 * Source rectangle of a placement in image pixels (kitty x=, y=, w=, h=):
 * only that part of the picture is drawn, scaled to the cols x rows cells.
 * A door that scrolls a picture row by row places the visible slice this way.
 */
export interface KittyCrop {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Remove image `id`'s placements (a=d). `keepData` true is d=i: the data
 * stays so a later place is cheap. False is d=I: the data is freed too.
 * A `placement` id (p=) removes only that one placement of the image.
 */
export function encodeKittyDelete(id: number, keepData: boolean, placement?: number): string {
  const p = placement && placement > 0 ? `,p=${Math.floor(placement)}` : '';
  return `\x1b_Ga=d,d=${keepData ? 'i' : 'I'},i=${Math.floor(id)}${p},q=2\x1b\\`;
}

/** A picture to send: a PNG file's bytes, or raw RGB / RGBA pixels. */
export type KittyImage =
  | { readonly png: Uint8Array }
  | { readonly pixels: Uint8Array; readonly width: number; readonly height: number; readonly bpp: 3 | 4 };

export interface SendKittyImageOptions extends KittyImageOptions {
  /** What a caller without kitty graphics reads instead (ANSI text). */
  readonly fallback?: string;
}

/** The APC string for a picture, replies off (q=2: nothing comes back to filter). */
export function encodeKittyImage(image: KittyImage, opts?: KittyImageOptions): string | null {
  const o: KittyImageOptions = { quiet: 2, ...opts };
  return 'png' in image
    ? encodeKittyPng(image.png, o)
    : encodeKittyPixels(image.pixels, image.width, image.height, image.bpp, o);
}
