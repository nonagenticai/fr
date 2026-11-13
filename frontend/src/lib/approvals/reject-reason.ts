// The ONE rule every decide surface must agree on about REJECTING an approval.
//
// ⛔ THE SERVER REQUIRES `reason` ON A REJECTION, AND THE ZOD SCHEMA DOES NOT SAY SO.
// `UpdateApprovalSchema` (`backend/src/routes/approvals.ts:437-441`) declares both
// `comment` and `reason` `.optional()`, so a reader who stops at the schema concludes
// a rejection needs nothing. The real gate is the imperative check AFTER the parse:
//
//   backend/src/routes/approvals.ts:1733-1735
//     // If rejecting, require a reason
//     if (validated.status === 'rejected' && !validated.reason) {
//       throw new ValidationError('A reason is required when rejecting');
//     }
//
// It reads `reason` ONLY — a rejection carrying a fully written `comment` and no
// `reason` is refused exactly as hard as an empty one. The nearby essays that say
// "`rejected` is NEVER blocked" (`:169`, and again above the #1064 broken-gate guard)
// are TRUE and about DIFFERENT guards: the answerless-approve guard and the
// broken-gate guard are both scoped to `approved`, and the broken-gate comment even
// says it sits "AFTER the reject-reason check". Neither exempts a rejection from this
// one.
//
// ⭐ AND THE MAIN SURFACE DOES NOT MAKE THE HUMAN SATISFY IT. `DecisionBar`'s Reject
// button is `disabled={busy}` and nothing else — no comment gate, in either layout —
// because a rejection is a legitimate terminal for a row nobody can answer, and a UI
// that demands prose before it will let you say "no" is how a queue becomes
// unclearable. The CLIENT closes the gap instead: `recordDecision`
// (`routes/approvals/[id]/page-helpers.ts`) sends `{ reason: text || DEFAULT_REJECT_REASON }`.
//
// So the contract is: never block the gesture, always send a reason. Both halves are
// load-bearing and a surface that implements one without the other is broken in a way
// the other surfaces are not — which is precisely how the two improvement lenses
// drifted apart (one refused the click the server would have accepted; the other
// accepted the click and sent a payload the server refuses 100% of the time).

/**
 * What the client sends as `reason` when the decider typed nothing.
 *
 * ⚠️ MATCHED CONSTANT. Changing this string changes what four existing tests observe
 * on the main surface; it is shared rather than re-typed so a lens can never quietly
 * grow a different default.
 */
export const DEFAULT_REJECT_REASON = 'Rejected.';

/**
 * The `reason` to send for a rejection, given whatever the decider typed.
 *
 * ⛔ NEVER RETURNS EMPTY. That is the whole job: the server refuses a rejection with
 * no `reason`, so returning '' here would only move the refusal from the button to a
 * 422 the operator has to decode (`ValidationError` is 422 —
 * `backend/src/utils/errors.ts:78-83`).
 */
export function rejectReason(text: string | null | undefined): string {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed.length > 0 ? trimmed : DEFAULT_REJECT_REASON;
}
