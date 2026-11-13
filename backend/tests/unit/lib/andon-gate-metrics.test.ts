// tests/unit/lib/andon-gate-metrics.test.ts
//
// Two properties of `lib/andon-gate-metrics.ts` that an adversarial mutation run
// proved NOTHING was reading. Both survived on the same day, in opposite ways:
//
//   1. `normaliseAnswer`'s unknown-value fallback flipped `'engaged'` →
//      `'released'` and the whole suite stayed GREEN. That is a SAFETY DEFAULT on
//      the module that counts whether work was allowed to start, and an unpinned
//      safety default can be flipped in either direction by anyone.
//   2. Deleting the zero PRE-SEED also stayed green — correctly, because
//      `renderAndonGateMetrics` walks the closed sets and `?? 0`s each counter,
//      so the exposition is byte-identical either way. The pre-seed's comment
//      claimed to be what made the zero baseline observable; it was not. The
//      claim has been retracted in the module and the baseline is pinned HERE,
//      against the renderer that actually produces it.
//
// ⚠️ Deliberately a plain `test()` file with no database and no reachability
// guard: an `ifReachable` idiom records a SKIP as a PASS (the former
// global-andon suite dropped 61 of its 169 assertions that way while reading
// fully green), so these assertions are kept out of that idiom.
//
// Counters are module-level state shared across every file in a `bun test` run,
// so this file zeroes them BEFORE and AFTER each body: other files may
// assert absolute counts and must not inherit ours.

import { expect, test } from 'bun:test';

import {
  ANDON_GATE_ANSWERS,
  ANDON_GATE_REASONS,
  recordAndonGateAnswer,
  renderAndonGateMetrics,
} from '../../../src/lib/andon-gate-metrics';



test('the exporter emits every answer x reason series from a COLD counter, at zero', () => {
  const cold = renderAndonGateMetrics();

  // Two metadata lines plus one series per pair, and nothing else: a renderer
  // that emitted a superset would satisfy the per-series checks below while
  // minting cardinality this module exists to bound.
  expect(cold).toHaveLength(2 + ANDON_GATE_ANSWERS.length * ANDON_GATE_REASONS.length);
  expect(cold[0]).toContain('# HELP fr_andon_gate_total');
  expect(cold[1]).toBe('# TYPE fr_andon_gate_total counter');

  // KILLS the mutation that actually delivers this property: making
  // `renderAndonGateMetrics` skip pairs it has never seen fire (for example
  // iterating only recorded keys, or `continue`ing on a zero). A series that
  // appears only once it fires cannot be told apart from an exporter that was
  // never wired into `routes/metrics.ts`.
  //
  // ⚠️ This does NOT pin the module's zero pre-seed, and that is the finding, not
  // an omission: with the renderer's `?? 0` in place the pre-seed is redundant
  // and CANNOT be killed from the exposition. See the retraction in the module
  // header.
  for (const a of ANDON_GATE_ANSWERS) {
    for (const r of ANDON_GATE_REASONS) {
      expect(cold).toContain(`fr_andon_gate_total{answer="${a}",reason="${r}"} 0`);
    }
  }

  // POSITIVE CONTROL for those ten zeroes: the renderer is reading live counters,
  // not printing a constant block. One increment must move exactly one series and
  // leave the rest at zero — which is also what proves the zeroes above were
  // measured rather than hardcoded.
  recordAndonGateAnswer('released', 'uninitialised');
  const warm = renderAndonGateMetrics();
  expect(warm).toContain('fr_andon_gate_total{answer="released",reason="uninitialised"} 1');
  expect(warm).toContain('fr_andon_gate_total{answer="released",reason="released"} 0');
  expect(warm).toContain('fr_andon_gate_total{answer="engaged",reason="uninitialised"} 0');
  expect(warm).toHaveLength(cold.length);
});
