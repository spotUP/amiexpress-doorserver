// tests/achievements/capture-doc-examples.ts
/**
 * Captures every example in docs/ACHIEVEMENTS-API.md from the real server.
 *
 * It lives beside the harness it drives rather than in scripts/, because
 * scripts/ is COPIED INTO THE PRODUCTION IMAGE and compiled there
 * (Dockerfile:19) while tests/ is not - a script importing a test helper
 * fails `npm run build` inside Docker with TS2307 and takes the deploy
 * with it, which is exactly what it did on 2026-09-07.
 *
 * Runs `runDocStory` (tests/achievements/doc-story.ts) against a throwaway
 * fixture - real `createApp`, real board key, real scrypt-hashed
 * verification codes read out of the queued mail - and rewrites each
 * `<!-- capture: <id> -->` anchored fence in the document with the bytes
 * that walk produced.
 *
 * Run it with `npm run capture:achievements-doc`. The drift suite
 * (tests/achievements/doc-examples-are-real.test.ts) re-runs the same walk
 * on every CI run and fails if the document and the server disagree, so a
 * stale capture cannot survive a change to a response shape.
 */
import * as fs from 'fs';
import * as path from 'path';
import { makeAchievementsFixture } from './helpers';
import { runDocStory, applyCaptures } from './doc-story';

async function main(): Promise<void> {
  const docPath = path.join(__dirname, '..', '..', 'docs', 'ACHIEVEMENTS-API.md');
  const fx = makeAchievementsFixture({ seed: true });
  try {
    const captured = await runDocStory(fx);
    const before = fs.readFileSync(docPath, 'utf-8');
    const { text, replaced, missing } = applyCaptures(before, captured);
    if (missing.length > 0) {
      throw new Error(`the document has no <!-- capture: --> anchor for: ${missing.join(', ')}`);
    }
    fs.writeFileSync(docPath, text);
    console.log(`[OK] ${replaced} examples captured into docs/ACHIEVEMENTS-API.md`);
  } finally {
    fx.cleanup();
  }
}

main().catch((e) => {
  console.error(`[ERROR] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
