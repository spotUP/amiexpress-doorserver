/**
 * The board's /chat page has no Quit (the tab is the exit). The hub's door only
 * knows a caller came from /chat through the hello chatonly= field, which the
 * child hands the door as bbsSession.tempData.chatOnly.
 */
import { parseHello } from '../src/partyline/auth';

describe('hello chatonly', () => {
  it('reads chatonly=1 as a /chat caller and anything else as a board caller', () => {
    expect(parseHello(Buffer.from('handle=spot\nchatonly=1')).chatOnly).toBe(true);
    expect(parseHello(Buffer.from('handle=spot\nchatonly=0')).chatOnly).toBe(false);
    expect(parseHello(Buffer.from('handle=spot')).chatOnly).toBe(false);
  });
});
