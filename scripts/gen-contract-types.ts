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

/**
 * Which contract file a mirror was rendered from, and how to regenerate it.
 *
 * ONE generator, two contract files: the achievements surface vendors its
 * own mirror through scripts/gen-achievement-types.ts, and a second copy of
 * this function would be a second header to keep in step. The defaults
 * reproduce the manifest mirror byte for byte, so nothing that already
 * consumes it moves.
 */
export interface MirrorOrigin {
  /** Repo-relative path of the contract file being mirrored. */
  source: string;
  /** The script a reader runs to regenerate it. */
  generator: string;
  /** Repo that owns `source`; defaults to amiexpress-doorserver. */
  repo?: string;
  /** Keep the source's leading doc comment under the header (default: strip it). */
  keepLeadingComment?: boolean;
}

const MANIFEST_ORIGIN: MirrorOrigin = {
  source: 'contract/manifest-types.ts',
  generator: 'scripts/gen-contract-types.ts',
};

export function renderMirror(sourceText: string, origin: MirrorOrigin = MANIFEST_ORIGIN): string {
  return [
    '/**',
    ' * GENERATED FILE -- DO NOT EDIT BY HAND.',
    ' *',
    ` * Mirror of ${origin.repo ?? 'amiexpress-doorserver'} ${origin.source}.`,
    ` * Regenerate with: npx tsx ${origin.generator}`,
    ' */',
    '',
    origin.keepLeadingComment ? sourceText : sourceText.replace(/^\/\*\*[\s\S]*?\*\/\n/, ''),
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
