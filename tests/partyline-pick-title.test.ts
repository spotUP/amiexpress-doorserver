/**
 * LIVECHAT openArgPickList titles the /join and /msg lists ' Channel ' and ' User ' and shows the whole word.
 * The hub's Cells.menu sized the box to the item width and box() cut the title to "Channe".
 */
import { Cells, cellCh } from '../src/partyline/ui/cells';

const row = (c: Cells, r: number, w: number): string =>
  String.fromCharCode(...Array.from({ length: w }, (_, i) => cellCh(c.back[r * c.cols + i])));

describe('hub pick list title', () => {
  it('a short item list still shows the whole Channel title', () => {
    const c = new Cells(80, 25);
    const w = c.menu(0, 0, ['far'], 0, 7, 7, 7, ' Channel ');
    expect(row(c, 0, w)).toBe('.- Channel -.');
    expect(row(c, 1, w)).toBe('|> far      |');
  });

  it('the User title fits too, and items wider than the title set the width', () => {
    const c = new Cells(80, 25);
    expect(row(c, 0, c.menu(0, 0, ['al'], 0, 7, 7, 7, ' User '))).toBe('.- User -.');
    expect(c.menu(5, 0, ['a-much-longer-room'], 0, 7, 7, 7, ' Channel ')).toBe(22);
  });
});
