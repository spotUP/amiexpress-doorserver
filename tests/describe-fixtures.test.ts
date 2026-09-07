/**
 * The committed corpus BOTH repos run.
 *
 * The BBS vendors a generated mirror of `contract/describe.ts`, because a door
 * described one way here and another way on the board is the same defect as
 * two stores disagreeing about a user. A sibling checkout cannot be a CI
 * dependency, so identity is proved by this corpus - generated from
 * `tests/describe.test.ts`, committed, and run by both sides against their own
 * copy of the extractor.
 *
 * THIS side asserts the fixtures still describe what the rules do. The other
 * side asserts its mirror produces the same answers. Between them, a rule
 * change that moves an output fails here (regenerate and bump
 * DESCRIBE_CONTRACT_VERSION) and a stale vendored mirror fails there.
 */
import * as fs from 'fs';
import * as path from 'path';

import { analyseDoor, DESCRIBE_CONTRACT_VERSION } from '../src/describe';

const FIXTURES = path.join(__dirname, '..', 'contract', 'describe-fixtures.json');

interface FixtureFile {
  contractVersion: string;
  cases: Array<{
    input: Parameters<typeof analyseDoor>[0];
    groupTags: string[];
    expected: Record<string, unknown>;
  }>;
}

const fixtures: FixtureFile = JSON.parse(fs.readFileSync(FIXTURES, 'utf-8'));

describe('the shared describe corpus', () => {
  it('is committed and not empty', () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
  });

  it('was generated from the version of the contract that is here now', () => {
    expect(fixtures.contractVersion).toBe(DESCRIBE_CONTRACT_VERSION);
  });

  it.each(fixtures.cases.map((c, i) => [i, c.input.archiveName ?? `case ${i}`, c] as const))(
    'case %i (%s) reads the same facts it did when the corpus was taken',
    (_i, _name, testCase) => {
      const facts = analyseDoor(testCase.input, new Set(testCase.groupTags));
      expect({ ...facts, description: facts.description ?? '' }).toEqual(testCase.expected);
    },
  );
});
