/** What the door server's JSON API returns. Mirrors src/public-routes.ts. */

export interface Door {
  archiveName: string;
  system: string;
  /** A short label fit for a column: never the DIZ's border art. */
  name: string;
  /** What the corpus scan put in the `name` column, art and all. */
  catalogName: string;
  /** Where the shown name came from; 'archive' means it is a guess. */
  nameSource: 'catalog' | 'program' | 'archive';
  description: string;
  descriptionSource: 'edited' | 'diz';
  version: string | null;
  author: string | null;
  releaseGroup: string | null;
  releaseGroupFullName: string | null;
  category: string | null;
  doorType: string;
  requiresBbs: string | null;
  size: number;
  md5: string | null;
  sha256: string | null;
  junkCount: number;
  adsStripped: boolean;
  hasDoc: boolean;
  downloadUrl: string;
  votesUp: number;
  votesDown: number;
  indexedAt: number;
  /** Demozoo enrichment. null when the importer has not seen this door. */
  releaseDate: string | null;
  platform: string | null;
  credits: DemozooCredit[] | null;
  externalLinks: string[] | null;
  screenshots: { thumbnailUrl: string; standardUrl: string }[] | null;
  /** Direct link to the Demozoo production page, if the row was enriched. */
  demozooUrl: string | null;
}

/**
 * A single credit entry from a Demozoo production's credits list.
 * The `nick` is the display handle (often the same as `releaser.name`
 * for individuals, or a separate string for group nicks). The
 * `releaser` is the Demozoo entity — a person or a group — and has
 * the full name + canonical id. `abbreviation` is the scene-style
 * short tag (e.g. "TRSI" for Tristar and Red Sector Inc).
 */
export interface DemozooNick {
  name: string;
  abbreviation: string;
  releaser: {
    url: string;
    id: number;
    name: string;
    is_group: boolean;
  };
}

export interface DemozooCredit {
  nick: DemozooNick;
  category: string;
  role: string;
}

export interface DoorFile {
  path: string;
  size: number;
  isJunk: boolean;
  junkReason: string | null;
}

export interface GuideNode {
  name: string;
  title: string;
  content: string;
  links: { text: string; target: string }[];
}

export interface Guide {
  database: string;
  mainNode: string;
  nodes: GuideNode[];
}

export interface DoorDetail extends Door {
  /** 'amigaguide' when the door ships a .guide rather than a README. */
  docFormat: 'amigaguide' | 'text';
  guide: Guide | null;
  fileIdDiz: string | null;
  docFilename: string | null;
  doc: string | null;
  suggestedTooltypes: string | null;
  files: DoorFile[];
}

export interface DoorPage {
  revision: string;
  total: number;
  page: number;
  perPage: number;
  sort: string;
  dir: 'asc' | 'desc';
  rows: Door[];
}

export interface Facet {
  value: string | null;
  n: number;
}

export interface Facets {
  revision: string;
  systems: Facet[];
  types: Facet[];
  categories: Facet[];
  requires: Facet[];
}

export interface AdminUser {
  id: number;
  username: string;
  role: string;
}

export interface FieldState {
  scanned: string | null;
  derived: string | null;
  edited?: string | null;
  isEdited: boolean;
}

export interface HiddenDoor {
  archiveName: string;
  catalogName: string;
  reason: string | null;
  hiddenAt: number;
  hiddenBy: string | null;
}

export interface AdminDoor {
  id: string;
  archiveName: string;
  /** True when this door has been taken out of the repository. */
  hidden: boolean;
  fileIdDiz: string | null;
  doc: string | null;
  docFilename: string | null;
  fields: Record<string, FieldState>;
}

export interface DerivedMetadata {
  name: string;
  description: string;
  version: string;
  author: string;
  requiresBbs: string;
  binaryName: string | null;
  fileIdDiz: string | null;
  docFilename: string | null;
  doc: string | null;
  files: { path: string; size: number }[];
  /** True when the submitter typed at least one field themselves rather
   *  than every field being guessed from the archive - absent (undefined)
   *  on a submission stored before this field existed, which reads the
   *  same as false. */
  submitterProvided?: boolean;
}

export interface Submission {
  /** Read out of the archive when it arrived; null for a format we cannot read. */
  derived: DerivedMetadata | null;
  id: string;
  archiveName: string;
  size: number;
  md5: string;
  sha256: string;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  rejectReason: string | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface AuditEntry {
  id: number;
  action: string;
  target: string;
  detail: unknown;
  at: number;
  by: string | null;
}

export interface DoorFacts {
  description: string;
  version: string;
  author: string;
  requiresBbs: string;
}

export interface StripPreviewFile {
  path: string;
  size: number;
  md5: string;
}

export interface StripPreview {
  archiveName: string;
  kept: StripPreviewFile[];
  stripped: StripPreviewFile[];
  reason: Record<string, 'pattern' | 'md5' | 'content-scan'>;
  /** Paths the admin has marked as explicitly not junk — always kept. */
  notJunk?: string[];
}

export interface StripResult {
  ok: boolean;
  removed?: number;
  newJunkCount?: number;
  reason?: string;
}

export const EDITABLE_FIELDS = [
  'name',
  'description',
  'version',
  'author',
  'release_group',
  'category',
  'door_type',
  'requires_bbs',
  'binary_name',
  'suggested_tooltypes',
  'file_id_diz',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];
