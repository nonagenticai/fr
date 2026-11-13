// tests/unit/domain/web-only-single-definition.test.ts
//
// ONE web-only kind list, ONE predicate, ONE marker definition — in
// src/domain/engagement/deblock-actions.ts and nowhere else.
//
// ⛔ WHY. fr#1342 shipped a second `WEB_ONLY_APPROVAL_KINDS` + `isWebOnlyApprovalKind` inside
// the Telegram adapter while fr#1333 held the first in deblock-actions: two lists that
// disagreed (Telegram refused qa.coverage_signoff, Teams did not) and a red
// typecheck on the merge ref. A behavioural test cannot see a duplicate that happens to
// agree today; this guard can. Every other module IMPORTS these names.
//
// ⚠️ THE PATTERNS ARE ASSEMBLED AT RUNTIME, so this file never matches itself.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** repo root: .../backend/tests/unit/domain → up four. */
const REPO = join(import.meta.dir, '..', '..', '..', '..');
const SRC = join(REPO, 'backend', 'src');
const HOME = 'backend/src/domain/engagement/deblock-actions.ts';

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
  ['is', 'BugFix', 'AuthorizationRow'].join(''),
];

describe('the bug-fix marker: exactly one definition, in deblock-actions.ts', () => {
  for (const name of NAMES) {
    test(`${name} is defined exactly once, in ${HOME}`, () => {
      expect(definers(definitionRe(name))).toEqual([HOME]);
    });
  }

  test('CONTROL: the instrument finds a definition it is pointed at (and only there)', () => {
    // A name defined in exactly one other known file — proves the walk and the regex can
    // see a definition outside deblock-actions.ts, so an empty/self-only result is real.
    expect(definers(definitionRe(['answerless', 'ApproveDemand'].join('')))).toEqual([HOME]);
    // ⚠️ THIS ANCHOR MOVED on 2026-10-31: `frApprovalUrl` now lives with the ONE approval
    // menu every text channel renders (domain/engagement/approval-menu.ts) and is
    // re-exported by adapters/telegram.ts, which is a re-export and not a definition. The
    // control tests the INSTRUMENT, not the file, so it follows the definition.
    expect(definers(definitionRe(['frApproval', 'Url'].join('')))).toEqual([
      'backend/src/domain/engagement/approval-menu.ts',
    ]);
  });

  test('CONTROL: a pasted duplicate WOULD be caught', () => {
    const dup = `export const ${NAMES[0]}: readonly string[] = ['qa.coverage_signoff'];`;
    expect(definitionRe(NAMES[0]!).test(dup)).toBe(true);
    expect(definitionRe(NAMES[0]!).test(`import { ${NAMES[0]} } from '../deblock-actions';`)).toBe(false);
  });
});
