/**
 * The chat contract and the guard that keeps docs/CHAT-API.md and
 * contract/chat-types.ts from drifting apart.
 */
import * as fs from 'fs';
import * as path from 'path';
import { renderMirror } from '../scripts/gen-contract-types';
import {
  CHAT_CONTRACT_VERSION,
  CHAT_ENDPOINTS,
  CHAT_ERROR_CODES,
  CHAT_EVENT_TYPES,
  CHAT_TEXT_FORMATS,
  CHAT_TEXT_VERSION,
} from '../contract/chat-types';

const REPO = path.join(__dirname, '..');
const contractSource = fs.readFileSync(path.join(REPO, 'contract', 'chat-types.ts'), 'utf-8');
const doc = fs.readFileSync(path.join(REPO, 'docs', 'CHAT-API.md'), 'utf-8');

function documentedEndpoints(): string[] {
  return [...doc.matchAll(/^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|/gm)].map((m) => `${m[1]} ${m[2]}`);
}

function exampleBlocks(): string[][] {
  return [...doc.matchAll(/```text example \w+\n([\s\S]*?)```/g)].map((m) => m[1].split('\n').filter((l) => l.length > 0));
}

describe('the chat contract', () => {
  it('declares its versions', () => {
    expect(CHAT_CONTRACT_VERSION).toBe('1');
    expect(CHAT_TEXT_VERSION).toBe('1');
  });

  it('renders a vendorable mirror', () => {
    const mirror = renderMirror(contractSource, { source: 'contract/chat-types.ts', generator: 'scripts/gen-chat-types.ts' });
    expect(mirror).toContain('GENERATED FILE');
    expect(mirror).toContain('CHAT_CONTRACT_VERSION');
    expect(mirror).not.toMatch(/^import /m);
  });

  it('documents exactly the endpoints the contract names', () => {
    expect([...documentedEndpoints()].sort()).toEqual([...CHAT_ENDPOINTS].sort());
    expect(CHAT_ENDPOINTS).toHaveLength(80);
  });

  it('documents every error code and every event type', () => {
    for (const code of CHAT_ERROR_CODES) expect(doc).toContain(`\`${code}\``);
    for (const type of CHAT_EVENT_TYPES) expect(doc).toContain(`\`${type}\``);
  });

  it('has example rows that parse against their format', () => {
    const blocks = exampleBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    const seen = new Set<string>();
    for (const lines of blocks) {
      const head = lines[0].split('|');
      const name = head[0] as keyof typeof CHAT_TEXT_FORMATS;
      expect(CHAT_TEXT_FORMATS[name]).toBeDefined();
      seen.add(name);
      expect(head[1]).toBe(CHAT_TEXT_VERSION);
      expect(Number(head[3])).toBe(lines.length - 1);
      for (const row of lines.slice(1)) {
        expect(row.split('|')).toHaveLength(CHAT_TEXT_FORMATS[name].length);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(CHAT_TEXT_FORMATS).sort());
  });

  it('leaves nothing undecided', () => {
    expect(doc).not.toMatch(/TBD/);
    expect(doc).toMatch(/CRLF/);
    expect(doc).toMatch(/ISO-8859-1/);
    expect(doc).toMatch(/Content-Length/);
  });
});
