/**
 * Emits the client-vendorable mirror of contract/achievement-types.ts.
 *
 * The SAME renderMirror() the door-repo manifest mirror uses - one
 * generator, two contract files - pointed at the achievements source and
 * told to say so in its header.
 */
import * as fs from 'fs';
import * as path from 'path';
import { renderMirror } from './gen-contract-types';

const SOURCE = path.join(__dirname, '..', 'contract', 'achievement-types.ts');

const ORIGIN = {
  source: 'contract/achievement-types.ts',
  generator: 'scripts/gen-achievement-types.ts',
};

if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    console.error('[ERROR] usage: gen-achievement-types.ts <output-path>');
    process.exit(1);
  }
  fs.writeFileSync(out, renderMirror(fs.readFileSync(SOURCE, 'utf-8'), ORIGIN), 'utf-8');
  console.log(`[OK] wrote ${out}`);
}
