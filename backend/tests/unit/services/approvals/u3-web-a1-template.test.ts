// tests/unit/services/approvals/u3-web-a1-template.test.ts
//
// webA1DecideTemplate — the G-12 fields GET /api/approvals/:id serves to the web per-bug
// reject picker. PURE (no DB). The gate that consumes the bodies the picker builds is covered
// by u3-gates.test.ts § 'decide gates on a MARKED row (G-12 A1 + rejected_bug_ids)'.

import { describe, expect, test } from 'bun:test';
import { G12_RULES, g12CodesFor, g12RowKeyFor } from '../../../../src/services/approvals/g12-rule';
import { webA1DecideTemplate } from '../../../../src/services/approvals/u3-gates';

const LATEST = G12_RULES[G12_RULES.length - 1]!;
const ROW_A1 = g12RowKeyFor(LATEST, 'bug_fix_authorization')!;
const HASH = 'a'.repeat(64);
const marked = { approval_kind: 'bug_fix_authorization', report_id: 'r-1', report_hash: HASH, bug_ids: ['b0'], bug_card_id: 'c' };

describe('webA1DecideTemplate', () => {
  test('marked execution.ready_signoff → latest rule, A1 row, report_hash, the closed reject set', () => {
    expect(webA1DecideTemplate({ kind: 'execution.ready_signoff', metadata: marked })).toEqual({
      rule_version: LATEST.rule_version,
      rule_row: ROW_A1,
      inputs_hash: HASH,
      reject_codes: [...g12CodesFor(LATEST.rule_version, ROW_A1)!.reject],
    });
  });

  test('null for a marked GENERIC row (its approve authorises no fix, RULING a 10-01)', () => {
    expect(webA1DecideTemplate({ kind: 'generic', metadata: marked })).toBeNull();
  });

  test('null for an unmarked ready_signoff, any other kind, and a marked row with no report_hash', () => {
    expect(webA1DecideTemplate({ kind: 'execution.ready_signoff', metadata: { report_hash: HASH } })).toBeNull();
    expect(webA1DecideTemplate({ kind: 'execution.feature_design_approval', metadata: marked })).toBeNull();
    expect(webA1DecideTemplate({ kind: 'execution.ready_signoff', metadata: null })).toBeNull();
    const { report_hash: _h, ...noHash } = marked;
    expect(webA1DecideTemplate({ kind: 'execution.ready_signoff', metadata: noHash })).toBeNull();
  });
});
