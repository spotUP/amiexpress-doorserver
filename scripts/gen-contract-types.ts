/**
 * Emits the client-vendorable mirror of contract/manifest-types.ts.
 *
 * A client (DOORMAN today, any TypeScript consumer later) commits the
 * output and a staleness test compares it to this file, so a contract
 * change cannot ship without the mirror moving with it.
 */
import * as fs from 'fs';
import * as path from 'path';

const SOURCE = path.join(__dirname, '..', 'contract', 'manifest-types.ts');

export function renderMirror(sourceText: string): string {
  return [
    '/**',
    ' * GENERATED FILE -- DO NOT EDIT BY HAND.',
    ' *',
    ' * Mirror of amiexpress-doorserver contract/manifest-types.ts.',
    ' * Regenerate with: npx tsx scripts/gen-contract-types.ts',
    ' */',
    '',
    sourceText.replace(/^\/\*\*[\s\S]*?\*\/\n/, ''),
  ].join('\n');
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    console.error('[ERROR] usage: gen-contract-types.ts <output-path>');
    process.exit(1);
  }
  fs.writeFileSync(out, renderMirror(fs.readFileSync(SOURCE, 'utf-8')), 'utf-8');
  console.log(`[OK] wrote ${out}`);
}
