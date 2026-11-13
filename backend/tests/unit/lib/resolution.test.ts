// tests/unit/lib/resolution.test.ts
//
// The contract of src/lib/resolution.ts, asserted where it actually matters:
// that the three count states produce THREE DISTINGUISHABLE serialisations,
// and that an unknown can never leave this module as a number.
//
// The central case is the one that used to ship: a full page behind a cap.
// Before this module that serialised as `total: <page size>` — a lower bound
// wearing the costume of a total. The test below pins it to `null` plus an
// explicit relation header, and pins the lower bound to a place nothing can
// mistake for an exact answer.

import { test, expect, describe } from 'bun:test';
import {
  resolveCount,
  serializeCount,
  totalField,
  totalKindField,
  countHeaders,
  exactCount,
  atLeastCount,
  unknownCount,
  resolved,
  unresolved,
  fieldValue,
  isResolved,
  allRowsResolved,
  anyRowUnresolved,
  resolvedRowCount,
  resolvePct,
  pctField,
  TOTAL_RELATION_HEADER,
  TOTAL_LOWER_BOUND_HEADER,
  APPLIED_LIMIT_HEADER,
  TRUNCATED_HEADER,
} from '../../../src/lib/resolution';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

describe('resolveCount — which of the three states', () => {
  test('unbounded query: the page IS the match set', () => {
    expect(resolveCount({ rows: rows(7), appliedLimit: null })).toEqual({
      kind: 'exact',
      count: 7,
    });
  });

  test('short page under a cap: the cap did not bind, so the count is exact', () => {
    expect(resolveCount({ rows: rows(7), appliedLimit: 20 })).toEqual({
      kind: 'exact',
      count: 7,
    });
  });

  test('FULL page under a cap: at_least, never exact', () => {
    // This is the shipped defect. `reports.ts` clamped to 200 and returned
    // `total: 200` for a tenant holding 9,845 rows.
    expect(resolveCount({ rows: rows(200), appliedLimit: 200 })).toEqual({
      kind: 'at_least',
      count: 200,
    });
  });

  test('a measured COUNT(*) wins over the probe, even on a full page', () => {
    expect(
      resolveCount({ rows: rows(200), appliedLimit: 200, totalMatching: 9845 }),
    ).toEqual({ kind: 'exact', count: 9845 });
  });

  test('totalMatching null is NOT a total — it falls through to the probe', () => {
    // `null` is how a route says "I asked and could not get one". If that were
    // read as a count it would serialise as the defect all over again.
    expect(resolveCount({ rows: rows(200), appliedLimit: 200, totalMatching: null })).toEqual({
      kind: 'at_least',
      count: 200,
    });
  });

  test('offset is carried into the exact count', () => {
    expect(resolveCount({ rows: rows(5), appliedLimit: 20, offset: 40 })).toEqual({
      kind: 'exact',
      count: 45,
    });
  });

  test('sourceRowCount, not the filtered length, is compared to the cap', () => {
    // A locally-filtered page is NOT the page the source served. Comparing the
    // filtered length would answer "complete" exactly when filters are active.
    expect(
      resolveCount({ rows: rows(3), appliedLimit: 200, sourceRowCount: 200 }),
    ).toEqual({ kind: 'at_least', count: 3 });
  });

  // ---------------------------------------------------------------------
  // `unknownReason` — the branch that had NO test at all
  // ---------------------------------------------------------------------
  // ⛔ THESE ARE A MUTATION-KILL, NOT COVERAGE PADDING. MEASURED 2026-09-26:
  // deleting `if (input.unknownReason) return unknownCount(...)` from
  // `resolveCount` left this file at 27 pass / 63 expect() — byte-identical to
  // the un-mutated run. The word `unknownReason` appeared ZERO times here,
  // while `resolution.ts`'s header calls the ordering ("checked FIRST, before
  // `totalMatching`") load-bearing. A load-bearing ordering that no test can
  // feel is a comment, not a property.

  test('⭐ unknownReason makes the answer unknown — the branch itself', () => {
    // Every OTHER input here points at a clean `exact 3`: a short page under a
    // cap that did not bind. Only the reason can move it, so this kills the
    // deletion of the branch on its own.
    const r = resolveCount({
      rows: rows(3),
      appliedLimit: 200,
      unknownReason: 'the approvals source threw and was degraded to []',
    });
    expect(r.kind).toBe('unknown');
    expect(r).toEqual({
      kind: 'unknown',
      reason: 'the approvals source threw and was degraded to []',
    });
  });

  test('⭐ unknownReason is checked FIRST — it BEATS a measured totalMatching', () => {
    // THE ORDERING, pinned. A COUNT(*) taken over only the part of a merged
    // read that WORKED is not a total of the set the caller asked for. If the
    // `unknownReason` check ever moves below the `totalMatching` check, this is
    // the test that fails — and `exact: 9845` is precisely the confident,
    // wrong answer that would ship instead.
    const r = resolveCount({
      rows: rows(200),
      appliedLimit: 200,
      totalMatching: 9845,
      unknownReason: 'one of two merged sources failed; this counts only the live half',
    });
    expect(r.kind).toBe('unknown');
    expect(r).not.toEqual({ kind: 'exact', count: 9845 });
    // CONTROL — with the reason removed and nothing else changed, the exact
    // total DOES win. Without this the test above could pass on a helper that
    // ignored `totalMatching` entirely.
    expect(resolveCount({ rows: rows(200), appliedLimit: 200, totalMatching: 9845 })).toEqual({
      kind: 'exact',
      count: 9845,
    });
  });

  test('⭐ unknownReason beats the unbounded-query shortcut too', () => {
    // `appliedLimit: null` returns `exact` before any probe runs, so it is a
    // second, independent route past the branch.
    expect(
      resolveCount({ rows: rows(4), appliedLimit: null, unknownReason: 'upstream degraded' }).kind,
    ).toBe('unknown');
    // CONTROL — same call without the reason.
    expect(resolveCount({ rows: rows(4), appliedLimit: null })).toEqual({
      kind: 'exact',
      count: 4,
    });
  });

  test('an ABSENT or empty unknownReason does not silently unknown the count', () => {
    // The guard is `if (input.unknownReason)`, so `null`/`undefined`/`''` must
    // fall through. A route that computes its reason and gets `''` must not
    // have its honest count replaced by a null with an empty explanation.
    expect(resolveCount({ rows: rows(3), appliedLimit: 200, unknownReason: null }).kind).toBe(
      'exact',
    );
    expect(resolveCount({ rows: rows(3), appliedLimit: 200, unknownReason: '' }).kind).toBe(
      'exact',
    );
  });

  test('⭐ unknownReason survives serialisation as null + unknown, never a number', () => {
    // The end-to-end shape: the branch is only worth anything if the route that
    // sets it ships something a reader can tell from a count.
    const s = serializeCount({
      rows: rows(200),
      appliedLimit: 200,
      totalMatching: 9845,
      unknownReason: 'merged read: one source failed',
    });
    expect(s.total).toBeNull();
    expect(s.total_kind).toBe('unknown');
    expect(s.headers[TRUNCATED_HEADER]).toBe('false');
    expect(s.headers[TOTAL_LOWER_BOUND_HEADER]).toBeUndefined();
  });

  // ── lowerBoundReason ──────────────────────────────────────────────────────
  //
  // ⚠️ ADDED after `routes/dashboard.ts` shipped a cut fan-out as `unknown` and
  // broke a PRE-EXISTING guard that pinned a partial Planka read at
  // `total === 1`. Rendering
  // one failed list as a total count failure is the same defect inverted: the
  // rows that survived all matched, so their length is a TRUE floor, and
  // `unknown` discards a number we measured.

  test('⭐ lowerBoundReason forces at_least over an otherwise-exact short page', () => {
    // Every other input points at a clean `exact 3` — a short page under a cap
    // that did not bind — so only the reason can move it.
    const r = resolveCount({
      rows: rows(3),
      appliedLimit: 200,
      lowerBoundReason: '1/2 card reads failed',
    });
    expect(r).toEqual({ kind: 'at_least', count: 3 });
    // CONTROL — same call without the reason.
    expect(resolveCount({ rows: rows(3), appliedLimit: 200 })).toEqual({ kind: 'exact', count: 3 });
  });

  test('⭐ lowerBoundReason beats totalMatching AND the unbounded-query shortcut', () => {
    // Same ordering argument as `unknownReason`: a COUNT(*) over the half that
    // worked is not a total, and `appliedLimit: null` means "no LIMIT clause",
    // not "nothing was missed".
    expect(
      resolveCount({
        rows: rows(3),
        appliedLimit: 200,
        totalMatching: 9845,
        lowerBoundReason: 'counts only the live half',
      }),
    ).toEqual({ kind: 'at_least', count: 3 });
    expect(
      resolveCount({ rows: rows(4), appliedLimit: null, lowerBoundReason: 'fan-out truncated' }),
    ).toEqual({ kind: 'at_least', count: 4 });
    // CONTROL — remove the reason and both revert.
    expect(resolveCount({ rows: rows(3), appliedLimit: 200, totalMatching: 9845 }).kind).toBe(
      'exact',
    );
    expect(resolveCount({ rows: rows(4), appliedLimit: null })).toEqual({ kind: 'exact', count: 4 });
  });

  test('⛔ a floor of ZERO is not a floor — it degrades to unknown, never a bare 0', () => {
    // THE CASE THE WHOLE FIELD TURNS ON. `at_least 0` would serialise as
    // `total: 0`, which reads "none matched" — indistinguishable from a
    // genuinely empty set, which is the original defect.
    const s = serializeCount({
      rows: rows(0),
      appliedLimit: null,
      lowerBoundReason: 'every list we could read was empty; one list failed',
    });
    expect(s.total).toBeNull();
    expect(s.total_kind).toBe('unknown');
    expect(s.total).not.toBe(0);
    // CONTROL — ONE row is enough to make the floor meaningful, and the SAME
    // call then reports it. Without this the assertion above is satisfied by a
    // field that never produces `at_least` at all.
    const one = serializeCount({ rows: rows(1), appliedLimit: null, lowerBoundReason: 'same cut' });
    expect(one.total).toBe(1);
    expect(one.total_kind).toBe('at_least');
  });

  test('⛔ unknownReason still WINS over lowerBoundReason', () => {
    // A route that cannot describe its set at all must not be talked up into a
    // claim by a second flag.
    expect(
      resolveCount({
        rows: rows(5),
        appliedLimit: null,
        unknownReason: 'cannot describe this set',
        lowerBoundReason: 'but here is a floor',
      }).kind,
    ).toBe('unknown');
  });

  test('an ABSENT or empty lowerBoundReason does not silently downgrade the count', () => {
    expect(resolveCount({ rows: rows(3), appliedLimit: 200, lowerBoundReason: null }).kind).toBe(
      'exact',
    );
    expect(resolveCount({ rows: rows(3), appliedLimit: 200, lowerBoundReason: '' }).kind).toBe(
      'exact',
    );
  });

  test('a nonsense applied limit is unknown, not a silent exact', () => {
    expect(resolveCount({ rows: rows(3), appliedLimit: 0 }).kind).toBe('unknown');
    expect(resolveCount({ rows: rows(3), appliedLimit: Number.NaN }).kind).toBe('unknown');
  });

  test('constructors reject non-countable values instead of coercing them', () => {
    expect(exactCount(Number.NaN).kind).toBe('unknown');
    expect(exactCount(-1).kind).toBe('unknown');
    expect(atLeastCount(Number.POSITIVE_INFINITY).kind).toBe('unknown');
  });
});

describe('serialisation — the three states must be DISTINGUISHABLE', () => {
  const exact = serializeCount({ rows: rows(7), appliedLimit: 20 });
  const truncated = serializeCount({ rows: rows(200), appliedLimit: 200 });
  const unknownRes = unknownCount('upstream returns a bare array with no total');
  const unknown = {
    total: totalField(unknownRes),
    total_kind: totalKindField(unknownRes),
    headers: countHeaders(unknownRes, null),
  };

  test('exact serialises as a number labelled exact', () => {
    expect(exact.total).toBe(7);
    expect(exact.total_kind).toBe('exact');
    expect(exact.headers[TOTAL_RELATION_HEADER]).toBe('exact');
    expect(exact.headers[TRUNCATED_HEADER]).toBe('false');
  });

  test('truncated serialises the LOWER BOUND, labelled at_least', () => {
    // The digits are the same as the old lying `total`. What makes them honest
    // is `total_kind` travelling with them: `frontend/src/lib/api/list-count.ts`
    // renders this as "N of at least 200 — more exist upstream", and reads a
    // total with NO such statement as UNKNOWN rather than as exact.
    expect(truncated.total).toBe(200);
    expect(truncated.total_kind).toBe('at_least');
    expect(truncated.headers[TOTAL_RELATION_HEADER]).toBe('at-least');
    expect(truncated.headers[TRUNCATED_HEADER]).toBe('true');
    expect(truncated.headers[TOTAL_LOWER_BOUND_HEADER]).toBe('200');
    expect(truncated.headers[APPLIED_LIMIT_HEADER]).toBe('200');
  });

  test('unknown serialises as null + unknown, and carries NO lower bound', () => {
    expect(unknown.total).toBeNull();
    expect(unknown.total_kind).toBe('unknown');
    expect(unknown.headers[TOTAL_RELATION_HEADER]).toBe('unknown');
    expect(unknown.headers[TRUNCATED_HEADER]).toBe('false');
    expect(unknown.headers[TOTAL_LOWER_BOUND_HEADER]).toBeUndefined();
  });

  test('⛔ unknown NEVER serialises as a number — and never as 0', () => {
    expect(unknown.total).not.toBe(0);
    expect(typeof unknown.total).not.toBe('number');
    expect(totalField(unknownCount('any reason'))).toBeNull();
  });

  test('⛔ a number NEVER ships without its kind', () => {
    // The invariant that makes a lower bound readable at all. `serializeCount`
    // is the only sanctioned constructor precisely because it has no shape in
    // which `total` is present and `total_kind` is not.
    for (const s of [exact, truncated, serializeCount({ rows: rows(3), appliedLimit: 0 })]) {
      expect(Object.keys(s)).toContain('total_kind');
      expect(['exact', 'at_least', 'unknown']).toContain(s.total_kind);
    }
  });

  test('⛔ a truncated page and a complete page of the SAME size differ', () => {
    // 200 rows behind a cap of 200, versus 200 rows with a measured total of
    // 200. Identical `items`, identical `total` — ONLY `total_kind` separates
    // them. This is the case a bare number can never express.
    const capped = serializeCount({ rows: rows(200), appliedLimit: 200 });
    const complete = serializeCount({ rows: rows(200), appliedLimit: 200, totalMatching: 200 });
    expect(capped.total).toBe(complete.total);
    expect(capped.total_kind).toBe('at_least');
    expect(complete.total_kind).toBe('exact');
  });

  test('all three combined serialisations differ from each other', () => {
    const key = (s: { total: number | null; total_kind: string }) =>
      JSON.stringify([s.total, s.total_kind]);
    const keys = new Set([key(exact), key(truncated), key(unknown)]);
    expect(keys.size).toBe(3);
  });

  test('every signal header is exposed to cross-origin readers', () => {
    const exposed = truncated.headers['Access-Control-Expose-Headers']!.split(', ');
    for (const h of [
      TOTAL_RELATION_HEADER,
      TRUNCATED_HEADER,
      TOTAL_LOWER_BOUND_HEADER,
      APPLIED_LIMIT_HEADER,
    ]) {
      expect(exposed).toContain(h);
    }
  });
});

describe('FieldResolution — an absence is not an empty value', () => {
  test('resolved carries its value; unresolved serialises null', () => {
    expect(fieldValue(resolved('Acme'))).toBe('Acme');
    expect(fieldValue(unresolved<string>('outside the caller tenant'))).toBeNull();
  });

  test('a genuinely empty value stays distinguishable from an absence', () => {
    const empty = resolved('');
    const absent = unresolved<string>('not visible to this tenant');
    expect(fieldValue(empty)).toBe('');
    expect(fieldValue(absent)).toBeNull();
    expect(isResolved(empty)).toBe(true);
    expect(isResolved(absent)).toBe(false);
  });
});

describe('completeness flag — DERIVED from the rows, never supplied', () => {
  type Row = { name: string | null };
  const ok: Row[] = [{ name: 'a' }, { name: 'b' }];
  const partial: Row[] = [{ name: 'a' }, { name: null }];
  const present = (r: Row) => r.name !== null;

  test('all resolved', () => {
    expect(allRowsResolved(ok, present)).toBe(true);
    expect(anyRowUnresolved(ok, present)).toBe(false);
  });

  test('⛔ a flag cannot read "complete" beside a row that did not resolve', () => {
    // The billing defect: `names_unavailable.projects === false` while
    // `projects[].name` held nulls. Unreachable through this API — the flag
    // has no input but the rows.
    expect(allRowsResolved(partial, present)).toBe(false);
    expect(anyRowUnresolved(partial, present)).toBe(true);
  });

  test('an empty set is vacuously complete, not "unreadable"', () => {
    expect(allRowsResolved([] as Row[], present)).toBe(true);
  });

  test('resolvedRowCount reports the honest numerator and denominator', () => {
    expect(resolvedRowCount(partial, present)).toEqual({ resolved: 1, total: 2 });
  });
});

describe('PctResolution — 0% and "no denominator" are different facts', () => {
  test('a real share', () => {
    expect(resolvePct(25, 100)).toEqual({ kind: 'exact', pct: 25 });
    expect(pctField(resolvePct(25, 100))).toBe(25);
  });

  test('a genuine zero share stays a number', () => {
    expect(pctField(resolvePct(0, 100))).toBe(0);
  });

  test('⛔ an empty axis is unknown, and must NOT serialise as 0', () => {
    const r = resolvePct(0, 0);
    expect(r.kind).toBe('unknown');
    expect(pctField(r)).toBeNull();
    expect(pctField(r)).not.toBe(0);
  });

  test('non-finite inputs are unknown, not NaN in the body', () => {
    expect(pctField(resolvePct(Number.NaN, 10))).toBeNull();
  });
});
