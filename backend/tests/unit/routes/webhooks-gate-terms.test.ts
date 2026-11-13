// tests/unit/routes/webhooks-gate-terms.test.ts
//
// `gate_terms` is the evidence an approver answers against. fr was the reason it
// could never arrive.
//
// MEASURED on prod 2026-09-05: a full triage of the 274 approvals expiring
// 09-09/10 scored ALL 274 `insufficient_evidence` — zero decidable — because
// `metadata.gate_terms` is absent on every one. That was not missing data. It
// was unreachable by construction:
//
//   1. `N8nApprovalRequestSchema` had NO field for it, so a producer could not
//      send it even if it wanted to; and
//   2. the mint hardcoded `metadata: { card_name }`, so anything sent would
//      have been discarded anyway.
//
// Meanwhile `workers/approval-redelivery.ts` (#921) READS
// `metadata->'gate_terms'` to build its digest breakdown, and therefore always
// reports "(no gate_terms recorded)" — a consumer whose input no producer could
// supply.
//
// ⚠️ This does NOT make the 274 answerable and does not populate any existing
// row. It removes fr as the obstacle so the evidence CAN arrive.

import { describe, expect, test } from 'bun:test';

import { N8nApprovalRequestSchema } from '../../../src/routes/webhooks';

const base = {
  fr_project_id: '11111111-1111-1111-1111-111111111111',
  card_name: 'Ship the thing',
  reason: 'Needs a human',
  callback_path: '/webhook/cb',
  card_id: 'card-1',
  required_approvers: [{ user_id: '22222222-2222-2222-2222-222222222222' }],
};

describe('the payload can carry the gate evidence', () => {
  test('gate_terms is accepted and preserved', () => {
    const parsed = N8nApprovalRequestSchema.parse({
      ...base,
      gate_terms: ['tests_pass', 'no_secrets_added'],
    });

    expect(parsed.gate_terms).toEqual(['tests_pass', 'no_secrets_added']);
  });

  test('omitting it still parses — producers that do not send it keep working', () => {
    // The compatibility control. Every existing n8n producer omits this field;
    // making it required would refuse every live caller at once.
    const parsed = N8nApprovalRequestSchema.parse(base);

    expect(parsed.gate_terms).toBeUndefined();
  });

  test('an empty-string term is refused', () => {
    // `[""]` is the placeholder shape — it satisfies "an array was sent" while
    // carrying no evidence, which is the same class of defect as the empty
    // `reason` that fr#942 already refuses at this seam.
    expect(() => N8nApprovalRequestSchema.parse({ ...base, gate_terms: [''] })).toThrow();
  });

  test('a non-array is refused', () => {
    expect(() =>
      N8nApprovalRequestSchema.parse({ ...base, gate_terms: 'tests_pass' }),
    ).toThrow();
  });
});
