/**
 * Emits the hub's mirror of the /draw canvas wire codec (plan
 * 2026-11-10-ansi-editor-c-port, decision D9a).
 *
 * The SDK file amiexpress-web sdk/engines/ui/ansi-editor/core/wire-codec.ts is the one source of the
 * grammar. This renders it, with the one type import inlined so the mirror reaches outside no repo,
 * through the same renderMirror() the contract mirrors use. tests/chat-canvas-wire-mirror.test.ts
 * compares the committed mirror with a fresh render.
 *
 * Source: env AMIEXPRESS_WEB_ROOT (the amiexpress-web checkout), else the sibling ../amiexpress-web.
 */
import * as fs from 'fs';
import * as path from 'path';
import { renderMirror } from './gen-contract-types';

export const SDK_SOURCE_REL = 'sdk/engines/ui/ansi-editor/core/wire-codec.ts';
export const MIRROR_REL = 'src/chat/canvas-wire-codec.generated.ts';

const ORIGIN = {
  source: SDK_SOURCE_REL,
  generator: 'scripts/gen-canvas-codec.ts',
  repo: 'amiexpress-web',
  keepLeadingComment: true,
};

const CELL_IMPORT = "import type { Cell } from '../types';\n";
const CELL_TYPE = [
  '/** The cell the codec reads and writes (the subset of the SDK Cell it uses). */',
  'export interface Cell {',
  '  char: string;',
  '  fg: number;',
  '  bg: number;',
  '  blink?: boolean;',
  '}',
  '',
].join('\n');

export function sdkSourcePath(): string {
  const root = process.env.AMIEXPRESS_WEB_ROOT ?? path.join(__dirname, '..', '..', 'amiexpress-web');
  return path.join(root, SDK_SOURCE_REL);
}

export function renderCanvasCodecMirror(sourceText: string): string {
  if (!sourceText.includes(CELL_IMPORT)) throw new Error('wire-codec.ts no longer imports Cell the expected way; update the generator');
  const inlined = sourceText.replace(CELL_IMPORT, CELL_TYPE);
  if (/^import /m.test(inlined)) throw new Error('the SDK wire codec grew an import the mirror cannot carry');
  return renderMirror(inlined, ORIGIN);
}

if (require.main === module) {
  const out = process.argv[2] ?? path.join(__dirname, '..', MIRROR_REL);
  fs.writeFileSync(out, renderCanvasCodecMirror(fs.readFileSync(sdkSourcePath(), 'utf-8')), 'utf-8');
  console.log(`[OK] wrote ${out}`);
}
