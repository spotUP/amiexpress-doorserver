/**
 * Emits the client-vendorable mirror of contract/describe.ts.
 *
 * The SAME renderMirror() the manifest and achievements mirrors use - ONE
 * generator, three contract files - pointed at the extractor and told to say
 * so in its header.
 *
 * WHY THE BBS NEEDS A COPY AT ALL. The board reads the same FILE_ID.DIZ files
 * this server does, and a door described one way here and another way there is
 * the same defect as two stores disagreeing about a user. The rules are pure
 * text processing with no imports, so they vendor cleanly; `analyseDoor` is a
 * function of its input and nothing else.
 *
 *   npx tsx scripts/gen-describe-types.ts ../amiexpress-web/web/backend/src/utils/describe.generated.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { renderMirror } from './gen-contract-types';

const SOURCE = path.join(__dirname, '..', 'contract', 'describe.ts');

export const DESCRIBE_ORIGIN = {
  source: 'contract/describe.ts',
  generator: 'scripts/gen-describe-types.ts',
};

if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    console.error('[ERROR] usage: gen-describe-types.ts <output-path>');
    process.exit(1);
  }
  fs.writeFileSync(out, renderMirror(fs.readFileSync(SOURCE, 'utf-8'), DESCRIBE_ORIGIN), 'utf-8');
  console.log(`[OK] wrote ${out}`);
}
