// src/lib/card-approval-tenant-check.ts
//
// fr row 14d-2 — tag consistency for POST /api/webhooks/n8n/card-approval.
//
// THE DEFECT. `resolveCardApprovalTenant` (routes/webhooks.ts) returns an
// EXPLICIT body `tenant_id` verbatim, so the n8n caller decides which tenant an
// approval is filed under even when the card's project (or board) belongs to a
// different one. MEASURED (M-14d-2 §4): 8 approvals were filed under an orphan
// non-platform tenant on an EXEC stream board, and blocked-escalate always sends
// an explicit tenant (falling back to SYSTEM via AA_DEFAULT_TENANT_ID), so a
// customer card whose envelope lacked tenant_id would be filed under SYSTEM.
//
// THE RULE (movies-13, approved 2026-10-04). Compare the explicit tenant with
// the REFERENCE tenant — the project's tag `project_data->>'keycloak_tenant_id'`,
// else (no project / untagged project) the board's tenant:
//   * equal                                       → allow (`match`)
//   * both PLATFORM, different                    → allow AND count (`platform_mismatch`)
//   * platform ↔ non-platform                     → 4xx (`refused_cross_boundary`)
//   * two different non-platform tenants          → 4xx (`refused_cross_customer`)
//   * no reference at all (no project, no board tenant): the explicit tenant must
//     be PLATFORM (`no_reference_platform`) or the caller's own
//     (`no_reference_own`); otherwise 4xx (`refused_no_reference`).
// outcome-ingestion sends a tenant and NO boardId, so its platform tenant lands
// on `no_reference_platform` and keeps working.
//
// Counter shape copied from lib/active-tenant-header-metrics.ts: closed label
// set, pre-seeded to zero, increment-only, render for routes/metrics.ts,
// `__*ForTests` accessors. No tenant/card label ever (unbounded) — those ride
// in the log line.

import { isPlatformTenant } from '../middleware/internal-tenant-only';

export const CARD_APPROVAL_TENANT_CHECK_OUTCOMES = [
  'match',
  'platform_mismatch',
  'no_reference_platform',
  'no_reference_own',
  'refused_cross_boundary',
  'refused_cross_customer',
  'refused_no_reference',
] as const;
export type CardApprovalTenantCheckOutcome = (typeof CARD_APPROVAL_TENANT_CHECK_OUTCOMES)[number];

/** Pure: the decision. `refused_*` ⇔ the caller must answer 4xx. */
export function classifyCardApprovalTenant(args: {
  explicitTenant: string;
  referenceTenant: string | null;
  callerTenant: string | null | undefined;
}): CardApprovalTenantCheckOutcome {
  const { explicitTenant, referenceTenant, callerTenant } = args;
  if (!referenceTenant) {
    if (isPlatformTenant(explicitTenant)) return 'no_reference_platform';
    if (callerTenant && explicitTenant === callerTenant) return 'no_reference_own';
    return 'refused_no_reference';
  }
  if (explicitTenant === referenceTenant) return 'match';
  const ep = isPlatformTenant(explicitTenant);
  const rp = isPlatformTenant(referenceTenant);
  if (ep && rp) return 'platform_mismatch';
  if (ep !== rp) return 'refused_cross_boundary';
  return 'refused_cross_customer';
}

export function isRefusedCardApprovalTenant(o: CardApprovalTenantCheckOutcome): boolean {
  return o.startsWith('refused_');
}

const outcomesTotal = new Map<CardApprovalTenantCheckOutcome, number>(
  CARD_APPROVAL_TENANT_CHECK_OUTCOMES.map((o) => [o, 0]),
);

/** Count one decision; log the non-`match` ones. Never throws. */
export function recordCardApprovalTenantCheck(args: {
  outcome: CardApprovalTenantCheckOutcome;
  explicitTenant: string;
  referenceTenant: string | null;
  referenceSource: 'project_tag' | 'board' | 'none';
  cardId: string;
}): void {
  outcomesTotal.set(args.outcome, (outcomesTotal.get(args.outcome) ?? 0) + 1);
  if (args.outcome === 'match') return;
  try {
    console.warn(
      '[card-approval-tenant-check]',
      JSON.stringify({
        event: 'card_approval_tenant_check',
        outcome: args.outcome,
        explicit_tenant_id: args.explicitTenant,
        reference_tenant_id: args.referenceTenant,
        reference_source: args.referenceSource,
        card_id: args.cardId,
      }),
    );
  } catch {
    /* telemetry must never change the verdict */
  }
}

export function renderCardApprovalTenantCheckMetrics(): string[] {
  const lines: string[] = [
    '# HELP fr_card_approval_tenant_check_total POST /api/webhooks/n8n/card-approval requests carrying an explicit tenant_id, by how it compared with the project tag / board tenant (fr row 14d-2). refused_* are answered 422 card_approval_tenant_mismatch; platform_mismatch is allowed and counted.',
    '# TYPE fr_card_approval_tenant_check_total counter',
  ];
  for (const o of CARD_APPROVAL_TENANT_CHECK_OUTCOMES) {
    lines.push(`fr_card_approval_tenant_check_total{outcome="${o}"} ${outcomesTotal.get(o) ?? 0}`);
  }
  return lines;
}

