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
  category: string | null;
  doorType: string;
  requiresBbs: string | null;
  size: number;
  md5: string | null;
  sha256: string | null;
  junkCount: number;
  hasDoc: boolean;
  downloadUrl: string;
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
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];
