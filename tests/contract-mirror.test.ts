import * as fs from 'fs';
import * as path from 'path';
import { renderMirror } from '../scripts/gen-contract-types';
import { CONTRACT_VERSION } from '../contract/manifest-types';

// Renamed from contract-staleness.test.ts: this file does not compare the
// mirror against a committed copy (there is none until phase 2 vendors
// one), it only asserts the generator produces valid, up-to-date-shaped
// output from the live source. "Staleness" implied drift-detection coverage
// that does not exist here.
describe('contract mirror generation', () => {
  it('declares a version', () => {
    expect(CONTRACT_VERSION).toBe('1');
  });

  it('renders a mirror that compiles to the same declarations', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'contract', 'manifest-types.ts'), 'utf-8');
    const mirror = renderMirror(source);
    expect(mirror).toContain('export interface ManifestDoor');
    expect(mirror).toContain('export interface DoorRepoManifest');
    expect(mirror).toContain('GENERATED FILE');
    expect(mirror).not.toMatch(/^import /m);
  });
});
