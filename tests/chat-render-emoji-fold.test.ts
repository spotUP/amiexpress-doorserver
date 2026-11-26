import { f, renderText } from '../src/chat/render';

describe('hub text formats fold emoji for text clients', () => {
  it('a raw emoji in a field becomes its :name:, not ?', () => {
    expect(f('nice \u{1F44D}')).toBe('nice :thumbsup:');
    expect(f('hot \u{1F525}')).toBe('hot :fire:');
  });

  it('a rendered line is Latin-1 with the emoji name in it', () => {
    const buf = renderText('MSGS', 1, [['m1', 'yes \u{1F602}']]);
    const text = buf.toString('latin1');
    expect(text).not.toContain('?');
    expect(text).toMatch(/yes :(joy|laughing):/);
  });

  it('plain Latin-1 text is untouched', () => {
    expect(f('café :)')).toBe('café :)');
  });
});
