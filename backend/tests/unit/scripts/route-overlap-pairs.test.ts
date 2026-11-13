// tests/unit/scripts/route-overlap-pairs.test.ts
//
// scripts/route-overlap-pairs.ts (fr-agui SPEC §3.6) and the frontend path scan
// the capability guard uses (scripts/lib/frontend-api-paths.ts).

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  computeOverlapPairs,
  functionBody,
  legacyOrderedRows,
  main,
  patternsOverlap,
  segmentRows,
  unsupportedPatternError,
} from '../../../scripts/route-overlap-pairs';
import { probeFor, stringLiterals, templateParts } from '../../../scripts/lib/frontend-api-paths';

describe('patternsOverlap', () => {
  test.each([
    ['/api/approvals/all', '/api/approvals/:approvalId', true],
    ['/api/a/:x/b', '/api/a/c/:y', true],
    ['/api/a/:x', '/api/a/:y/b', false],
    ['/api/a/b', '/api/a/c', false],
    ['/api/assets/kag/reviews(.*)', '/api/assets/:kind/:id/rollups', true],
    ['/api/assets/kag/reviews(.*)', '/api/assets/kag/graph', false],
    ['/api/x/:id', '/api/x/:id', true],
  ])('%s vs %s → %p', (a, b, want) => {
    expect(patternsOverlap(a, b)).toBe(want);
    expect(patternsOverlap(b, a)).toBe(want);
  });

  test('a mixed segment is refused rather than guessed', () => {
    expect(unsupportedPatternError('/api/a/file-:id')).toContain('mixes');
    expect(unsupportedPatternError('/api/assets/kag/reviews(.*)')).toBeNull();
  });
});

describe('ordered table reconstruction', () => {
  test('a dynamic-method loop expands to one row per method; an unexpandable one throws', () => {
    const rows = segmentRows(
      `for (const method of ['GET', 'POST']) {\n  router.add(method, '/api/r(.*)', h);\n}\nrouter.add('GET', '/api/x', g);`,
      'f.ts',
    );
    expect(rows.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/r(.*)', 'POST /api/r(.*)', 'GET /api/x']);
    expect(() => segmentRows(`router.add(m, '/api/x', h);`, 'f.ts')).toThrow('refusing to drop it');
  });

  test('a delegation is spliced at its call site, with only THAT function body', () => {
    const server = `router.add('GET', '/a', h1);\nregisterTwo(router);\nrouter.add('GET', '/c', h3);`;
    const files = [
      {
        path: 'src/routes/d.ts',
        content:
          `export function registerOne(router: Router): void {\n  router.add('GET', '/one', x);\n}\n` +
          `export function registerTwo(router: Router): void {\n  router.add('GET', '/b', h2);\n}\n`,
      },
    ];
    expect(functionBody(files[0]!.content, 'registerOne')).toContain('/one');
    const rows = legacyOrderedRows({ serverSource: server, handlerFiles: files });
    expect(rows.map((r) => r.path)).toEqual(['/a', '/b', '/c']);
  });

  test('pairs are ordered (earlier, later) with a probe both match', () => {
    const pairs = computeOverlapPairs([
      { method: 'GET', path: '/x/fixed', file: '', handler: '' },
      { method: 'POST', path: '/x/:id', file: '', handler: '' },
      { method: 'GET', path: '/x/:id', file: '', handler: '' },
    ]);
    expect(pairs).toEqual([{ before: 'GET /x/fixed', after: 'GET /x/:id', probe: '/x/fixed' }]);
  });

  test('the real tree: the pinned file is current (CLI exit 0)', () => {
    expect(main([])).toBe(0);
  });

  test('the CLI through the process boundary', () => {
    const r = Bun.spawnSync(['bun', 'run', 'scripts/route-overlap-pairs.ts'], {
      cwd: join(import.meta.dir, '../../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // ⛔ NO pinned pair/row counts (owner ruling 2026-10-31). This asserted the
    // literal `63 pinned pair(s) over 875 row(s)`, so every added route turned
    // CI red on a change that was correct and the fix was always "bump the
    // number". The counts are not the guard: `OK:` versus an offender list is,
    // and the exit code below is the other. The pair/row relationship itself is
    // covered by the unit tests above.
    expect(r.stdout.toString()).toMatch(/\[route-overlap-pairs\] OK: \d+ pinned pair\(s\) over \d+ row\(s\)/);
    expect(r.exitCode).toBe(0);
  });
});

describe('frontend /api literal scan', () => {
  test('literals outside comments; template nesting kept', () => {
    const src = "// '/api/commented'\nconst a = '/api/a';\n/* `/api/b` */ const b = `/api/c/${x ? `?${y}` : ''}`;";
    expect(stringLiterals(src).filter((s) => s.startsWith('/api/'))).toEqual(['/api/a', "/api/c/${x ? `?${y}` : ''}"]);
  });

  test.each([
    ['/api/projects/${encodeURIComponent(id)}/status', '/api/projects/probe-x/status'],
    ['/api/reports${qs ? `?${qs}` : \'\'}', '/api/reports'],
    ['/api/x/${a}${qs}', '/api/x/probe-x'],
    ['/api/me/usage/summary?window=${w}', '/api/me/usage/summary'],
    ['/api/x-${a}/y', null],
    ['/api/me/usage/*', null],
  ])('probeFor(%s) → %p', (raw, want) => {
    expect(probeFor(raw)).toBe(want);
  });

  test('templateParts balances nested braces', () => {
    expect(templateParts('/a/${f({b: 1})}/c').map((p) => p.expr)).toEqual([false, true, false]);
  });
});
