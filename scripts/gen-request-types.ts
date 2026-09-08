/**
 * Emits the client-vendorable mirror of contract/request-types.ts.
 *
 * The SAME renderMirror() the door-repo manifest and achievements mirrors
 * use - one generator, three contract files - pointed at the requests source
 * and told to say so in its header.
 */
import * as fs from 'fs';
import * as path from 'path';
import { renderMirror } from './gen-contract-types';

const SOURCE = path.join(__dirname, '..', 'contract', 'request-types.ts');

const ORIGIN = {
  source: 'contract/request-types.ts',
  generator: 'scripts/gen-request-types.ts',
};

if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    console.error('[ERROR] usage: gen-request-types.ts <output-path>');
    process.exit(1);
  }
  fs.writeFileSync(out, renderMirror(fs.readFileSync(SOURCE, 'utf-8'), ORIGIN), 'utf-8');
  console.log(`[OK] wrote ${out}`);
}
