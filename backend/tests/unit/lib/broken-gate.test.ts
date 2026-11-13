// tests/unit/lib/broken-gate.test.ts
//
// Pure (no-DB) coverage for `lib/broken-gate.ts`, extracted from
// `routes/approvals.ts` (#1064) so the three chat seats can share the same
// predicate the API route enforces. This file pins the PREDICATE:
// `brokenGateTerms` must recognise each built-in term, must ignore terms not
// in the set (`risk_block` is the load-bearing negative — see the essay in
// `lib/broken-gate.ts`), and must return `[]` — never throw — for every
// metadata shape n8n's untyped JSON can actually hand it.
//
// The end-to-end refusal (chat seat refuses an approve, writes nothing, still
// allows reject) is proven per-seat in the integration tests
// (`tests/integration/routes/*-broken-gate*.integration.test.ts`); this file
// only pins the shared building block those seats call.

import { test, expect, describe } from 'bun:test';

import {
  BROKEN_GATE_TERMS,
  declaredGateTerms,
} from '../../../src/lib/broken-gate';

describe('BROKEN_GATE_TERMS — the five built-in defect terms', () => {
  const builtins = [
    'evidence_gap',
    'brief_write_failed',
    'authoring_gap',
    'decision_authoring_gap',
    'no_procedure',
  ];

  for (const term of builtins) {
    test(`"${term}" is a member`, () => {
      expect(BROKEN_GATE_TERMS.has(term)).toBe(true);
    });
  }

  // ⛔ THE LOAD-BEARING NEGATIVE. `risk_block` is the conveyor's dominant
  // LEGITIMATE gate — adding it here does not tighten the guard, it halts the
  // conveyor. See the essay in `lib/broken-gate.ts` for the measurement.
  test('"risk_block" is deliberately NOT a member', () => {
    expect(BROKEN_GATE_TERMS.has('risk_block')).toBe(false);
  });
});

describe('declaredGateTerms — defensive read of untyped n8n JSON', () => {
  test('reads an array of strings verbatim', () => {
    expect(declaredGateTerms({ gate_terms: ['evidence_gap', 'risk_block'] })).toEqual([
      'evidence_gap',
      'risk_block',
    ]);
  });

  test('a non-string member is dropped, not stringified', () => {
    expect(declaredGateTerms({ gate_terms: ['evidence_gap', 7, { x: 1 }, null] })).toEqual([
      'evidence_gap',
    ]);
  });

  test('absent gate_terms ⇒ []', () => {
    expect(declaredGateTerms({})).toEqual([]);
  });

  test('a non-array gate_terms (string, object, null, number) ⇒ [] in every case', () => {
    expect(declaredGateTerms({ gate_terms: 'evidence_gap' })).toEqual([]);
    expect(declaredGateTerms({ gate_terms: { evidence_gap: true } })).toEqual([]);
    expect(declaredGateTerms({ gate_terms: null })).toEqual([]);
    expect(declaredGateTerms({ gate_terms: 42 })).toEqual([]);
  });
});
