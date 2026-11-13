// tests/unit/domain/proof-subset.test.ts
//
// Liveness never counts toward DONE (design: liveness-done-paths-proof-subset-2026-10-05;
// ncn#2087). Pure-domain half: the two type sets, the RECLASSIFY gate predicate, the
// COVERAGE / DROP targets fr predicts, and the byte-stable contract fixture ncn tests against.

import { describe, expect, test } from 'bun:test';

import {
  DROPPED_LIST_NAME,
  PROOF_SUBSET_CARD_TYPES,
  isProofSubsetCardType,
  reclassifyEscapesComputedGate,
} from '../../../src/domain/engagement/proof-subset';
import {
  APPROVED_ACTION_TARGET,
  coverageTarget,
  plannedCardMove,
} from '../../../src/domain/engagement/deblock-actions';
import { serializeDeblockTargetContract } from '../../../src/domain/engagement/deblock-target-contract';

const CONTRACT_PATH = new URL(
  '../../../src/domain/engagement/spec/deblock-target-contract.json',
  import.meta.url,
).pathname;

describe('proof-subset membership', () => {
  test('membership is exact, not substring', () => {
    expect(isProofSubsetCardType('bug_analysis')).toBe(true);
    expect(isProofSubsetCardType('bug_analysis_extra')).toBe(false);
    expect(isProofSubsetCardType('development_feature_new')).toBe(false);
    expect(isProofSubsetCardType(undefined)).toBe(false);
  });
});

// The DONE family is single-sourced in lib/done-equivalent.ts.

const GATED = new Set(['development_bug_fix', 'development_feature_update']);
const isComputedGated = (t: unknown): boolean => typeof t === 'string' && GATED.has(t);

describe('RECLASSIFY may not escape the computed gate', () => {
  test('proof source -> judge/liveness type is refused', () => {
    expect(reclassifyEscapesComputedGate({ sourceCardType: 'development_bug_fix', newCardType: 'code_quality_analysis', isComputedGated })).toBe(true);
    expect(reclassifyEscapesComputedGate({ sourceCardType: 'bug_analysis', newCardType: 'gap_analysis', isComputedGated })).toBe(true);
  });
  test('CONTROL: proof source -> a computed-gated type is allowed', () => {
    expect(reclassifyEscapesComputedGate({ sourceCardType: 'development_bug_fix', newCardType: 'development_feature_update', isComputedGated })).toBe(false);
  });
  test('CONTROL: a non-proof source is never refused by this rule', () => {
    expect(reclassifyEscapesComputedGate({ sourceCardType: 'development_feature_new', newCardType: 'code_quality_analysis', isComputedGated })).toBe(false);
  });
});

describe('DROP goes to the NON-DONE terminal, never DONE', () => {
  test('approved DROP plans DROPPED for every type', () => {
    expect(APPROVED_ACTION_TARGET.DROP).toBe(DROPPED_LIST_NAME);
    for (const t of [...PROOF_SUBSET_CARD_TYPES, 'development_feature_new']) {
      const plan = plannedCardMove({ decision: 'approved', action: 'DROP', cardType: t });
      expect(plan.target).toBe('DROPPED');
    }
  });
});

describe('COVERAGE: an approved coverage never sends a proof-subset card to DONE', () => {
  test('nothing rejected: proof -> QA (computed recheck); other -> DONE', () => {
    for (const t of PROOF_SUBSET_CARD_TYPES) {
      expect(coverageTarget({ rejectedCount: 0, cardType: t })).toBe('QA');
      expect(plannedCardMove({ decision: 'approved', action: 'COVERAGE', cardType: t, coverageRejectedCount: 0 }).target).toBe('QA');
    }
    expect(coverageTarget({ rejectedCount: 0, cardType: 'development_feature_new' })).toBe('DONE');
  });
  test('any rejected (approve-in-part or reject) -> TODO for every type', () => {
    expect(coverageTarget({ rejectedCount: 1, cardType: 'bug_analysis' })).toBe('TODO');
    expect(plannedCardMove({ decision: 'rejected', action: 'COVERAGE', cardType: 'x', coverageRejectedCount: 3 }).target).toBe('TODO');
  });
  test('no usable decision is a hold, never a move', () => {
    const plan = plannedCardMove({ decision: 'approved', action: 'COVERAGE', cardType: 'bug_analysis' });
    expect(plan.moves).toBe(false);
    expect(plan.held).toBe('coverage_decision_missing');
    expect(coverageTarget({ rejectedCount: -1, cardType: 'bug_analysis' })).toBeNull();
  });
});

describe('the contract fixture is generated, byte-for-byte', () => {
  test('committed bytes == plannedCardMove regenerated (run scripts/gen-deblock-target-contract.ts)', async () => {
    const committed = await Bun.file(CONTRACT_PATH).text();
    expect(committed).toBe(serializeDeblockTargetContract());
  });
  test('no proof-subset cell ever targets DONE', async () => {
    const c = JSON.parse(await Bun.file(CONTRACT_PATH).text()) as {
      targets: Record<string, Record<string, string | null>>;
    };
    for (const [key, row] of Object.entries(c.targets)) {
      for (const t of PROOF_SUBSET_CARD_TYPES) {
        expect(`${key}:${t}:${row[t]}`).not.toEndWith(':DONE');
      }
    }
    // CONTROL: the fixture CAN express DONE (the non-proof coverage cell), so the loop above
    // is not vacuous.
    expect(c.targets['COVERAGE:approved:none_rejected']!['*']).toBe('DONE');
  });
});
