/**
 * The shared bbsad corpus: hand-verified ad lines and what parseAd must
 * read out of them. Mirrors tests/describe-fixtures.test.ts - a rule change
 * that moves an output fails here; regenerate the fixtures and bump
 * BBSAD_CONTRACT_VERSION.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseAd, maskPhone, maskPhonesInText, BBSAD_CONTRACT_VERSION, type ParsedAd } from '../contract/bbsad';

const FIXTURES = path.join(__dirname, '..', 'contract', 'bbsad-fixtures.json');

interface FixtureFile {
  contractVersion: string;
  cases: Array<{
    name: string;
    adId: number;
    filename: string;
    input: string;
    expected: ParsedAd;
  }>;
}

const fixtures: FixtureFile = JSON.parse(fs.readFileSync(FIXTURES, 'utf-8'));

describe('the shared bbsad corpus', () => {
  it('is committed and not empty', () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
  });

  it('was generated from the version of the contract that is here now', () => {
    expect(fixtures.contractVersion).toBe(BBSAD_CONTRACT_VERSION);
  });

  it.each(fixtures.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(parseAd(c.input)).toEqual(c.expected);
  });
});

describe('phone masking', () => {
  it.each([
    ['+31-(0)-204-930-420', '+31-(0)-204-***-***'],
    ['713-460-8217', '713-460-****'],
    ['(404) 452-7387', '(404) 452-****'],
    ['921-2557629', '921-*******'],
    ['508.922.2992', '508.922.****'],
    ['1-8oo-ask-trsi', '1-***-***-****'],
    ['1234567-89', '1234***-**'],
    ['+47 63903364', '+47 ********'],
    ['+46-8-7595847', '+46-8-*******'],
  ])('masks %s to %s', (raw, masked) => {
    expect(maskPhone(raw)).toBe(masked);
  });

  it('masks numbers in text but leaves the rest alone', () => {
    const line = '--->  Martyriun BBS 713-460-8217 - ANTHROX WHQ - 3 NODES - ELITE <---';
    expect(maskPhonesInText(line)).toBe(
      '--->  Martyriun BBS 713-460-**** - ANTHROX WHQ - 3 NODES - ELITE <---'
    );
    expect(maskPhonesInText(null)).toBeNull();
  });
});
