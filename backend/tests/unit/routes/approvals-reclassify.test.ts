// tests/unit/routes/approvals-reclassify.test.ts
//
// REALIGN R5 — a decider choosing RECLASSIFY must name a new card_type, and that type must
// survive the whole path: decision body -> stored approval metadata -> buildCallbackPayload
// -> the n8n callback payload. Both ends are CLOSED field lists, so a field missing from
// either is dropped silently and the card re-runs under its OLD type. DB-free: the refusal
// predicate, the metadata builder and the payload builder are all pure, and the handler
// calls exactly these three (see routes/approvals.ts handleUpdateApproval).

import { describe, expect, test } from 'bun:test';
import {
  classifyReclassifyDecision,
  reclassifyRefusalMessage,
} from '../../../src/domain/engagement/deblock-actions';
import { buildDecisionMetadata } from '../../../src/routes/approvals';
import { buildCallbackPayload } from '../../../src/services/n8n-callback';

const CURRENT = 'development_bug_fix';
const TARGET = 'development_feature_new';
// The tenant catalogue is the caller's concern; the check takes plain predicates.
const KNOWN_CARD_TYPES: ReadonlySet<string> = new Set([CURRENT, TARGET]);
const isKnownCardType = (t: string) => KNOWN_CARD_TYPES.has(t);
const isRefusedTarget = (_t: string) => false;

function blockedApproval(metadata: Record<string, unknown>) {
  return {
    id: 'approval-r5',
    tenant_id: 'tenant-1',
    status: 'approved',
    kind: 'card_approval',
    card_id: 'card-1',
    callback_path: 'kanban/approval-callback',
    metadata,
  } as any;
}
const decision = { approver_id: 'user-1', comment: 'wrong type' } as any;
const snapshot = {
  card_type: CURRENT,
  doingListId: 'list-doing',
  todoListId: 'list-todo',
  boardId: 'board-1',
  deblock_action: 'RETRY',
};

describe('(b) an approved RECLASSIFY must name a real, different card type', () => {
  const base = {
    decision: 'approved',
    effectiveAction: 'RECLASSIFY',
    currentCardType: CURRENT,
    isKnownCardType,
    isRefusedTarget,
  };

  test.each([[undefined], [''], ['   ']])('missing new_card_type %p is refused', (t) => {
    expect(classifyReclassifyDecision({ ...base, newCardType: t })).toBe('new_card_type_required');
  });

  test('an unknown type is refused', () => {
    expect(classifyReclassifyDecision({ ...base, newCardType: 'not_a_card_type' })).toBe(
      'new_card_type_unknown',
    );
  });

  test('the card’s current type is refused', () => {
    expect(classifyReclassifyDecision({ ...base, newCardType: CURRENT })).toBe(
      'new_card_type_unchanged',
    );
  });

  test('CONTROL: a known, different type is accepted', () => {
    expect(classifyReclassifyDecision({ ...base, newCardType: TARGET })).toBeNull();
  });

  test('no current type recorded: the unchanged check abstains, never matches', () => {
    expect(
      classifyReclassifyDecision({ ...base, currentCardType: undefined, newCardType: TARGET }),
    ).toBeNull();
  });

  test('a REJECTED RECLASSIFY needs no type — rejecting must stay possible', () => {
    expect(
      classifyReclassifyDecision({ ...base, decision: 'rejected', newCardType: undefined }),
    ).toBeNull();
  });

  test('every refusal has a decider-facing message naming new_card_type', () => {
    for (const r of [
      'new_card_type_required',
      'new_card_type_unknown',
      'new_card_type_qa_dead_end',
      'new_card_type_unchanged',
      'new_card_type_not_applicable',
    ] as const) {
      expect(reclassifyRefusalMessage(r, { newCardType: 'x', currentCardType: CURRENT })).toMatch(
        /new_card_type|RECLASSIFY/,
      );
    }
  });
});

describe('(c) RECLASSIFY + new_card_type round-trips into the n8n callback payload', () => {

  test('a machine-proposed RECLASSIFY confirmed with only new_card_type still carries it', () => {
    const stored = buildDecisionMetadata({
      snapshot: { ...snapshot, deblock_action: 'RECLASSIFY' },
      suppliedAction: undefined,
      newCardType: TARGET,
      proposedAction: 'RECLASSIFY',
      overriddenAction: undefined,
      deciderId: 'user-1',
    });
    // The stored action is preserved, not overwritten with undefined.
    expect(stored?.deblock_action).toBe('RECLASSIFY');
    const payload = buildCallbackPayload(blockedApproval(stored!), decision);
    expect(payload.new_card_type).toBe(TARGET);
  });
});

describe('(d) a non-RECLASSIFY decision never carries new_card_type', () => {

  test('a RETRY decision stores no new_card_type and the payload carries none', () => {
    const stored = buildDecisionMetadata({
      snapshot,
      suppliedAction: 'RETRY',
      newCardType: undefined,
      proposedAction: 'RETRY',
      overriddenAction: undefined,
      deciderId: 'user-1',
    });
    expect(stored && 'new_card_type' in stored).toBe(false);
    const payload = buildCallbackPayload(blockedApproval(stored!), decision);
    expect(payload.deblock_action).toBe('RETRY');
    expect(payload.new_card_type).toBeUndefined();
  });

  test('a stray stored new_card_type never rides on another action', () => {
    const payload = buildCallbackPayload(
      blockedApproval({ ...snapshot, deblock_action: 'RETRY', new_card_type: TARGET }),
      decision,
    );
    expect(payload.deblock_action).toBe('RETRY');
    expect(payload.new_card_type).toBeUndefined();
  });

  test('no action and no type: the decision rewrites no metadata', () => {
    expect(
      buildDecisionMetadata({
        snapshot,
        suppliedAction: undefined,
        newCardType: undefined,
        proposedAction: 'RETRY',
        overriddenAction: undefined,
        deciderId: 'user-1',
      }),
    ).toBeUndefined();
  });
});
