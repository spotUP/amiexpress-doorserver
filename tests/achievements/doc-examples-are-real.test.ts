/**
 * docs/ACHIEVEMENTS-API.md says its examples were captured from the real
 * server. This is what keeps that true.
 *
 * The document used to say the opposite, in its own status paragraph: the
 * examples were written from the contract, and AC-21 was to replace them.
 * Replacing them once would have bought a day - the first response shape to
 * change would have made the document wrong again, silently, and only for
 * the reader. So the capture is re-run here on every CI run and compared
 * with what the document holds.
 *
 * The comparison is NORMALIZED (doc-story.ts `normalize`): codes,
 * timestamps, revisions and seasons cannot repeat between two runs and are masked by
 * SHAPE, while every key, count, tier, point value, rarity and id is
 * compared for real. Capturing exposed a defect the prose had described
 * correctly for weeks - see rarity-floor.test.ts.
 *
 * Re-capture with `npm run capture:achievements-doc`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { makeAchievementsFixture } from './helpers';
import { runDocStory, renderExample, renderRequest, normalize } from './doc-story';
import type { CapturedExample } from './doc-story';

jest.setTimeout(60000);

const DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'ACHIEVEMENTS-API.md');
const doc = fs.readFileSync(DOC_PATH, 'utf-8');

/** Every `<!-- capture: id -->` fence in the document, by id. */
function anchoredFences(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of doc.matchAll(/<!-- capture: ([a-z0-9.]+) -->\n```[a-z]*\n([\s\S]*?)```/g)) {
    out.set(m[1], m[2].replace(/\n$/, ''));
  }
  return out;
}

/** A revision carries an epoch, so it differs on every run. */
const maskRevisions = (text: string): string => text.replace(/\b[al]\d+-t\d+\b/g, '<revision>');

let captured: CapturedExample[];

beforeAll(async () => {
  const fx = makeAchievementsFixture({ seed: true });
  try {
    captured = await runDocStory(fx);
  } finally {
    fx.cleanup();
  }
});

describe('the examples in docs/ACHIEVEMENTS-API.md', () => {
  it('are anchored, and every anchor names an example the walk captures', () => {
    const fences = anchoredFences();
    expect(fences.size).toBeGreaterThan(20);
    const ids = new Set(captured.map((ex) => ex.id));
    const orphans = [...fences.keys()].filter((id) => !ids.has(id));
    expect(orphans).toEqual([]);
  });

  it('say what the server says, field for field', () => {
    const fences = anchoredFences();
    const compared: string[] = [];

    for (const ex of captured) {
      const fence = fences.get(ex.id);
      if (fence === undefined) continue;
      compared.push(ex.id);

      if (typeof ex.body === 'string' || ex.id.endsWith('.request')) {
        const expected = ex.id.endsWith('.request') ? renderRequest(ex) : renderExample(ex);
        if (ex.requestBody !== undefined) {
          expect(normalize(JSON.parse(fence))).toEqual(normalize(JSON.parse(expected)));
        } else {
          expect(maskRevisions(fence)).toBe(maskRevisions(expected));
        }
        continue;
      }

      expect(normalize(JSON.parse(fence))).toEqual(normalize(ex.body));
    }

    // A comparison that quietly matched nothing is the failure this file
    // exists to prevent.
    expect(compared.length).toBe(fences.size);
  });

  it('no longer claims to be written from the contract', () => {
    expect(doc).not.toContain('written from the contract, not captured');
    expect(doc).toContain('capture-achievements-examples');
  });
});
