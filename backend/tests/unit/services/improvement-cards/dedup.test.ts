import { describe, it, expect } from 'bun:test';
import {
  DEDUP_CARD_TYPES,
  PARENT_APPROVAL_DEDUP_CARD_TYPES,
} from '../../../../src/services/improvement-cards/dedup';

describe('dedup card types', () => {
  it('only the *_analysis card types are eligible for dedup', () => {
    expect(DEDUP_CARD_TYPES.has('workflow_statistics_analysis')).toBe(true);
    expect(DEDUP_CARD_TYPES.has('prompt_performance_statistics_analysis')).toBe(
      true,
    );
    expect(
      DEDUP_CARD_TYPES.has('procedure_performance_statistics_analysis'),
    ).toBe(true);
    // asset-authoring + execution card types must never be deduped
    expect(DEDUP_CARD_TYPES.has('principle')).toBe(false);
    expect(DEDUP_CARD_TYPES.has('requirement')).toBe(false);
    expect(DEDUP_CARD_TYPES.has('development_chore')).toBe(false);
  });
});

describe('PARENT_APPROVAL_DEDUP_CARD_TYPES (WS3-C)', () => {
  it('holds exactly the base *_development approval card types', () => {
    expect(PARENT_APPROVAL_DEDUP_CARD_TYPES.has('decision_development')).toBe(
      true,
    );
    expect(PARENT_APPROVAL_DEDUP_CARD_TYPES.has('principle_development')).toBe(
      true,
    );
    expect(
      PARENT_APPROVAL_DEDUP_CARD_TYPES.has('requirement_development'),
    ).toBe(true);
    // The three named positives (plus the negatives below) are the assertion;
    // `.size === 3` was a hardcoded count of the set and is deleted.
  });

  it('does NOT include the change_*_development variants (they carry a real asset_id via agent.update_asset)', () => {
    expect(
      PARENT_APPROVAL_DEDUP_CARD_TYPES.has('change_decision_development'),
    ).toBe(false);
    expect(
      PARENT_APPROVAL_DEDUP_CARD_TYPES.has('change_principle_development'),
    ).toBe(false);
    expect(
      PARENT_APPROVAL_DEDUP_CARD_TYPES.has('change_requirement_development'),
    ).toBe(false);
  });

  it('does NOT pollute DEDUP_CARD_TYPES (the two sets stay disjoint)', () => {
    for (const t of PARENT_APPROVAL_DEDUP_CARD_TYPES) {
      expect(DEDUP_CARD_TYPES.has(t)).toBe(false);
    }
    for (const t of DEDUP_CARD_TYPES) {
      expect(PARENT_APPROVAL_DEDUP_CARD_TYPES.has(t)).toBe(false);
    }
  });

});
