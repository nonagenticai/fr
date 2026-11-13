// tests/unit/routes/approvals-coverage.test.ts
//
// COVERAGE deblock action (George BDD ruling 2026-10-01): a coding card whose ACs lack an
// executed passing scenario gets a coverage approval — approve = covered, reject = a gap,
// per criterion via `rejected_criterion_ids`. DB-free: the resolver, the classifier, the
// metadata builder, the payload builder and the chat-seat predicate are all pure, and the
// PUT handler calls exactly these (routes/approvals.ts handleUpdateApproval). The route
// wiring itself was proven by the approvals integration suite, deleted 2026-10-29 —
// no longer in the suite.

import { describe, expect, test } from 'bun:test';
import {
  APPROVED_ACTION_TARGET,
  classifyCoverageDecision,
  isBugFixAuthorizationRow,
  coverageCriterionIds,
  coverageRefusalMessage,
  lapseHolds,
  plannedCardMove,
  resolveCoverageDecision,
  stripDecideOwnedMetadata,
  type CoverageDecision,
  type CoverageRefusal,
} from '../../../src/domain/engagement/deblock-actions';
import { buildDecisionMetadata } from '../../../src/routes/approvals';
import { N8nCardApprovalSchema } from '../../../src/routes/webhooks';
import { buildCallbackPayload } from '../../../src/services/n8n-callback';
import { REJECTED_HOLD_ACTIONS } from '../../../src/workers/deblock-callback-redelivery';

const IDS = ['AC-1', 'AC-2', 'AC-3'] as const;
const coverageRequest = {
  qa_head_sha: 'abc123',
  criteria: IDS.map((id, i) => ({
    criterion_id: id,
    text: `criterion ${i + 1}`,
    scenario_id: i === 0 ? `SC-${i + 1}` : null,
    reason_not_computed: 'no executed scenario',
  })),
  artifacts: [{ kind: 'pr', ref: 'https://github.com/o/r/pull/1', sha: 'abc123' }],
};
const coverageRow = { deblock_action: 'COVERAGE', card_type: 'development_bug_fix', coverage_request: coverageRequest };

/** The invariant every resolved decision must satisfy. */
function expectPartition(d: CoverageDecision, all: readonly string[]) {
  const union = [...d.covered_criterion_ids, ...d.rejected_criterion_ids].sort();
  expect(union).toEqual([...all].sort());
  expect(d.covered_criterion_ids.filter((id) => d.rejected_criterion_ids.includes(id))).toEqual([]);
  expect(d.criteria_total).toBe(all.length);
}

describe('resolveCoverageDecision — the four resolution cases', () => {
  test('approve, none named → covered = all, rejected = []', () => {
    const d = resolveCoverageDecision({ decision: 'approve', criterionIds: IDS, rejected: undefined });
    expect(d).toEqual({
      decision: 'approve',
      rejected_criterion_ids: [],
      covered_criterion_ids: [...IDS],
      criteria_total: 3,
    });
    expectPartition(d, IDS);
    // An EMPTY list is the same as none on approve.
    expect(resolveCoverageDecision({ decision: 'approve', criterionIds: IDS, rejected: [] })).toEqual(d);
  });

  test('approve, some named → a PARTIAL approve: rejected = named, covered = rest', () => {
    const d = resolveCoverageDecision({ decision: 'approve', criterionIds: IDS, rejected: ['AC-2'] });
    expect(d.rejected_criterion_ids).toEqual(['AC-2']);
    expect(d.covered_criterion_ids).toEqual(['AC-1', 'AC-3']);
    expectPartition(d, IDS);
  });

  test('reject, none named → rejected = ALL, covered = []', () => {
    const d = resolveCoverageDecision({ decision: 'reject', criterionIds: IDS, rejected: undefined });
    expect(d.rejected_criterion_ids).toEqual([...IDS]);
    expect(d.covered_criterion_ids).toEqual([]);
    expectPartition(d, IDS);
  });

  test('reject, some named → rejected = named, covered = rest', () => {
    const d = resolveCoverageDecision({ decision: 'reject', criterionIds: IDS, rejected: ['AC-1', 'AC-3'] });
    expect(d.rejected_criterion_ids).toEqual(['AC-1', 'AC-3']);
    expect(d.covered_criterion_ids).toEqual(['AC-2']);
    expectPartition(d, IDS);
  });
});

describe('classifyCoverageDecision — refusals and the resolved verdict', () => {
  const base = { storedAction: 'COVERAGE', overrideAction: undefined, metadata: coverageRow };

  test('approve with no ids resolves covered = all', () => {
    const v = classifyCoverageDecision({ ...base, decision: 'approved', rejectedCriterionIds: undefined });
    expect(v).toEqual({
      coverage: { decision: 'approve', rejected_criterion_ids: [], covered_criterion_ids: [...IDS], criteria_total: 3 },
    });
  });

  test('reject with no ids resolves rejected = all', () => {
    const v = classifyCoverageDecision({ ...base, decision: 'rejected', rejectedCriterionIds: undefined });
    expect(v && 'coverage' in v ? v.coverage.rejected_criterion_ids : null).toEqual([...IDS]);
  });

  test('an id not among the criteria is refused (rejected ⊆ criteria)', () => {
    const v = classifyCoverageDecision({ ...base, decision: 'approved', rejectedCriterionIds: ['AC-9'] });
    expect(v).toEqual({ refusal: 'rejected_criterion_unknown', detail: 'AC-9' });
  });

  test('a duplicate id is refused', () => {
    const v = classifyCoverageDecision({ ...base, decision: 'rejected', rejectedCriterionIds: ['AC-1', 'AC-1'] });
    expect(v).toEqual({ refusal: 'rejected_criterion_duplicate', detail: 'AC-1' });
  });

  test.each([
    [{ deblock_action: 'COVERAGE' }],
    [{ deblock_action: 'COVERAGE', coverage_request: {} }],
    [{ deblock_action: 'COVERAGE', coverage_request: { criteria: [] } }],
    [{ deblock_action: 'COVERAGE', coverage_request: { criteria: [{ text: 'no id' }] } }],
  ])('a COVERAGE row with no usable coverage_request is refused on approve AND reject (%p)', (md) => {
    for (const decision of ['approved', 'rejected']) {
      expect(
        classifyCoverageDecision({ ...base, metadata: md, decision, rejectedCriterionIds: undefined }),
      ).toEqual({ refusal: 'coverage_request_missing' });
    }
  });

  test('rejected_criterion_ids on a non-COVERAGE row is refused; absent is a no-op', () => {
    const other = { storedAction: 'RETRY', overrideAction: undefined, metadata: { deblock_action: 'RETRY' } };
    expect(classifyCoverageDecision({ ...other, decision: 'approved', rejectedCriterionIds: ['AC-1'] })).toEqual({
      refusal: 'rejected_criterion_ids_not_applicable',
    });
    expect(classifyCoverageDecision({ ...other, decision: 'approved', rejectedCriterionIds: undefined })).toBeNull();
  });

  test('an override into or out of COVERAGE is refused; confirming COVERAGE is fine', () => {
    expect(
      classifyCoverageDecision({ ...base, overrideAction: 'RETRY', decision: 'approved', rejectedCriterionIds: undefined }),
    ).toEqual({ refusal: 'coverage_override_refused' });
    expect(
      classifyCoverageDecision({
        storedAction: 'RETRY',
        overrideAction: 'COVERAGE',
        metadata: { deblock_action: 'RETRY' },
        decision: 'approved',
        rejectedCriterionIds: undefined,
      }),
    ).toEqual({ refusal: 'coverage_override_refused' });
    const v = classifyCoverageDecision({ ...base, overrideAction: 'COVERAGE', decision: 'approved', rejectedCriterionIds: undefined });
    expect(v && 'coverage' in v).toBe(true);
  });

  test('every refusal has a message', () => {
    const all: CoverageRefusal[] = [
      'coverage_request_missing',
      'rejected_criterion_unknown',
      'rejected_criterion_duplicate',
      'rejected_criterion_ids_not_applicable',
      'coverage_override_refused',
    ];
    for (const r of all) expect(coverageRefusalMessage(r, 'x').length).toBeGreaterThan(20);
  });

  test('criterion ids are read in order and de-duplicated', () => {
    expect(coverageCriterionIds(coverageRow)).toEqual([...IDS]);
    expect(
      coverageCriterionIds({ coverage_request: { criteria: [{ criterion_id: 'A' }, { criterion_id: 'A' }, { criterion_id: 'B' }] } }),
    ).toEqual(['A', 'B']);
  });
});

describe('COVERAGE card-move: computed from the stored decision + card type, never the table', () => {
  test('no table target; no usable decision holds; a lapse holds', () => {
    expect(APPROVED_ACTION_TARGET.COVERAGE).toBeNull();
    expect(lapseHolds('COVERAGE')).toBe(true);
    expect(plannedCardMove({ decision: 'approved', action: 'COVERAGE' }).held).toBe('coverage_decision_missing');
    expect(plannedCardMove({ decision: 'expired', action: 'COVERAGE' }).held).toBe('lapsed_proposition');
  });
});

describe('coverage_decision round-trips into the n8n callback payload', () => {
  function approvalWith(metadata: Record<string, unknown>, status = 'approved') {
    return {
      id: 'approval-cov',
      tenant_id: 'tenant-1',
      status,
      kind: 'card_approval',
      card_id: 'card-1',
      callback_path: 'kanban/approval-callback',
      metadata,
    } as any;
  }
  const lastDecision = { approver_id: 'user-1', comment: 'looks covered' } as any;

  test('decision -> stored metadata -> payload carries coverage_decision', () => {
    const v = classifyCoverageDecision({
      decision: 'approved',
      storedAction: 'COVERAGE',
      overrideAction: undefined,
      metadata: coverageRow,
      rejectedCriterionIds: ['AC-3'],
    });
    const coverageDecision = v && 'coverage' in v ? v.coverage : undefined;
    expect(coverageDecision).toBeDefined();
    const md = buildDecisionMetadata({
      snapshot: coverageRow,
      suppliedAction: undefined,
      newCardType: undefined,
      proposedAction: 'COVERAGE',
      overriddenAction: undefined,
      deciderId: 'user-1',
      coverageDecision,
    });
    expect(md?.coverage_decision).toEqual(coverageDecision);
    expect(md?.coverage_request).toEqual(coverageRequest);
    const payload = buildCallbackPayload(approvalWith(md!), lastDecision);
    expect(payload.deblock_action).toBe('COVERAGE');
    expect(payload.coverage_decision).toEqual({
      decision: 'approve',
      rejected_criterion_ids: ['AC-3'],
      covered_criterion_ids: ['AC-1', 'AC-2'],
      criteria_total: 3,
    });
  });

  test('a stray stored coverage_decision never rides on another action', () => {
    const payload = buildCallbackPayload(
      approvalWith({ deblock_action: 'RETRY', coverage_decision: { decision: 'approve', rejected_criterion_ids: [], covered_criterion_ids: [], criteria_total: 0 } }),
      lastDecision,
    );
    expect(payload.coverage_decision).toBeUndefined();
    expect('coverage_decision' in JSON.parse(JSON.stringify(payload))).toBe(false);
  });

  // A lapse or a void is NOT a sign-off: a pre-set coverage_decision (minter-supplied or
  // otherwise) on an expired/voided COVERAGE row must never reach n8n as a verdict.
  test.each(['expired', 'voided'])('a %s COVERAGE row never forwards a pre-set coverage_decision', (status) => {
    const preset = {
      ...coverageRow,
      coverage_decision: { decision: 'approve', rejected_criterion_ids: [], covered_criterion_ids: [...IDS], criteria_total: 3 },
    };
    const payload = buildCallbackPayload(approvalWith(preset, status), lastDecision);
    expect(payload.decision).toBe(status as any);
    expect(payload.coverage_decision).toBeUndefined();
    expect('coverage_decision' in JSON.parse(JSON.stringify(payload))).toBe(false);
  });

  test('CONTROL: the same row as rejected DOES forward its coverage_decision', () => {
    const preset = {
      ...coverageRow,
      coverage_decision: { decision: 'reject', rejected_criterion_ids: ['AC-1'], covered_criterion_ids: ['AC-2', 'AC-3'], criteria_total: 3 },
    };
    const payload = buildCallbackPayload(approvalWith(preset, 'rejected'), lastDecision);
    expect(payload.coverage_decision?.decision).toBe('reject');
  });

  test('no coverage decision and no action: the decision rewrites no metadata', () => {
    expect(
      buildDecisionMetadata({
        snapshot: {},
        suppliedAction: undefined,
        newCardType: undefined,
        proposedAction: undefined,
        overriddenAction: undefined,
        deciderId: 'u',
      }),
    ).toBeUndefined();
  });
});

describe('the mint keeps coverage_request (N8nCardApprovalSchema)', () => {
  const minimal = { card_id: 'c1', card_name: 'n', reason: 'r', deblock_action: 'COVERAGE' };

  test('metadata.coverage_request survives parsing', () => {
    const parsed = N8nCardApprovalSchema.parse({ ...minimal, metadata: { coverage_request: coverageRequest } });
    expect(parsed.metadata?.coverage_request?.criteria.map((c) => c.criterion_id)).toEqual([...IDS]);
  });

  test('a malformed coverage_request is dropped, never a 400 at the door', () => {
    const parsed = N8nCardApprovalSchema.parse({ ...minimal, metadata: { coverage_request: { criteria: 'nope' } } });
    expect(parsed.metadata?.coverage_request).toBeUndefined();
  });
});

describe('isBugFixAuthorizationRow — the ONE definition of the bug-fix gate marker', () => {
  test.each([
    [{ metadata: { approval_kind: 'bug_fix_authorization' } }, true],
    [{ kind: 'execution.ready_signoff', metadata: { approval_kind: 'bug_fix_authorization' } }, true],
    [{ kind: 'generic', metadata: { approval_kind: 'bug_fix_authorization', deblock_action: 'QUESTION' } }, true],
    [{ metadata: { approval_kind: 'decomposition' } }, false],
    [{ metadata: { approval_kind: 'BUG_FIX_AUTHORIZATION' } }, false],
    [{ metadata: { approval_kind: ['bug_fix_authorization'] } }, false],
    [{ metadata: ['bug_fix_authorization'] }, false],
    [{ metadata: 'bug_fix_authorization' }, false],
    [{ metadata: {} }, false],
    [{ metadata: null }, false],
    [{}, false],
  ])('%j → %p', (row, expected) => {
    expect(isBugFixAuthorizationRow(row)).toBe(expected);
  });
});

describe('decide-owned metadata keys are stripped from a minter', () => {
  test('coverage_decision and new_card_type are removed; everything else is kept', () => {
    const out = stripDecideOwnedMetadata({
      ...coverageRow,
      coverage_decision: { decision: 'approve' },
      new_card_type: 'feature',
    }) as Record<string, unknown>;
    expect('coverage_decision' in out).toBe(false);
    expect('new_card_type' in out).toBe(false);
    expect(out.coverage_request).toEqual(coverageRequest);
    expect(out.deblock_action).toBe('COVERAGE');
  });

  test('non-object metadata passes through', () => {
    expect(stripDecideOwnedMetadata(null)).toBeNull();
    expect(stripDecideOwnedMetadata(undefined)).toBeUndefined();
  });
});

describe('a rejected COVERAGE row is redeliverable (not a rejected hold)', () => {
  test('COVERAGE is absent from REJECTED_HOLD_ACTIONS; the other holds stay', () => {
    expect(REJECTED_HOLD_ACTIONS).not.toContain('COVERAGE');
    for (const a of ['QUESTION', 'INFRASTRUCTURE', 'DEPENDENCY', 'RECLASSIFY', 'MERGE']) {
      expect(REJECTED_HOLD_ACTIONS).toContain(a);
    }
  });
});
