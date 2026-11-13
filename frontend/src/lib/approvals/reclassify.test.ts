// REALIGN R5 — the client mirror of the server's RECLASSIFY refusals
// (`backend/src/domain/engagement/deblock-actions.ts :: classifyReclassifyDecision`).
import { describe, it, expect } from 'vitest';
import { currentCardTypeOf, reclassifyEligible, validateReclassify } from './reclassify';
import { approveConsequenceNotice, cardMoveOnApprove } from './question';

const ROSTER = ['development_bug_fix', 'development_feature_new'];

describe('validateReclassify', () => {
  it('refuses a missing, unknown, or unchanged type; accepts a different known one', () => {
    expect(validateReclassify('', 'development_bug_fix', ROSTER)).not.toBeNull();
    expect(validateReclassify('nope', 'development_bug_fix', ROSTER)).not.toBeNull();
    expect(validateReclassify('development_bug_fix', 'development_bug_fix', ROSTER)).not.toBeNull();
    expect(validateReclassify('development_feature_new', 'development_bug_fix', ROSTER)).toBeNull();
  });
});

describe('reclassifyEligible', () => {
  it('only a BLOCKED-exit proposition, never a signoff row', () => {
    expect(reclassifyEligible({ metadata: { deblock_action: 'RETRY' } })).toBe(true);
    expect(reclassifyEligible({ metadata: {} })).toBe(false);
    expect(reclassifyEligible({ metadata: { deblock_action: 'WAT' } })).toBe(false);
    expect(
      reclassifyEligible({ kind: 'execution.ready_signoff', metadata: { deblock_action: 'RETRY' } }),
    ).toBe(false);
  });

  it('reads the current type from metadata', () => {
    expect(currentCardTypeOf({ metadata: { card_type: 'development_bug_fix' } })).toBe(
      'development_bug_fix',
    );
    expect(currentCardTypeOf({ metadata: {} })).toBeNull();
  });
});

describe('a stored RECLASSIFY is a move to TODO', () => {
  it('names TODO and the reclassify', () => {
    const row = { metadata: { deblock_action: 'RECLASSIFY' } };
    expect(cardMoveOnApprove(row)).toBe('TODO');
    expect(approveConsequenceNotice(row)).toContain('RECLASSIFY');
  });
});
