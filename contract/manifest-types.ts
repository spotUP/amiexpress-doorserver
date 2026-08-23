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
  // Number of files inside the archive flagged as ads/junk, and whether the
  // row carries documentation at all. Both exist so a client can decide what
  // to OFFER before it fetches anything: DOORMAN gates its [S]trip and
  // [V]iew doc footer keys on exactly these two values
  // (amiexpress-web's Doors/door-manager/app.ts, repoViewFooterParts), and a
  // list.txt client had no way to answer either question without a
  // per-entry round trip to /files or /doc — so it advertised keys that
  // then turned out to do nothing.
  junkCount: number;
  hasDoc: boolean;
}

export interface DoorRepoManifest {
  formatVersion: 1;
  revision: string;
  generatedAt: string;
  doors: ManifestDoor[];
}
