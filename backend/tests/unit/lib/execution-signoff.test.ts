// tests/unit/lib/execution-signoff.test.ts
//
// Pure (no-DB) coverage for resolveSignoffStakeholderIds — the helper that
// guarantees a project's execution_signoff roster is never empty so a
// gate-eligible decision_development card cannot dead-strand in BLOCKED.

import { test, expect, describe } from 'bun:test';

import {
  resolveSignoffStakeholderIds,
  isFixtureOrigin,
  DEFAULT_FIXTURE_REQUESTORS,
} from '../../../src/lib/execution-signoff';

const OWNER = '0195f48b-1111-7000-8000-000000000abc'; // a valid v7-shaped UUID
const A = '0195f48b-2222-7000-8000-0000000000a1';
const B = '0195f48b-3333-7000-8000-0000000000b2';

describe('resolveSignoffStakeholderIds', () => {
  test('no approvers → falls back to the owner', () => {
    expect(resolveSignoffStakeholderIds([], OWNER)).toEqual([OWNER]);
  });

  test('explicit UUID approvers → kept verbatim, owner NOT appended', () => {
    const out = resolveSignoffStakeholderIds([A, B], OWNER);
    expect(out).toEqual([A, B]);
    expect(out).not.toContain(OWNER);
  });

  test('only free-text / non-UUID approvers → falls back to the owner', () => {
    expect(resolveSignoffStakeholderIds(['Alice', 'Bob Smith'], OWNER)).toEqual([
      OWNER,
    ]);
  });

  test('mixed UUID + free-text → keeps only the valid UUIDs (no owner)', () => {
    expect(resolveSignoffStakeholderIds([A, 'Alice'], OWNER)).toEqual([A]);
  });

  test('duplicate UUID approvers are deduped', () => {
    expect(resolveSignoffStakeholderIds([A, A, B], OWNER)).toEqual([A, B]);
  });

  test('owner already among explicit approvers → no duplicate', () => {
    const out = resolveSignoffStakeholderIds([A, OWNER], OWNER);
    expect(out).toEqual([A, OWNER]);
    expect(out.filter((id) => id === OWNER)).toHaveLength(1);
  });

  test('owner id not a valid UUID and no approvers → empty (defensive)', () => {
    expect(resolveSignoffStakeholderIds([], 'not-a-uuid')).toEqual([]);
  });

  test('bootstrap/AUTH_BYPASS owner (all-zero UUID) is a valid fallback', () => {
    const bypass = '00000000-0000-0000-0000-000000000000';
    expect(resolveSignoffStakeholderIds([], bypass)).toEqual([bypass]);
  });
});

// ---------------------------------------------------------------------------
// isFixtureOrigin — the predicate that suppresses a human approval request
// ---------------------------------------------------------------------------
//
// WHY THIS IS THE LOAD-BEARING TEST. Measured 2026-08-25: all 11 pending human
// approvals in fr were test-fixture traffic (10 descending from the live-fire
// "IT Flow1 — bump fastmcp to 3.4.7" flow, 1 from board smoke-test-2026-05-01),
// against 347 already expired. This predicate is what stops that noise.
//
// Its failure modes are ASYMMETRIC. A false negative costs one ignorable
// approval. A FALSE POSITIVE silently removes a human control — and a sibling
// effort measured a name-regex classifier at a 1.5% false-positive rate whose
// false positive was a SECURITY card. So the negative controls below are not
// padding: they are the point. Every one of them is a string that a substring
// match or a regex over the project NAME would wrongly claim.
const REQ = (requestor: string) => ({ projectData: { requestor } });

describe('isFixtureOrigin — positive cases', () => {
  for (const r of DEFAULT_FIXTURE_REQUESTORS) {
    test(`the real driver ${r} is fixture origin`, () => {
      expect(isFixtureOrigin(REQ(r))).toBe(true);
    });
  }

  test('a driver declaring itself with fixture:true', () => {
    expect(isFixtureOrigin({ projectData: { fixture: true } })).toBe(true);
  });

  test('an exact board id in the allowlist (the stream-backed lane)', () => {
    expect(
      isFixtureOrigin({ boardId: '1781232916739655586' }, { boardIds: ['1781232916739655586'] }),
    ).toBe(true);
  });
});

describe('isFixtureOrigin — NEGATIVE CONTROLS (a false positive deletes a human control)', () => {
  // NON-VACUITY GUARD. Every assertion in this block expects `false`, so they
  // would ALL pass against a predicate that is broken shut — or against a test
  // that simply mis-spells the input field. (That is not hypothetical: the first
  // draft of this file passed `project_data` instead of `projectData`, and every
  // negative below went green while every positive failed.) This one positive
  // pins that the shape reaching the predicate is the shape it actually reads.
  test('GUARD: the input shape is live — a known fixture still matches', () => {
    expect(isFixtureOrigin(REQ('drive-it-flow1-demo.sh'))).toBe(true);
  });

  test('a human requestor is never fixture', () => {
    expect(isFixtureOrigin(REQ('georgiedekker'))).toBe(false);
  });

  // ⛔ THE 1.5%-FP SHAPE. Each of these CONTAINS an allowlisted value, or is
  // contained BY one. `includes()` on an array is per-element ===, so they must
  // all be false; a substring/regex implementation would return true.
  test('a superstring of a driver name is NOT fixture', () => {
    expect(isFixtureOrigin(REQ('my-drive-it-flow1-demo.sh'))).toBe(false);
    expect(isFixtureOrigin(REQ('drive-it-flow1-demo.sh.bak'))).toBe(false);
    expect(isFixtureOrigin(REQ('drive-it-flow1-demo.sh '))).toBe(false); // trailing space
  });

  test('a substring of a driver name is NOT fixture', () => {
    expect(isFixtureOrigin(REQ('drive'))).toBe(false);
    expect(isFixtureOrigin(REQ('smoke'))).toBe(false);
  });

  test('a SECURITY project whose NAME mentions the fixture flow is NOT fixture', () => {
    expect(
      isFixtureOrigin({
        name: 'Security review of IT Flow1 — bump fastmcp to 3.4.7',
        projectData: { requestor: 'security-team' },
      } as Parameters<typeof isFixtureOrigin>[0]),
    ).toBe(false);
  });

  test('case differences are NOT tolerated (exact equality only)', () => {
    expect(isFixtureOrigin(REQ('Drive-IT-Flow1-Demo.sh'))).toBe(false);
  });

  test('a truthy-but-not-true fixture flag is NOT fixture', () => {
    expect(isFixtureOrigin({ projectData: { fixture: 'true' } })).toBe(false);
    expect(isFixtureOrigin({ projectData: { fixture: 1 } })).toBe(false);
  });

  test('a near-miss board id is NOT fixture', () => {
    expect(
      isFixtureOrigin({ boardId: '1781232916739655587' }, { boardIds: ['1781232916739655586'] }),
    ).toBe(false);
  });

  test('absent / malformed project_data is NOT fixture', () => {
    expect(isFixtureOrigin({})).toBe(false);
    expect(isFixtureOrigin({ projectData: null })).toBe(false);
    expect(isFixtureOrigin({ projectData: 'drive-it-flow1-demo.sh' })).toBe(false);
    expect(isFixtureOrigin({ projectData: {} })).toBe(false);
  });

  test('board ids default to EMPTY, so a stream board is not suppressed by accident', () => {
    expect(isFixtureOrigin({ boardId: '1781232916739655586' }, { boardIds: [] })).toBe(false);
  });
});

describe('isFixtureOrigin — the allowlist is overridable', () => {
  test('an operator-supplied list replaces the defaults wholesale', () => {
    expect(isFixtureOrigin(REQ('only-this.sh'), { requestors: ['only-this.sh'] })).toBe(true);
    // ...and the built-in defaults no longer match once overridden — so a
    // narrowing override genuinely narrows.
    expect(isFixtureOrigin(REQ('drive-it-flow1-demo.sh'), { requestors: ['only-this.sh'] })).toBe(false);
  });
});
