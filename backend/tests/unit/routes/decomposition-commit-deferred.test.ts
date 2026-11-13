// tests/unit/routes/decomposition-commit-deferred.test.ts — U-PS-COMMIT:
// the decomposition commit accepts DEFERRED deliverables (no card minted for
// them at commit). Pure validation + promote carry-through; the DB half (the
// deliverable-minted integration suite) was deleted 2026-10-29 — no longer in the suite.

import { describe, expect, test } from 'bun:test';

import { validateCommitPlan } from '../../../src/routes/decomposition-commit';
import { buildApprovedScopeRows } from '../../../src/routes/project-requests';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const child = (n: number) => ({ deliverable_id: id(n), card_type: 'development_feature_new' });

describe('validateCommitPlan with deferred deliverables', () => {
  // 3 deliverables: #1 fixed, #2 and #3 deferred (e.g. per_finding hunt output).
  const rows = [
    { id: id(1), kind: 'deliverable', deferred: false },
    { id: id(2), kind: 'deliverable', deferred: true },
    { id: id(3), kind: 'deliverable', deferred: true },
  ];

  test('covering only the fixed deliverable is accepted (deferred ones need no child)', () => {
    expect(validateCommitPlan({ children: [child(1)] }, rows)).toBeNull();
  });

  test('deferred deliverables still count toward 3..7 (2 fixed + 0 deferred would be refused)', () => {
    const two = rows.slice(0, 2).map((r) => ({ ...r, deferred: false }));
    expect(validateCommitPlan({ children: [child(1), child(2)] }, two)?.body.error).toBe(
      'deliverable_count_out_of_range',
    );
    // ...whereas 1 fixed + 2 deferred = 3 deliverables passes the count.
    expect(validateCommitPlan({ children: [child(1)] }, rows)).toBeNull();
  });

  test('MUST-FAIL: a child naming a deferred deliverable ⇒ 422 deliverable_deferred', () => {
    const r = validateCommitPlan({ children: [child(1), child(2)] }, rows);
    expect(r?.status).toBe(422);
    expect(r?.body.error).toBe('deliverable_deferred');
    expect(r?.body.deliverable_ids).toEqual([id(2)]);
  });

  test('a fixed deliverable left uncovered is still coverage_incomplete', () => {
    expect(validateCommitPlan({ children: [] as never[] }, rows)?.body.error).toBe('coverage_incomplete');
  });

  test('CONTROL — the same rows WITHOUT deferred: covering only #1 is coverage_incomplete (today)', () => {
    const today = rows.map(({ id: i, kind }) => ({ id: i, kind }));
    expect(validateCommitPlan({ children: [child(1)] }, today)?.body.error).toBe('coverage_incomplete');
  });
});

describe('promote carries deferred + minter (buildApprovedScopeRows)', () => {
  const outline = (deliverables: unknown[]) => ({
    id: id(99),
    deliverables,
    intermediate_deliverables: [],
    milestones: [],
    effort_estimate: null,
  });

  test('absent ⇒ deferred=false, minter=null (today)', () => {
    const { deliverables } = buildApprovedScopeRows(outline([{ kind: 'x', title: 'a' }]), id(7));
    expect(deliverables[0]!.deferred).toBe(false);
    expect(deliverables[0]!.minter).toBeNull();
  });

  test('deferred + minter carried verbatim', () => {
    const { deliverables } = buildApprovedScopeRows(
      outline([{ kind: 'x', title: 'a', deferred: true, minter: 'bug-hunt-mint' }]),
      id(7),
    );
    expect(deliverables[0]!.deferred).toBe(true);
    expect(deliverables[0]!.minter).toBe('bug-hunt-mint');
  });

  test('MUST-FAIL: deferred without a minter throws (nobody would ever mint it)', () => {
    expect(() =>
      buildApprovedScopeRows(outline([{ kind: 'x', title: 'a', deferred: true }]), id(7)),
    ).toThrow(/deferred but names no minter/);
  });
});
