/**
 * The releases wire contract: the shapes every client compiles against.
 *
 * Releases are the AquaScan BBS file listing (all release types, 1988–2026),
 * served from their own database by amiexpress-doorserver as a second surface
 * beside the door repo. No archives live here, only the listing.
 *
 * RELEASES_CONTRACT_VERSION is echoed on every response as
 * X-Releases-Contract. It bumps only for a change a client cannot absorb by
 * ignoring what it does not know (removed field, changed meaning/type/status).
 */
export const RELEASES_CONTRACT_VERSION = '1';

export interface ReleaseRow {
  id: number;
  dirNo: number;
  fileNo: number;
  filename: string;
  /** N/P/D/F/O as listed (D = nuked/deleted); '' when the column was blank. */
  flag: string;
  /** Bytes, or null when the size column holds a nuke reason. */
  sizeBytes: number | null;
  /** The raw size column when it is not bytes (`>NUKED<`, `DELETED`, …). */
  sizeNote: string | null;
  /** Entry date, YYYY-MM-DD. */
  dateIso: string;
  /** `d/L tIMES:` download count, newer entries only. */
  dlCount: number | null;
  uploader: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
}

export interface ReleaseListResponse {
  contractVersion: string;
  revision: string;
  total: number;
  offset: number;
  limit: number;
  rows: ReleaseRow[];
}

export interface ReleaseHealth {
  status: 'ok';
  contractVersion: string;
  revision: string;
  files: number;
}

export interface ReleasesApiError {
  error: string;
}
