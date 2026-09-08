/**
 * The requests contract, and the guard that keeps the prose and the types
 * from drifting apart. Shaped on tests/achievements/contract.test.ts: every
 * endpoint the document documents must be named in the module and vice
 * versa, and the vendorable mirror must render from the one generator.
 */
import * as fs from 'fs';
import * as path from 'path';
import { renderMirror } from '../../scripts/gen-contract-types';
import {
  REQUESTS_CONTRACT_VERSION,
  REQUESTS_TEXT_FORMAT,
  REQUESTS_TEXT_VERSION,
  REQUEST_ADMIN_ENDPOINTS,
  REQUEST_ENDPOINTS,
  REQUEST_ERROR_CODES,
  REQUEST_STATUS_CODES,
} from '../../contract/request-types';

const REPO = path.join(__dirname, '..', '..');
const CONTRACT_PATH = path.join(REPO, 'contract', 'request-types.ts');
const DOC_PATH = path.join(REPO, 'docs', 'REQUESTS-API.md');

const contractSource = fs.readFileSync(CONTRACT_PATH, 'utf-8');
const doc = fs.readFileSync(DOC_PATH, 'utf-8');

/** `| POST | `/requests` | ...` rows out of the document's own tables. */
function documentedEndpoints(): string[] {
  return [...doc.matchAll(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|/gm)].map((m) => `${m[1]} ${m[2]}`);
}

describe('the requests contract', () => {
  it('declares a version and the text-format literals', () => {
    expect(REQUESTS_CONTRACT_VERSION).toBe('1');
    expect(REQUESTS_TEXT_FORMAT).toBe('REQUEST');
    expect(REQUESTS_TEXT_VERSION).toBe('1');
  });

  it('renders a vendorable mirror that names its own source', () => {
    const mirror = renderMirror(contractSource, {
      source: 'contract/request-types.ts',
      generator: 'scripts/gen-request-types.ts',
    });
    expect(mirror).toContain('GENERATED FILE');
    expect(mirror).toContain('REQUESTS_CONTRACT_VERSION');
    expect(mirror).toContain('export interface ListResponse');
    expect(mirror).toContain('export interface RequestDetail');
    expect(mirror).not.toMatch(/^import /m);
    expect(mirror).toContain('Mirror of amiexpress-doorserver contract/request-types.ts');
    expect(mirror).toContain('npx tsx scripts/gen-request-types.ts');
    expect(mirror).not.toContain('manifest-types.ts');
    expect(mirror).not.toContain('achievement-types.ts');
  });

  it('names every endpoint the document documents, and documents every endpoint it names', () => {
    const documented = documentedEndpoints();
    const boardFacing = documented.filter((e) => !e.includes('/admin/'));
    const admin = documented.filter((e) => e.includes('/admin/'));
    expect([...boardFacing].sort()).toEqual([...REQUEST_ENDPOINTS].sort());
    expect([...admin].sort()).toEqual([...REQUEST_ADMIN_ENDPOINTS].sort());
    expect(REQUEST_ENDPOINTS).toHaveLength(11);
  });

  it('gives every endpoint its own section', () => {
    const sections = doc.split(/^### /m).slice(1);
    const headings = new Set(sections.map((s) => s.split('\n')[0].replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()));
    for (const endpoint of REQUEST_ENDPOINTS) expect(headings.has(endpoint)).toBe(true);
  });

  it('documents every error code and every status code it can answer with', () => {
    for (const code of REQUEST_ERROR_CODES) expect(doc).toContain(`\`${code}\``);
    const documented = [...new Set([...doc.matchAll(/`([1-5][0-9]{2})`/g)].map((m) => Number(m[1]))),].sort((a, b) => a - b);
    const declared = [...REQUEST_STATUS_CODES].sort((a, b) => a - b);
    expect(documented.filter((c) => !declared.includes(c as (typeof REQUEST_STATUS_CODES)[number]))).toEqual([]);
    expect(documented).toEqual(declared);
  });

  it('repeats the three append-only MUSTs of the plain-text format', () => {
    expect(doc).toMatch(/append-only/i);
    expect(doc).toContain('REQUEST|1|');
    expect(doc).toMatch(/CRLF/);
    expect(doc).toMatch(/ISO-8859-1/);
  });
});
