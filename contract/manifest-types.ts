/**
 * The door-repo wire contract: the manifest shape every client compiles
 * against. Clients vendor a generated mirror of this file (see
 * scripts/gen-contract-types.ts); the version below tells a client whether
 * its mirror is old enough to matter.
 */
export const CONTRACT_VERSION = '1';

export interface ManifestDoor {
  archiveName: string;
  doorType: string;
  name: string | null;
  author: string | null;
  releaseGroup: string | null;
  category: string | null;
  description: string | null;
  fileIdDiz: string | null;
  archiveSize: number | null;
  md5: string | null;
  sha256: string | null;
  junkCount: number;
  hasDoc: boolean;
}

export interface DoorRepoManifest {
  formatVersion: 1;
  revision: string;
  generatedAt: string;
  doors: ManifestDoor[];
}
