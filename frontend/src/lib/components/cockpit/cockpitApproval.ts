// cockpitApproval.ts
// =================
// Bridge between the cockpit read-model approval shape (CockpitApproval, which
// is faithful to the backend — `role: string | null`, `decisions[].decision:
// string`) and the shared authorization rule in $lib/approvals/canAct. Rather
// than duplicate the "required approver who hasn't decided yet" logic, we adapt
// the cockpit type onto the `Approval` sub-shape canActOnApproval reads. Pure —
// unit-tested.

import { canActOnApproval, type ApproverIdentity } from '$lib/approvals/canAct';
import type { RequiredApprover, ApprovalDecisionDetail, ApprovalDecision } from '$lib/types/api';
import type { CockpitApproval } from '$lib/types/cockpit';

function toApproverGate(a: CockpitApproval): {
  required_approvers: RequiredApprover[];
  decisions: ApprovalDecisionDetail[];
  requester_id?: string | null;
  tenant_id?: string | null;
  source?: string | null;
  action_id?: string | null;
  metadata?: unknown;
} {
  return {
    // The decide rule's tenant-member arm and requester guard read these (the read model now
    // carries them, so the cockpit no longer hydrates rows with a second approvals.list call).
    requester_id: a.requester_id ?? null,
    tenant_id: a.tenant_id ?? null,
    source: a.source ?? null,
    action_id: a.action_id ?? null,
    metadata: a.metadata ?? null,
    required_approvers: a.required_approvers.map((r) => ({
      user_id: r.user_id,
      role: r.role ?? undefined,
    })),
    decisions: a.decisions.map((d) => ({
      approver_id: d.approver_id,
      decision: d.decision as ApprovalDecision,
      decided_at: d.decided_at ?? '',
    })),
  };
}

/** True iff `user` may still Approve/Reject this cockpit approval. */
export function cockpitApprovalActable(
  a: CockpitApproval,
  user: ApproverIdentity | null | undefined,
): boolean {
  return canActOnApproval(toApproverGate(a), user);
}

/** The subset of cockpit approvals that are still open (awaiting a decision). */
export function pendingApprovals(approvals: CockpitApproval[]): CockpitApproval[] {
  return approvals.filter((a) => a.status === 'pending');
}
