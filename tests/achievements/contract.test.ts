/**
 * AC-3 - the contract, and the guard that keeps the prose and the types
 * from drifting apart.
 *
 * Shaped on tests/contract-mirror.test.ts, with the addition the plan asks
 * for: every status code and every field name docs/ACHIEVEMENTS-API.md
 * names must EXIST in contract/achievement-types.ts. SP2 and SP4 read the
 * document and compile against the module; if a field can be in one and not
 * the other, the document is a second contract and the two will disagree
 * exactly once, in production.
 *
 * The direction is deliberate - document to module. A module symbol with no
 * prose is merely undocumented; a documented field with no symbol is a lie
 * a client will code against.
 */
import * as fs from 'fs';
import * as path from 'path';
import { renderMirror } from '../../scripts/gen-contract-types';
import {
  ACHIEVEMENTS_CONTRACT_VERSION,
  ACHIEVEMENTS_TEXT_FORMAT,
  ACHIEVEMENTS_TEXT_VERSION,
  ADMIN_ENDPOINTS,
  CATALOG_TXT_FIELDS,
  ENDPOINTS,
  ERROR_CODES,
  LEADERBOARD_TXT_FIELDS,
  REJECT_REASONS,
  STATUS_CODES,
} from '../../contract/achievement-types';

const REPO = path.join(__dirname, '..', '..');
const CONTRACT_PATH = path.join(REPO, 'contract', 'achievement-types.ts');
const DOC_PATH = path.join(REPO, 'docs', 'ACHIEVEMENTS-API.md');

const contractSource = fs.readFileSync(CONTRACT_PATH, 'utf-8');
const doc = fs.readFileSync(DOC_PATH, 'utf-8');

/**
 * `doors` is the DOOR-REPO health object's own field. It appears in this
 * document only to show a client where the `achievements` key lands inside
 * a response this contract does not own. Nothing else is exempt.
 */
const FOREIGN_JSON_KEYS = new Set(['doors']);

/** Present as a property declaration, or as a string literal in a const array. */
function declaredInContract(name: string): boolean {
  const asProperty = new RegExp(`(?:^|[^A-Za-z0-9_])${name}\\??\\s*:`, 'm');
  return asProperty.test(contractSource) || contractSource.includes(`'${name}'`);
}

/** Every key of every ```json example in the document. */
function jsonKeysInDoc(): string[] {
  const keys = new Set<string>();
  for (const block of doc.matchAll(/```json\n([\s\S]*?)```/g)) {
    for (const key of block[1].matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)) {
      keys.add(key[1]);
    }
  }
  return [...keys].sort();
}

/** Every `backticked` token in the document, by shape. */
function backtickedTokens(): string[] {
  return [...new Set([...doc.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map((m) => m[1]))].sort();
}

/** `| POST | `/players` | ...` rows out of the document's own tables. */
function documentedEndpoints(): string[] {
  return [...doc.matchAll(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|/gm)].map(
    (m) => `${m[1]} ${m[2]}`
  );
}

describe('the achievements contract', () => {
  it('declares a version', () => {
    expect(ACHIEVEMENTS_CONTRACT_VERSION).toBe('1');
    expect(ACHIEVEMENTS_TEXT_FORMAT).toBe('ACHIEVE');
    expect(ACHIEVEMENTS_TEXT_VERSION).toBe('1');
  });

  it('renders a vendorable mirror that names its own source', () => {
    const mirror = renderMirror(contractSource, {
      source: 'contract/achievement-types.ts',
      generator: 'scripts/gen-achievement-types.ts',
    });
    expect(mirror).toContain('GENERATED FILE');
    expect(mirror).toContain('ACHIEVEMENTS_CONTRACT_VERSION');
    expect(mirror).toContain('export interface EventsResponse');
    expect(mirror).toContain('export interface PlayerProfile');
    // A vendored mirror is one file with no module graph behind it.
    expect(mirror).not.toMatch(/^import /m);
    // It must not claim to be the door-repo manifest mirror.
    expect(mirror).toContain('Mirror of amiexpress-doorserver contract/achievement-types.ts');
    expect(mirror).toContain('npx tsx scripts/gen-achievement-types.ts');
    expect(mirror).not.toContain('manifest-types.ts');
  });

  it('leaves the door-repo manifest mirror byte-identical', () => {
    // renderMirror gained two optional parameters so ONE generator can serve
    // two contract files. The default output must not have moved a byte, or
    // DOORMAN's vendored mirror goes stale for no reason at all.
    const manifestSource = fs.readFileSync(path.join(REPO, 'contract', 'manifest-types.ts'), 'utf-8');
    const mirror = renderMirror(manifestSource);
    expect(mirror).toContain(' * Mirror of amiexpress-doorserver contract/manifest-types.ts.');
    expect(mirror).toContain(' * Regenerate with: npx tsx scripts/gen-contract-types.ts');
    expect(mirror).toContain('export interface ManifestDoor');
  });

  it('names every endpoint the document documents, and documents every endpoint it names', () => {
    const documented = documentedEndpoints();
    const boardFacing = documented.filter((e) => !e.includes('/admin/'));
    const admin = documented.filter((e) => e.includes('/admin/'));

    expect([...boardFacing].sort()).toEqual([...ENDPOINTS].sort());
    expect([...admin].sort()).toEqual([...ADMIN_ENDPOINTS].sort());
    expect(ENDPOINTS).toHaveLength(15);
  });

  it('gives every endpoint its own section with a worked example', () => {
    // `<door>` and `<email>` are HTML-escaped in the headings, or markdown
    // eats them; unescape before comparing.
    const sections = doc.split(/^### /m).slice(1);
    const byHeading = new Map<string, string>();
    for (const section of sections) {
      const heading = section.split('\n')[0].replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      byHeading.set(heading, section);
    }
    for (const endpoint of ENDPOINTS) {
      const section = byHeading.get(endpoint);
      expect(section).toBeDefined();
      // A worked example, not just prose.
      expect(section).toContain('```');
    }
  });

  it('carries every field name the document names', () => {
    const missing = jsonKeysInDoc().filter((k) => !FOREIGN_JSON_KEYS.has(k) && !declaredInContract(k));
    expect(missing).toEqual([]);
  });

  it('carries every camelCase and snake_case wire name the document names', () => {
    const tokens = backtickedTokens();
    const camel = tokens.filter((t) => /^[a-z][a-zA-Z0-9]*$/.test(t) && /[A-Z]/.test(t));
    const snake = tokens.filter((t) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(t));

    expect(camel.filter((t) => !declaredInContract(t))).toEqual([]);
    // Every snake_case token in the prose is an error code, a reject reason
    // or a plain-text column - there is no fourth kind, and a DB column name
    // must never leak into a wire document.
    const known = new Set<string>([
      ...ERROR_CODES,
      ...REJECT_REASONS,
      ...CATALOG_TXT_FIELDS,
      ...LEADERBOARD_TXT_FIELDS,
    ]);
    expect(snake.filter((t) => !known.has(t))).toEqual([]);
    expect(snake.length).toBeGreaterThan(0);
  });

  it('carries every status code the document names', () => {
    const documented = [
      ...new Set([...doc.matchAll(/`([1-5][0-9]{2})`/g)].map((m) => Number(m[1]))),
    ].sort((a, b) => a - b);
    const declared = [...STATUS_CODES].sort((a, b) => a - b);

    expect(documented.filter((c) => !declared.includes(c as (typeof STATUS_CODES)[number]))).toEqual([]);
    expect(documented).toEqual(declared);
  });

  it('names every reject reason the per-event verdict can carry', () => {
    // D3: a per-event verdict, not a whole-batch refusal. Each reason has to
    // be documented as TERMINAL, or SP2's flusher will retry it for ever.
    for (const reason of REJECT_REASONS) {
      expect(doc).toContain(`\`${reason}\``);
    }
    expect(doc).toMatch(/TERMINAL/);
    expect(doc).toMatch(/RETRYABLE/);
  });

  it('documents the three server-internal meta types, including meta.board_first', () => {
    // D9: without meta.board_first, rare.newboard.first is expressible by no
    // operator in the table and would ship unreachable.
    expect(doc).toContain('meta.link');
    expect(doc).toContain('meta.unlock');
    expect(doc).toContain('meta.board_first');
    expect(doc).toContain('meta_type_rejected');
  });

  it('documents the immutability digest as covering the name and the description', () => {
    // D8: a mutable display name would need a policy for what a player who
    // already unlocked "First Blood" sees when it becomes something else.
    const section = doc.split(/^### /m).find((s) => s.startsWith('PUT /catalog/doors'));
    expect(section).toBeDefined();
    expect(section).toMatch(/covers the `id`, the `name`, the `description` and the `rule`/);
    expect(section).toContain('definition_changed');
  });
});
