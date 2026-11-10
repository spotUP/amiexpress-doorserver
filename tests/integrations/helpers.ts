// tests/integrations/helpers.ts
//
// Recorded-fixture plumbing shared by the integrations tests.
// Fixtures live in ./fixtures (captured live 2026-09-10, never
// hand-written). No live HTTP in test:ci.
import * as fs from 'fs';
import * as path from 'path';
import type { FetchJson } from '../../src/integrations/types';

export const fix = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8'));

export function fixtureFetcher(map: Record<string, string>): FetchJson {
  return async (url: string) => {
    for (const [match, file] of Object.entries(map)) {
      if (url.includes(match)) return fix(file);
    }
    throw new Error(`no fixture for ${url}`);
  };
}

export const ctxOf = (fetchJson: FetchJson) => ({
  fetchJson,
  getSecret: (_: string) => null,
  settings: {},
});

export const ANSWER_FIXTURES: Record<string, string> = {
  'search/prod/': 'pouet-search.json',
  'prod/?random=true': 'pouet-random.json',
  'latest-added': 'pouet-latest.json',
  'productions/?q=': 'demozoo-search.json',
  'productions/1/': 'demozoo-prod-1.json',
  '/api/v1/search': 'asciiarena-search.json',
  '/api/v1/status': 'asciiarena-status.json',
  'advancedsearch': 'ia-search.json',
};
