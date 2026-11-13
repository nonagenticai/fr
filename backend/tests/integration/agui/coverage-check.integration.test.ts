// E-14 — Integration coverage check tests.
//
// The classification rules are pure (`integrationModuleBasenames`,
// `classifyCoverage`) and are exercised with plain data. The boot-acceptance
// test runs the production `runCoverageCheck()` against the real
// `src/integrations` tree after the production `registerAllActions()`.

import { test, expect, describe } from 'bun:test';
import path from 'node:path';

import {
  classifyCoverage,
  integrationModuleBasenames,
  runCoverageCheck,
} from '../../../src/agui/coverage-check';

function readAction(name: string): { kind: string; name: string } {
  return { kind: 'read', name };
}

describe('integrationModuleBasenames', () => {
  test('keeps .ts sources; skips _-prefixed shared modules, *.test.ts and non-ts entries', () => {
    expect(integrationModuleBasenames(['a.ts', 'b.ts', '_lib.ts', 'c.test.ts', 'README.md'])).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('classifyCoverage (E-14)', () => {
  test('covered + uncovered modules classified by basename', () => {
    const report = classifyCoverage(['a', 'b'], [readAction('a.list_things')], {}, 0);
    expect(report.totalIntegrations).toBe(2);
    expect(report.totalRegisteredActions).toBe(1);
    expect(report.uncoveredModules).toEqual(['b']);
  });

  test('action whose name does not start with "<namespace>." does NOT cover the module', () => {
    const report = classifyCoverage(['kanban'], [readAction('planka.list_boards')], {}, 0);
    expect(report.uncoveredModules).toEqual(['kanban']);
  });

  test('a hyphenated module is covered by its underscored namespace', () => {
    const report = classifyCoverage(['demo-tool'], [readAction('demo_tool.read')], {}, 0);
    expect(report.uncoveredModules).toEqual([]);
  });

  test('write-kind action with matching prefix does NOT cover the module (reads only)', () => {
    const report = classifyCoverage(['decisions'], [{ kind: 'write', name: 'decisions.create_one' }], {}, 0);
    expect(report.uncoveredModules).toEqual(['decisions']);
  });

  test('multiple actions under the same prefix count once; siblings still tracked', () => {
    const report = classifyCoverage(
      ['kag', 'workers'],
      [readAction('kag.list_nodes'), readAction('kag.list_edges')],
      {},
      0,
    );
    expect(report.totalIntegrations).toBe(2);
    expect(report.totalRegisteredActions).toBe(2);
    expect(report.uncoveredModules).toEqual(['workers']);
  });
});

// ---------------------------------------------------------------------------
// KNOWN_UNCOVERED integrity.
//
// The exemption list is the thing that lets this check go green while modules
// remain uncovered, so it is the thing most able to rot into a lie. These rules
// are errors in EVERY mode, warn included.
// ---------------------------------------------------------------------------
describe('classifyCoverage — KNOWN_UNCOVERED integrity', () => {
  const LONG_REASON = 'a genuine, specific reason that is comfortably long enough';

  test('ROT: an entry naming a module that no longer exists is an error', () => {
    expect(() => classifyCoverage(['real'], [], { deleted_module: LONG_REASON }, 1)).toThrow(
      /ROT: "deleted_module"/,
    );
  });

  test('REDUNDANT: an entry for a module that IS covered is an error', () => {
    expect(() =>
      classifyCoverage(['covered'], [readAction('covered.list_things')], { covered: LONG_REASON }, 1),
    ).toThrow(/REDUNDANT: "covered"/);
  });

  test('VACUOUS: a too-short reason is an error', () => {
    expect(() => classifyCoverage(['thing'], [], { thing: 'todo' }, 1)).toThrow(/VACUOUS: "thing"/);
  });

  test('RATCHET: more entries than MAX_KNOWN_UNCOVERED is an error', () => {
    expect(() =>
      classifyCoverage(['one', 'two'], [], { one: LONG_REASON, two: LONG_REASON }, 1),
    ).toThrow(/RATCHET/);
  });

  test('a KNOWN entry is excused; an UNKNOWN one is still reported uncovered', () => {
    // The check must still be able to go red for a NEW uncovered module. If it
    // could not, the exemption list would have turned a failing check into a
    // decorative one.
    const report = classifyCoverage(['excused', 'brand_new'], [], { excused: LONG_REASON }, 1);
    expect(report.knownUncoveredModules).toEqual(['excused']);
    expect(report.uncoveredModules).toEqual(['brand_new']);
  });

  test('the REAL KNOWN_UNCOVERED list is honest against the real tree', async () => {
    const { KNOWN_UNCOVERED, MAX_KNOWN_UNCOVERED } = await import('../../../src/agui/coverage-check');
    expect(Object.keys(KNOWN_UNCOVERED).length).toBeLessThanOrEqual(MAX_KNOWN_UNCOVERED);
    for (const [mod, reason] of Object.entries(KNOWN_UNCOVERED)) {
      expect(reason.trim().length).toBeGreaterThanOrEqual(30);
      expect(mod).not.toMatch(/\.ts$/);
    }
  });
});

describe('runCoverageCheck — production tree', () => {
  test('production registerAllActions() leaves no uncovered modules in src/integrations', async () => {
    // E-14 boot acceptance — after the production registrar runs, the real
    // `src/integrations` tree must be fully covered (or excused on the record).
    const serverSrc = await Bun.file(
      path.resolve(import.meta.dir, '..', '..', '..', 'src', 'server.ts'),
    ).text();
    // Production must build its registry through the same entry point,
    // otherwise this test would be measuring a different catalogue.
    expect(serverSrc).toMatch(/\bawait registerAllActions\(\)/);

    const { registerAllActions } = await import('../../../src/agui/register-all-actions');
    await registerAllActions();

    // runCoverageCheck reads `src/integrations` relative to cwd, as at boot.
    const prevCwd = process.cwd();
    process.chdir(path.resolve(import.meta.dir, '..', '..', '..'));
    try {
      const report = await runCoverageCheck();
      expect(report.uncoveredModules).toEqual([]);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
