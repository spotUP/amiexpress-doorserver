import { inferRequiresBbs, inferDoorType, BBS_TAGS } from '../src/demozoo-bbs';

describe('inferRequiresBbs', () => {
  it('matches a known release-group name before falling back to tags', () => {
    expect(inferRequiresBbs([], 'Up Rough')).toBe('AmiExpress');
    expect(inferRequiresBbs([], 'Quantum')).toBe('System-X');
  });

  it('falls back to a tag when the group name gives no signal', () => {
    expect(inferRequiresBbs(['amiex'], 'Some Unknown Crew')).toBe('AmiExpress');
    expect(inferRequiresBbs(['s!x-bbs'], 'Some Unknown Crew')).toBe('System-X');
  });

  it('returns null when neither the group nor the tags give a signal', () => {
    expect(inferRequiresBbs(['demo', 'intro'], 'Some Unknown Crew')).toBeNull();
  });

  it('uses "System-X", not "S!X", for every S!X-implying signal', () => {
    // S!X is the door convention; System-X is the actual BBS name (matches
    // the rename in src/describe.ts's BBS_NAMES).
    for (const entry of BBS_TAGS) {
      expect(entry.implies).not.toBe('S!X');
    }
  });
});

describe('inferDoorType', () => {
  it('maps the xim tag to XIM', () => {
    expect(inferDoorType(['xim'])).toBe('XIM');
  });

  it('returns null with no recognised tag', () => {
    expect(inferDoorType(['demo'])).toBeNull();
  });
});
