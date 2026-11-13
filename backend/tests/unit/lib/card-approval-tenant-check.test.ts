// tests/unit/lib/card-approval-tenant-check.test.ts
//
// fr row 14d-2 — the pure decision behind POST /api/webhooks/n8n/card-approval's
// tag-consistency check, one row per branch of the approved rule, plus the
// counter's closed, pre-seeded series. The route wiring (DB reference
// resolution, 422, nothing minted) was the card-approval-tenant-check-14d2
// integration suite, deleted 2026-10-29 — no longer in the suite.

import { describe, expect, test } from 'bun:test';

import {
  CARD_APPROVAL_TENANT_CHECK_OUTCOMES,
  classifyCardApprovalTenant,
  isRefusedCardApprovalTenant,
  renderCardApprovalTenantCheckMetrics,
} from '../../../src/lib/card-approval-tenant-check';
import {
  AA_CONVEYOR_TENANT_ID,
  EXECUTION_TENANT_ID,
  INTERNAL_SYSTEM_TENANT_ID,
} from '../../../src/middleware/internal-tenant-only';

const CUST_A = '01a0ef72-0000-4000-8000-0000000000a1';
const CUST_B = '351fdc59-6747-4e48-b130-73d8cdb52bf9';

const c = (explicitTenant: string, referenceTenant: string | null, callerTenant?: string) =>
  classifyCardApprovalTenant({ explicitTenant, referenceTenant, callerTenant });

describe('classifyCardApprovalTenant — the approved rule', () => {
  test('equal ⇒ match', () => {
    expect(c(CUST_A, CUST_A)).toBe('match');
    expect(c(INTERNAL_SYSTEM_TENANT_ID, INTERNAL_SYSTEM_TENANT_ID)).toBe('match');
  });

  test('platform ↔ platform, different ⇒ allowed and counted (incl. EXEC and the conveyor tenant)', () => {
    expect(c(EXECUTION_TENANT_ID, INTERNAL_SYSTEM_TENANT_ID)).toBe('platform_mismatch');
    expect(c(AA_CONVEYOR_TENANT_ID, EXECUTION_TENANT_ID)).toBe('platform_mismatch');
    expect(isRefusedCardApprovalTenant('platform_mismatch')).toBe(false);
  });

  test('platform ↔ non-platform, either direction ⇒ refused', () => {
    // blocked-escalate's default-SYSTEM on a customer card:
    expect(c(INTERNAL_SYSTEM_TENANT_ID, CUST_A)).toBe('refused_cross_boundary');
    // the measured orphan-tenant rows on an EXEC stream board:
    expect(c(CUST_B, EXECUTION_TENANT_ID)).toBe('refused_cross_boundary');
  });

  test('two different non-platform tenants ⇒ refused', () => {
    expect(c(CUST_A, CUST_B)).toBe('refused_cross_customer');
  });

  test('no reference: platform ⇒ allowed (outcome-ingestion shape: tenant, no boardId)', () => {
    expect(c(INTERNAL_SYSTEM_TENANT_ID, null)).toBe('no_reference_platform');
    expect(c(AA_CONVEYOR_TENANT_ID, null)).toBe('no_reference_platform');
  });

  test("no reference: the caller's own tenant ⇒ allowed; anything else ⇒ refused", () => {
    expect(c(CUST_A, null, CUST_A)).toBe('no_reference_own');
    expect(c(CUST_A, null, CUST_B)).toBe('refused_no_reference');
    expect(c(CUST_A, null, undefined)).toBe('refused_no_reference');
  });

  test('refused ⇔ the refused_* outcomes, exactly', () => {
    for (const o of CARD_APPROVAL_TENANT_CHECK_OUTCOMES) {
      expect(isRefusedCardApprovalTenant(o)).toBe(o.startsWith('refused_'));
    }
    expect(CARD_APPROVAL_TENANT_CHECK_OUTCOMES.filter(isRefusedCardApprovalTenant)).toHaveLength(3);
  });
});

describe('fr_card_approval_tenant_check_total', () => {

  test('every outcome is pre-seeded to zero and rendered', () => {
    const lines = renderCardApprovalTenantCheckMetrics();
    for (const o of CARD_APPROVAL_TENANT_CHECK_OUTCOMES) {
      expect(lines).toContain(`fr_card_approval_tenant_check_total{outcome="${o}"} 0`);
    }
  });

});
