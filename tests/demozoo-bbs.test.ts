import { inferRequiresBbs, inferDoorType, extractReleaseGroup, inferCategory, BBS_TAGS } from '../src/demozoo-bbs';

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

describe('extractReleaseGroup', () => {
  it('returns the abbreviation and full name of a nick flagged as a group', () => {
    const result = extractReleaseGroup([
      { abbreviation: 'LI', releaser: { name: 'Lord of Illusion', is_group: false } },
      { abbreviation: 'SOI', releaser: { name: 'Sphere of Illusions', is_group: true } },
    ]);
    expect(result).toEqual({ abbrev: 'SOI', fullName: 'Sphere of Illusions' });
  });

  it('skips a group nick with no abbreviation - demozoo has real groups with none set', () => {
    const result = extractReleaseGroup([
      { abbreviation: '', releaser: { name: 'Some Group', is_group: true } },
    ]);
    expect(result).toBeNull();
  });

  it('returns null for a solo releaser (is_group: false)', () => {
    const result = extractReleaseGroup([
      { abbreviation: '', releaser: { name: 'Grymmjack', is_group: false } },
    ]);
    expect(result).toBeNull();
  });

  it('returns null for an empty or missing author_nicks list', () => {
    expect(extractReleaseGroup([])).toBeNull();
    expect(extractReleaseGroup(undefined)).toBeNull();
  });
});

describe('inferCategory', () => {
  it('returns the first production type name', () => {
    expect(inferCategory([{ name: 'BBS Door' }, { name: 'Tool' }])).toBe('BBS Door');
  });

  it('returns null for an empty or missing types list', () => {
    expect(inferCategory([])).toBeNull();
    expect(inferCategory(undefined)).toBeNull();
  });

  it('returns null rather than an empty string for a blank type name', () => {
    expect(inferCategory([{ name: '   ' }])).toBeNull();
  });
});
