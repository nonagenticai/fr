// The coverage rule must ASK FOR SOMETHING THE REGISTRY CAN EXPRESS.
//
// `registry.ts`'s NAME_RE is /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/ — no hyphens —
// ('demo-tool.read' throws). runCoverageCheck used
// to build its required prefix from the integration file's basename VERBATIM, so
// for every hyphenated filename it demanded an action name that registerAction is
// contractually forbidden to accept: unsatisfiable, not unfinished.
//
// These tests are the falsifier. Make `actionNamespaceFor` the identity function
// and the first one goes RED on every hyphenated module in src/integrations.

import { test, expect, describe } from 'bun:test';
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { actionNamespaceFor } from '../../../src/agui/coverage-check';

/** The prefix segment of registry.ts's NAME_RE, verbatim. */
const NAME_PREFIX_RE = /^[a-z][a-z0-9_]*$/;

const INTEGRATIONS_DIR = path.resolve(import.meta.dir, '..', '..', '..', 'src', 'integrations');

function integrationBasenames(): string[] {
  return readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => path.basename(e.name, '.ts'))
    .filter((b) => !b.startsWith('_'));
}

describe('E-14 coverage namespace', () => {
  test('every integration module maps to a namespace registerAction can accept', () => {
    const offenders = integrationBasenames()
      .map((base) => ({ base, ns: actionNamespaceFor(base) }))
      .filter(({ ns }) => !NAME_PREFIX_RE.test(ns));

    expect(offenders).toEqual([]);
  });

  // Non-vacuity guard. Without this, the test above would still pass if every
  // filename happened to be underscore-only today AND the normalisation were
  // deleted — it would be asserting nothing. This asserts the normalisation is
  // doing real work on the real tree: at least one basename is NOT already a
  // legal prefix, i.e. the raw-basename rule really was unsatisfiable.
  test('the raw basename rule was genuinely unsatisfiable for at least one module', () => {
    const rawFailures = integrationBasenames().filter((b) => !NAME_PREFIX_RE.test(b));

    expect(rawFailures.length).toBeGreaterThan(0);
    // ...and normalisation must fix every single one of them.
    for (const base of rawFailures) {
      expect(NAME_PREFIX_RE.test(actionNamespaceFor(base))).toBe(true);
    }
  });

  test('a namespace is only ever hyphen-for-underscore, never a rename', () => {
    expect(actionNamespaceFor('quality-history')).toBe('quality_history');
    expect(actionNamespaceFor('kag')).toBe('kag');
    expect(actionNamespaceFor('improvement_cards')).toBe('improvement_cards');
  });
});
