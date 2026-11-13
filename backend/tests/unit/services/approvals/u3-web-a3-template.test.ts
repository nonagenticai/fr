// tests/unit/services/approvals/u3-web-a3-template.test.ts
//
// webA3DecideTemplate — the G-12 fields GET /api/approvals/:id serves (as `g12_decide_a3`) to
// the web A3 review form. PURE (no DB): the A3 decide gate reads nothing from the executor, so
// the round-trip below runs the REAL assertU3DecideGates on the body the browser would build.

import { describe, expect, test } from 'bun:test';
import { G12_RULES, g12CodesFor, g12RowKeyFor } from '../../../../src/services/approvals/g12-rule';
import {
  FEATURE_DESIGN_APPROVAL_KIND,
  assertU3DecideGates,
  webA3DecideTemplate,
} from '../../../../src/services/approvals/u3-gates';
import { A3_INPUTS_HASH, HUMAN_DECIDER_ID, sealedDesignMetadata } from './u3-fixtures';

const LATEST = G12_RULES[G12_RULES.length - 1]!;
const ROW_A3 = g12RowKeyFor(LATEST, FEATURE_DESIGN_APPROVAL_KIND)!;
const CODES = g12CodesFor(LATEST.rule_version, ROW_A3)!;

function a3(metadata: unknown) {
  return { id: 'a3-1', tenant_id: 't-1', kind: FEATURE_DESIGN_APPROVAL_KIND, metadata };
}

describe('webA3DecideTemplate', () => {
  test('sealed A3 → latest rule, A3 row, the SEALED a3_inputs_hash (not design_hash), the design item, both code sets', () => {
    const t = webA3DecideTemplate(a3(sealedDesignMetadata()));
    expect(t).toEqual({
      rule_version: LATEST.rule_version,
      rule_row: ROW_A3,
      inputs_hash: A3_INPUTS_HASH,
      item_id: 'design-1',
      approve_codes: [...CODES.approve],
      reject_codes: [...CODES.reject],
    });
    expect(t!.inputs_hash).not.toBe(sealedDesignMetadata().design_hash);
  });

  test('null for another kind, and for an A3 missing design_hash / design_artifact_id / its seal', () => {
    expect(webA3DecideTemplate({ ...a3(sealedDesignMetadata()), kind: 'execution.ready_signoff' })).toBeNull();
    expect(webA3DecideTemplate(a3(null))).toBeNull();
    const { design_hash: _h, ...noHash } = sealedDesignMetadata();
    expect(webA3DecideTemplate(a3(noHash))).toBeNull();
    const { design_artifact_id: _d, ...noId } = sealedDesignMetadata();
    expect(webA3DecideTemplate(a3(noId))).toBeNull();
    const { a3_inputs_hash: _s, ...unsealed } = sealedDesignMetadata();
    expect(webA3DecideTemplate(a3(unsealed))).toBeNull();
  });

  test('null when the stored write_set no longer recomputes to its seal (the gate would 409)', () => {
    expect(webA3DecideTemplate(a3({ ...sealedDesignMetadata(), write_set: ['src/other.ts'] }))).toBeNull();
  });

  test('round-trip: the bodies the browser builds from the template pass the real decide gate', async () => {
    const t = webA3DecideTemplate(a3(sealedDesignMetadata()))!;
    const base = { rule_version: t.rule_version, rule_row: t.rule_row, inputs_hash: t.inputs_hash };
    const approved = await assertU3DecideGates({
      approval: a3(sealedDesignMetadata()),
      rawBody: { g12_decision: { ...base, items: [{ item_id: t.item_id, decision: 'approve', reason_code: t.approve_codes[0] }] } },
      status: 'approved',
      deciderId: HUMAN_DECIDER_ID,
    });
    expect(approved?.items).toEqual([{ item_id: 'design-1', decision: 'approve', reason_code: t.approve_codes[0]! }]);
    const code = t.reject_codes[0]!;
    const rejected = await assertU3DecideGates({
      approval: a3(sealedDesignMetadata()),
      rawBody: { reason: code, g12_decision: { ...base, items: [{ item_id: t.item_id, decision: 'reject', reason_code: code }] } },
      status: 'rejected',
      deciderId: HUMAN_DECIDER_ID,
    });
    expect(rejected?.items[0]?.decision).toBe('reject');
  });
});
