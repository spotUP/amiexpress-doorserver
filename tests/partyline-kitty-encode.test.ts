/**
 * The hub's kitty encoder mirrors the board's (amiexpress-web
 * web/backend/src/services/kitty-graphics.service.ts + utils/kitty-graphics.util.ts),
 * so a picture LIVECHAT draws through Partyline reaches the caller as the same
 * bytes it would on the board's own LC path. The hashes below were taken from
 * the board's encoder for the same inputs (2026-11-15); a change on either side
 * must be made on both, and these hashes retaken from the board.
 */
import { createHash } from 'crypto';
import {
  encodeKittyDelete,
  encodeKittyImage,
  encodeKittyPlace,
  KITTY_DELETE_ALL,
  KITTY_Z_UNDER_BACKGROUNDS,
} from '../src/partyline/kitty-encode';

const sha = (s: string | null): string | null => (s === null ? null : createHash('sha256').update(s).digest('hex'));

describe('partyline kitty encoder matches the board LC path byte for byte', () => {
  const png = Buffer.alloc(5000);
  for (let i = 0; i < png.length; i++) png[i] = (i * 7) & 255;

  it.each([
    ['png, chunked', () => encodeKittyImage({ png }, { id: 42, cols: 10, rows: 5 }),
      'df2265fbd1f4a975fda295a64cf7d4ecea326a418d7ae89b212dd23174e0bb88'],
    ['raw pixels', () => encodeKittyImage({ pixels: Buffer.alloc(16, 0x80), width: 2, height: 2, bpp: 4 }, { id: 7 }),
      '6637e6b582002609a458b2ade9dea48be0432824d13fb9c8651544f94c81b8ca'],
    ['place with placement and z', () => encodeKittyPlace(42, 10, 5, undefined, 3, -1073741825),
      'b80861b88736d481d7ea50bc0274b9f21e7ab8f3241333077ea5ca99a54328bb'],
    ['place with crop', () => encodeKittyPlace(42, 10, 5, { x: 1, y: 2, w: 3, h: 4 }),
      '24fb9b3f1f6d2e5a16028c3e658133e4d8209f8edd61d23290071d3316ffb7e6'],
    ['delete placement, keep data', () => encodeKittyDelete(42, true, 3),
      '0cbfe9da65b678ab92d0c64242367860029b518914afe5765053f2eeb1c5de33'],
    ['delete and free', () => encodeKittyDelete(42, false),
      '4a1cb7873d50e8469b949f028f2bede5df2da804e02dd464034b27a7201b7993'],
  ])('%s', (_name, encode, hash) => {
    expect(sha(encode())).toBe(hash);
  });

  it('keeps the board constants', () => {
    expect(KITTY_DELETE_ALL).toBe('\x1b_Ga=d,d=A,q=2\x1b\\');
    expect(KITTY_Z_UNDER_BACKGROUNDS).toBe(-1073741824);
  });

  it('refuses pixels whose size does not match, as the board does', () => {
    expect(encodeKittyImage({ pixels: Buffer.alloc(15), width: 2, height: 2, bpp: 4 })).toBeNull();
  });
});
