/**
 * NOTHING IN scripts/ MAY IMPORT FROM tests/.
 *
 * The Dockerfile copies `src`, `contract`, `scripts`, `seeds` and `wasm`
 * into the build stage and runs `npm run build` there (Dockerfile:14-23).
 * `tests/` is deliberately NOT copied - it has no business in a production
 * image - so a script that imports a test helper compiles here and fails
 * inside Docker with TS2307, taking the whole deploy with it. That is what
 * `scripts/capture-achievements-examples.ts` did on 2026-09-07: green
 * locally, green in the Tests workflow, and the deploy dead on the build
 * step.
 *
 * A tool that needs the test harness belongs BESIDE the harness. The
 * capture entry point now lives at tests/achievements/capture-doc-examples.ts
 * and `npm run capture:achievements-doc` points there.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '..', '..');

/** The directories the production image compiles. */
const SHIPPED = ['src', 'contract', 'scripts'];

function tsFilesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Every module specifier a file imports or requires. */
function importsOf(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const m of source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

describe('what the production image compiles', () => {
  it('reads the shipped directories, not an empty list', () => {
    const files = SHIPPED.flatMap((dir) => tsFilesIn(path.join(REPO, dir)));
    expect(files.length).toBeGreaterThan(20);
  });

  it('never reaches into tests/, which Docker does not copy', () => {
    const offenders: string[] = [];
    for (const dir of SHIPPED) {
      for (const file of tsFilesIn(path.join(REPO, dir))) {
        for (const specifier of importsOf(file)) {
          if (!specifier.startsWith('.')) continue;
          const resolved = path.resolve(path.dirname(file), specifier);
          if (resolved.startsWith(path.join(REPO, 'tests'))) {
            offenders.push(`${path.relative(REPO, file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the Dockerfile and this test naming the same directories', () => {
    const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
    for (const dir of SHIPPED) {
      expect(dockerfile).toContain(`COPY ${dir} ./${dir}`);
    }
    // The guard is only meaningful while tests/ stays out of the image.
    expect(dockerfile).not.toContain('COPY tests');
  });
});
