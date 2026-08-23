import * as fs from 'fs';
import * as path from 'path';
import { renderMirror } from '../scripts/gen-contract-types';
import { CONTRACT_VERSION } from '../contract/manifest-types';

describe('contract', () => {
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
