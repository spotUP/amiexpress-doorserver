/**
 * Staleness check for the generated /draw wire codec mirror (decision D9a): the committed
 * src/chat/canvas-wire-codec.generated.ts must equal a fresh render of the amiexpress-web SDK
 * wire-codec.ts. The SDK checkout is the sibling ../amiexpress-web or $AMIEXPRESS_WEB_ROOT; with
 * neither present only the self-containment checks run.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MIRROR_REL, renderCanvasCodecMirror, sdkSourcePath } from '../scripts/gen-canvas-codec';

const mirror = fs.readFileSync(path.join(__dirname, '..', MIRROR_REL), 'utf-8');
const sdk = sdkSourcePath();
const haveSdk = fs.existsSync(sdk);

describe('the canvas wire codec mirror', () => {
  it('names its source and generator and reaches outside no repo', () => {
    expect(mirror).toContain('GENERATED FILE');
    expect(mirror).toContain('Mirror of amiexpress-web sdk/engines/ui/ansi-editor/core/wire-codec.ts.');
    expect(mirror).toContain('npx tsx scripts/gen-canvas-codec.ts');
    expect(mirror).not.toMatch(/^import /m);
  });

  (haveSdk ? it : it.skip)('equals a fresh render of the SDK wire-codec.ts', () => {
    expect(mirror).toBe(renderCanvasCodecMirror(fs.readFileSync(sdk, 'utf-8')));
  });
});
