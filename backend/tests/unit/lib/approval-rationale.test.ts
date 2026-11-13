// tests/unit/lib/approval-rationale.test.ts
//
// Pure (no-DB) coverage for the ONE write-path gate over
// `approvals.change_summary` / `approvals.impact_analysis`.
//
// The property under test is a ROUND TRIP, in both directions, and it is the
// whole point of the module:
//
//   producer content in  ⇒  content out  (isNoRationaleSupplied === false)
//   genuine absence in   ⇒  absence out  (isNoRationaleSupplied === true)
//
// The interesting case is the one that inverts it: producer text that itself
// begins with `NO_RATIONALE_MARKER`. `isNoRationaleSupplied()` is a `startsWith`
// test, so storing such text verbatim would make every reader present real
// producer content as "no summary supplied" and suppress the review prompt —
// the same defect this module exists to remove, pointing the other way. It
// arrives for real on a re-raise that carries a prior row's stored fields
// forward. The guard neutralises it (prefix, keep every byte) instead of
// rejecting it, so the approval is never dropped and nothing is paraphrased.

import { test, expect, describe } from 'bun:test';

import {
  rationaleOrAbsence,
  isNoRationaleSupplied,
  noRationaleSupplied,
  collidesWithAbsenceMarker,
  NO_RATIONALE_MARKER,
  PRODUCER_VERBATIM_MARKER,
  RATIONALE_PRODUCERS,
} from '../../../src/lib/approval-rationale';

const PRODUCER = RATIONALE_PRODUCERS.readySignoff;

/** The stored value must always be usable: never null, never '', never blank. */
function expectStorable(stored: string) {
  expect(typeof stored).toBe('string');
  expect(stored.length).toBeGreaterThan(0);
  expect(stored.trim()).toBe(stored);
}

describe('rationaleOrAbsence — genuine absence round-trips as ABSENCE', () => {
  for (const [label, input] of [
    ['undefined', undefined],
    ['null', null],
    ["'' (empty string)", ''],
    ['whitespace only', '   \n\t  '],
  ] as const) {
    test(`${label} → the marked, producer-naming absence value`, () => {
      const stored = rationaleOrAbsence(input, 'change_summary', PRODUCER);

      expect(isNoRationaleSupplied(stored)).toBe(true);
      expect(stored.startsWith(NO_RATIONALE_MARKER)).toBe(true);
      expect(stored).toBe(noRationaleSupplied('change_summary', PRODUCER));
      // It names the producer so the gap can be chased, and nothing else.
      expect(stored).toContain(PRODUCER);
      expectStorable(stored);
    });
  }

  test('the absence text is per-field and derives from NOTHING but the field + producer', () => {
    const summary = rationaleOrAbsence(null, 'change_summary', PRODUCER);
    const impact = rationaleOrAbsence(null, 'impact_analysis', PRODUCER);

    expect(summary).not.toBe(impact);
    expect(summary).toContain('change summary');
    expect(impact).toContain('impact analysis');
  });
});

describe('rationaleOrAbsence — producer content round-trips as CONTENT', () => {
  test('ordinary prose is stored verbatim', () => {
    const prose = 'Adds a retry around the KAG ingest call; no schema change.';
    const stored = rationaleOrAbsence(prose, 'change_summary', PRODUCER);

    expect(stored).toBe(prose);
    expect(isNoRationaleSupplied(stored)).toBe(false);
    expectStorable(stored);
  });

  test('surrounding whitespace is trimmed, interior text is untouched', () => {
    const stored = rationaleOrAbsence(
      '  line one\n  line two  ',
      'impact_analysis',
      PRODUCER,
    );

    expect(stored).toBe('line one\n  line two');
    expect(isNoRationaleSupplied(stored)).toBe(false);
  });

  test('the marker MID-STRING is not a collision and is left alone', () => {
    const prose = `The upstream row read "${NO_RATIONALE_MARKER}" so we chased the producer.`;
    const stored = rationaleOrAbsence(prose, 'change_summary', PRODUCER);

    expect(collidesWithAbsenceMarker(prose)).toBe(false);
    expect(stored).toBe(prose);
    expect(stored).not.toContain(PRODUCER_VERBATIM_MARKER);
    expect(isNoRationaleSupplied(stored)).toBe(false);
  });
});

describe('rationaleOrAbsence — the absence-marker collision must not invert', () => {
  test('text EXACTLY equal to the marker stays content, not absence', () => {
    const stored = rationaleOrAbsence(NO_RATIONALE_MARKER, 'change_summary', PRODUCER);

    // The inversion this guard exists to close.
    expect(isNoRationaleSupplied(stored)).toBe(false);
    // Nothing was dropped: stripping the marker would have yielded '' and
    // turned content into absence.
    expect(stored).toContain(NO_RATIONALE_MARKER);
    expect(stored).toBe(`${PRODUCER_VERBATIM_MARKER} ${NO_RATIONALE_MARKER}`);
    expectStorable(stored);
  });

  test('marker as a PREFIX followed by real prose keeps every byte of the prose', () => {
    const prose = `${NO_RATIONALE_MARKER} No change summary was supplied by the n8n ready-signoff producer. Carried forward from approval 7f3c.`;
    const stored = rationaleOrAbsence(prose, 'impact_analysis', PRODUCER);

    expect(collidesWithAbsenceMarker(prose)).toBe(true);
    expect(isNoRationaleSupplied(stored)).toBe(false);
    expect(stored).toBe(`${PRODUCER_VERBATIM_MARKER} ${prose}`);
    // The producer's own words survive intact, in order, unparaphrased.
    expect(stored.endsWith(prose)).toBe(true);
    expect(stored).toContain('Carried forward from approval 7f3c.');
  });

  test('leading whitespace does not smuggle a collision past the guard', () => {
    const stored = rationaleOrAbsence(
      `   ${NO_RATIONALE_MARKER} real prose`,
      'change_summary',
      PRODUCER,
    );

    expect(isNoRationaleSupplied(stored)).toBe(false);
    expect(stored).toBe(`${PRODUCER_VERBATIM_MARKER} ${NO_RATIONALE_MARKER} real prose`);
  });

  test('a neutralised value re-fed through the gate does not compound', () => {
    const once = rationaleOrAbsence(NO_RATIONALE_MARKER, 'change_summary', PRODUCER);
    const twice = rationaleOrAbsence(once, 'change_summary', PRODUCER);

    // Already neutralised → no longer collides → passed through verbatim.
    expect(twice).toBe(once);
    expect(isNoRationaleSupplied(twice)).toBe(false);
  });

  test('fr\'s OWN absence value fed back in is treated as producer content, not absence', () => {
    // Exactly the re-raise shape: a prior row's stored absence handed back.
    const carriedForward = noRationaleSupplied('change_summary', PRODUCER);
    const stored = rationaleOrAbsence(carriedForward, 'change_summary', PRODUCER);

    // It is now content — because a producer sent it. The honest reading of a
    // producer echoing fr's text is "the producer sent this string", not
    // "the producer sent nothing".
    expect(isNoRationaleSupplied(stored)).toBe(false);
    expect(stored.endsWith(carriedForward)).toBe(true);
  });
});

describe('the marker constants', () => {
  test('NO_RATIONALE_MARKER is the pinned, frontend-mirrored sentinel', () => {
    // Byte-identical to frontend/src/lib/approvals/rationale.ts.
    expect(NO_RATIONALE_MARKER).toBe('[no-rationale-supplied]');
  });

  test('PRODUCER_VERBATIM_MARKER cannot itself be read as absence', () => {
    expect(PRODUCER_VERBATIM_MARKER.startsWith(NO_RATIONALE_MARKER)).toBe(false);
    expect(isNoRationaleSupplied(PRODUCER_VERBATIM_MARKER)).toBe(false);
  });

  test('isNoRationaleSupplied is false for null/undefined/empty (legacy rows)', () => {
    expect(isNoRationaleSupplied(null)).toBe(false);
    expect(isNoRationaleSupplied(undefined)).toBe(false);
    expect(isNoRationaleSupplied('')).toBe(false);
  });
});
