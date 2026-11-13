// src/routes/approval-void.ts
//
// POST /api/approvals/void — ADMIN ONLY.
//
// Voids a named set of approvals. Voiding means "this ask was never
// answerable; withdraw it" — it is explicitly NOT a decision. The only
// deciding path remains PUT /api/approvals/:approvalId
// (routes/approvals.ts :: handleUpdateApproval); this route must never be
// able to set status='approved'/'rejected', write an `approval_decisions`
// row, or otherwise look like a human answered the question. It can only
// remove an unanswerable question from the queue, with a mandatory
// recorded reason.
//
// ── This route is now a THIN SHELL ─────────────────────────────────────────
// The transaction, the zod schema and every safety property listed below live
// in `lib/void-approvals.ts`, shared with the in-cluster CLI
// (src/scripts/void-approvals.ts). This file contributes exactly two things
// the CLI does not need: the authorization gate, and the JSON response shape.
// The safety properties are NOT restated as code here on purpose — one
// implementation means the two callers cannot drift apart, and a drift in a
// void path is only ever discovered after a bad write.
//
// SAFETY PROPERTIES (all deliberate; enforced in lib/void-approvals.ts):
//   - `dryRun` DEFAULTS TO TRUE. A caller that forgets the flag gets a
//     report, never a write. This is the single most important property.
//   - Ids only, never a filter. A filter-driven mass void ("all pending
//     with no rationale") is exactly the unaudited-blast-radius failure a
//     named-ids-only route replaces — do not widen this to accept a query.
//   - `reason` is mandatory (>=10 chars) — a void with no recorded reason
//     is an unaudited write.
//   - Only rows currently `status='pending'` may be voided. Every id in the
//     request gets a reported outcome — never a silent drop.
//   - The whole batch runs in ONE transaction: a partial void cannot
//     happen.
//
// The one property that is enforced HERE, because it is HTTP-specific:
//   - Gated on the `super_admin` Keycloak realm role (`isSuperAdmin`), the
//     strongest admin authorization this repo has
//     (backend/src/lib/super-admin-gate.ts) — the same gate
//     routes/admin/super-admin.ts uses to provision/deprovision a person.
//     Ordinary required-approver roster membership (the bar
//     handleUpdateApproval / handleTriageApproval use) is deliberately NOT
//     enough here: voiding destroys a pending ask outright, for approvals
//     that may belong to rosters this caller was never on.
//     ⚠️ The sibling CLI does NOT weaken this gate — it is not reachable over
//     the network at all; running it requires shell access to the pod, which
//     is a strictly stronger bar than holding a bearer token.
//
// ⛔ NO AUDIT ROW IN `approval_decisions`. That table is the per-approver
// DECISION ledger — every row there answers "did a rostered approver
// approve or reject", and handleUpdateApproval's quorum math treats its
// mere presence as progress toward completion. Inserting a void row there
// would make an admin's withdrawal LOOK LIKE a decision to every reader of
// that table (the quorum tally, the GET decisions list, the n8n callback
// payload builder). The audit trail for a void lives on the `approvals`
// row itself instead — `voided_at` / `voided_reason` / `voided_by`
// (migration 110) — the same place `completed_at` and the `expired`
// transition already record every OTHER terminal, non-decision outcome
// (workers/approval-expiry.ts).
import { validateAuth } from '../middleware/auth';
import { isSuperAdmin } from '../lib/super-admin-gate';
import {
  VoidApprovalsSchema,
  voidApprovals,
  emptyVoidCounts,
} from '../lib/void-approvals';
import { ForbiddenError } from '../utils/errors';
import { assertNotLicenceDecider } from '../lib/licence-door';
import { jsonResponse } from '../utils/response';

/**
 * POST /api/approvals/void
 *
 * Body: `{ ids: string[] (1..500, uuid), reason: string (>=10 chars), dryRun?: boolean (default true) }`.
 */
export async function handleVoidApprovals(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  // Minting ≠ deciding: a licence caller never voids (lib/licence-door.ts). Before the
  // super-admin gate so the refusal does not depend on a licence never carrying roles.
  assertNotLicenceDecider(user);

  if (!isSuperAdmin(user)) {
    throw new ForbiddenError('super-admin only');
  }

  const body = await req.json();
  const validated = VoidApprovalsSchema.parse(body);

  const outcomeById = await voidApprovals({
    ids: validated.ids,
    reason: validated.reason,
    dryRun: validated.dryRun,
    // `voided_by` is free-text (migration 110), so the authenticated user id
    // goes straight through — no user record and no FK is involved.
    actor: user.id,
    // fr row 14d: a super-admin voids PLATFORM-tenant rows only; a customer
    // row reports `not_found` and is never written.
    platformOnly: true,
  });

  // Re-expand over the ORIGINAL (possibly duplicate) request list — every id
  // the caller sent gets a reported outcome, including repeats.
  const results = validated.ids.map((id) => ({
    id,
    outcome: outcomeById.get(id)!,
  }));

  const counts = emptyVoidCounts();
  for (const r of results) counts[r.outcome] += 1;

  return jsonResponse({
    dryRun: validated.dryRun,
    reason: validated.reason,
    results,
    counts,
  });
}
