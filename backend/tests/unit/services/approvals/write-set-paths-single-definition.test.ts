// tests/unit/services/approvals/write-set-paths-single-definition.test.ts
//
// ONE write-set path predicate — in src/services/approvals/write-set-paths.ts and nowhere
// else — and the write-set read route, the constraint-check fence AND the A3 mint/decide
// gate (u3-gates.ts) all import it.
// Modelled on tests/unit/domain/web-only-single-definition.test.ts.
//
// ⛔ WHY. The read route (GET /api/approvals/:id/write-set) and the landing fence must agree
// on what a path is. A behavioural test cannot see a duplicate that happens to agree today;
// this guard can. (U4-diff-scope-recon.md § WRITE_SET PATH FORMAT.)
//
// ⚠️ THE PATTERNS ARE ASSEMBLED AT RUNTIME, so this file never matches itself.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** repo root: .../backend/tests/unit/services/approvals → up five. */
const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const SRC = join(REPO, 'backend', 'src');
const HOME = 'backend/src/services/approvals/write-set-paths.ts';
const IMPORTERS = [
  'backend/src/routes/approval-write-set.ts', // the read route
  'backend/src/routes/project-constraint-check.ts', // the fence
  'backend/src/services/approvals/u3-gates.ts', // A3 mint + decide (movies-d2: the write set is validated by the SAME predicate it is later fenced with)
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** A DEFINITION (const/let/var/function), never an import or a use. */
function definitionRe(name: string): RegExp {
  return new RegExp(`(?:\\b(?:const|let|var)\\s+${name}\\b|\\bfunction\\s+${name}\\s*\\()`);
}

function definers(re: RegExp): string[] {
  return walk(SRC)
    .filter((f) => readFileSync(f, 'utf8').split('\n').some((l) => re.test(l)))
    .map((f) => relative(REPO, f));
}

const NAMES = [
  ['is', 'Valid', 'WriteSetPath'].join(''),
  ['assert', 'WriteSet', 'Paths'].join(''),
  // the pre-amendment predicate's name: it must not come back anywhere
  ['is', 'WriteSetPath'].join(''),
];

/**
 * `import { …name… } from '…/services/approvals/write-set-paths'` (multi-line aware), or from
 * the sibling `'./write-set-paths'` for a module that lives in services/approvals itself.
 */
function importRe(name: string): RegExp {
  return new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'(?:[./]*services/approvals/|\\./)write-set-paths'`);
}

function importsFromHome(file: string, name: string): boolean {
  const src = readFileSync(join(REPO, file), 'utf8');
  const re = importRe(name);
  return re.test(src);
}

describe('write-set path predicate: exactly one definition, in write-set-paths.ts', () => {
  test(`${NAMES[0]} is defined exactly once, in ${HOME}`, () => {
    expect(definers(definitionRe(NAMES[0]!))).toEqual([HOME]);
  });
  test(`${NAMES[1]} is defined exactly once, in ${HOME}`, () => {
    expect(definers(definitionRe(NAMES[1]!))).toEqual([HOME]);
  });
  test(`the pre-amendment ${NAMES[2]} is defined nowhere`, () => {
    expect(definers(definitionRe(NAMES[2]!))).toEqual([]);
  });

  for (const f of IMPORTERS) {
    test(`${f} imports ${NAMES[1]} from write-set-paths`, () => {
      expect(importsFromHome(f, NAMES[1]!)).toBe(true);
    });
  }

  test('CONTROL: the instrument finds a definition it is pointed at (and only there)', () => {
    expect(definers(definitionRe(['compare', 'Bytes'].join('')))).toEqual([HOME]);
    expect(definers(definitionRe(['resolveApproval', 'WriteSet'].join('')))).toEqual([
      'backend/src/services/approvals/write-set.ts',
    ]);
  });

  test('CONTROL: a pasted duplicate WOULD be caught; an import would not', () => {
    const name = NAMES[0]!;
    expect(definitionRe(name).test(`function ${name}(p: string): boolean {`)).toBe(true);
    expect(definitionRe(name).test(`const ${name} = (p: string) => true;`)).toBe(true);
    expect(definitionRe(name).test(`import { ${name} } from '../services/approvals/write-set-paths';`)).toBe(false);
  });

  test('CONTROL: the importer check accepts the full and the sibling path, and nothing else', () => {
    const imp = (from: string) => `import { ${NAMES[1]}, WriteSetPathsError } from '${from}';`;
    const re = (src: string) => importRe(NAMES[1]!).test(src);
    expect(re(imp('../services/approvals/write-set-paths'))).toBe(true);
    expect(re(imp('./write-set-paths'))).toBe(true);
    expect(re(imp('./other/write-set-paths'))).toBe(false);
    expect(re(imp('../lib/write-set-paths-copy'))).toBe(false);
  });
});
