import { parseHello } from '../src/partyline/auth';

describe('hello responsive', () => {
  it('reads board, door override and door key; an older board sends nothing', () => {
    expect(parseHello(Buffer.from('handle=spot\nresponsive=on,off,partyline')).responsive).toEqual({ board: 'on', choice: 'off', door: 'partyline' });
    expect(parseHello(Buffer.from('handle=spot\nresponsive=junk')).responsive).toBeUndefined();
    expect(parseHello(Buffer.from('handle=spot')).responsive).toBeUndefined();
  });
});
