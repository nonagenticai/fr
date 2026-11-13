// canonical-scenarios-hash v1 conformance (src/lib/scenarios-hash.ts).
//
// The golden vectors are movies-db's, VENDORED at
// tests/fixtures/canonical-scenarios-hash/vectors.json (source:
// ~/.claude/plans/program/30-specs-contracts/canonical-scenarios-hash/, never hand-edited).
// Their sha256 is pinned in vectors.json.sha256 and checked FIRST, so an edited vector
// file fails here instead of silently re-defining the hash.
//
// Per the README's conformance rule: every vector's `canonical` must be byte-equal AND
// its `sha256` equal; every `must_throw` input must throw. The vector set already
// covers CRLF≡LF, trailing whitespace / blank lines, and input ordering, so no hand
// vectors duplicate them here.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalScenariosString, normaliseGherkin, scenariosHash } from '../../../src/lib/scenarios-hash';

const DIR = join(import.meta.dir, '../../fixtures/canonical-scenarios-hash');
const raw = readFileSync(join(DIR, 'vectors.json'));
const pinned = readFileSync(join(DIR, 'vectors.json.sha256'), 'utf8').split(/\s+/)[0];

interface Vector {
  name: string;
  input: Array<Record<string, unknown>>;
  canonical: string;
  sha256: string;
}
const file = JSON.parse(raw.toString('utf8')) as {
  version: number;
  algorithm: string;
  vectors: Vector[];
  must_throw: Array<{ name: string; input: Array<Record<string, unknown>> }>;
};

test('the vendored vectors are byte-identical to the pinned sha256 (f455b35b…)', () => {
  expect(createHash('sha256').update(raw).digest('hex')).toBe(pinned!);
  expect(pinned!.startsWith('f455b35b18249e5c')).toBe(true);
  expect(file.algorithm).toBe('canonical-scenarios-hash v1');
  // No vector counts: the sha256 pin above fails on ANY change to the file,
  // which is strictly stronger than a length assertion.
});

describe('golden vectors', () => {
  for (const v of file.vectors) {
    test(v.name, () => {
      expect(canonicalScenariosString(v.input as never)).toBe(v.canonical);
      expect(scenariosHash(v.input as never)).toBe(v.sha256);
    });
  }
  for (const v of file.must_throw) {
    test(`must_throw: ${v.name}`, () => {
      expect(() => scenariosHash(v.input as never)).toThrow();
    });
  }
});

test('normaliseGherkin: lone CR is a line break too; non-string is refused', () => {
  expect(normaliseGherkin('a\rb')).toBe('a\nb\n');
  expect(() => normaliseGherkin(42)).toThrow(TypeError);
});

// fr#1395: ONE implementation. services/gherkin-scenarios.ts re-exports this module's
// functions; run the shared vectors through the PUBLIC exports of BOTH modules so a
// second copy (or a re-export pointed elsewhere) cannot drift silently.
describe('fr#1395 cross-check: lib and the gherkin-scenarios re-export agree with the vectors', () => {
  const MUST = ['single_basic', 'unicode_kept_as_is'];
  test('the named vectors are present (the cross-check is not vacuous)', () => {
    for (const n of MUST) expect(file.vectors.some((v) => v.name === n)).toBe(true);
  });
  for (const v of file.vectors) {
    test(v.name, async () => {
      const gs = await import('../../../src/services/gherkin-scenarios');
      expect({ lib: scenariosHash(v.input), gs: gs.scenariosHash(v.input) }).toEqual({ lib: v.sha256, gs: v.sha256 });
      expect({ lib: canonicalScenariosString(v.input), gs: gs.canonicalScenariosString(v.input) }).toEqual({
        lib: v.canonical,
        gs: v.canonical,
      });
    });
  }
  test('normaliseGherkin agrees through both exports', async () => {
    const gs = await import('../../../src/services/gherkin-scenarios');
    for (const g of [null, undefined, '', ' \t\n', 'a\r\nb  \n\n', 'Ünïcödé\tx\n']) {
      expect(gs.normaliseGherkin(g)).toBe(normaliseGherkin(g));
    }
  });
});

describe('spec step 2: title is verbatim (no trim) — no vendored vector covers a trailing space', () => {
  const base = { scenario_id: 'S1', criterion_id: 'C1', gherkin: 'Given x\nThen y' };
  test('a trailing space in the title is kept in the canonical string and changes the hash', async () => {
    const gs = await import('../../../src/services/gherkin-scenarios');
    const plain = [{ ...base, title: 'Login works' }];
    const spaced = [{ ...base, title: 'Login works ' }];
    expect(canonicalScenariosString(spaced)).toContain('"title":"Login works "');
    expect(scenariosHash(spaced)).not.toBe(scenariosHash(plain));
    expect(gs.scenariosHash(spaced)).toBe(scenariosHash(spaced));
  });
});
