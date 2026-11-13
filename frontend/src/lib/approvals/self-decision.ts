// A SELF-DECISION IS A RECORDED FACT THAT NOBODY COULD SEE.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// `backend/src/routes/approvals.ts` writes a `self_decision` object into
// `approvals.metadata` on the ONE arm where the requester of an approval is
// allowed to decide it — the arm whose refusal message says "A tenant whose
// approver roster contains nobody but the requester is exempt". The stamp
// carries `{ by, decision, roster_user_ids, required_approver_id, at }`, and the
// backend's own comment says why each field is there: `decision` because a solo
// tenant rejecting their own request and approving it are different acts, and
// `roster_user_ids` because it is the EVIDENCE for the exemption — "so a later
// reader can re-check the verdict instead of trusting it".
//
// ⛔ MEASURED on `origin/main` 2026-09-26: a grep for `self_decision` across the
// whole of `frontend/src` returned ONE hit, and it was a COMMENT inside
// `project-request/ApproverPicker.svelte` describing the backend. Zero render
// sites. So the evidence the backend deliberately preserves for "a later reader"
// reached no reader at all: every self-decided row displayed identically to one
// decided by a second party, and the only way to see the difference was to query
// the database. A control that is invisible is not a control.
//
// ── WHY A MODULE AND NOT AN INLINE `$derived` ────────────────────────────────
//
// `metadata` is `Record<string, unknown> | null` — genuinely unknown shape, from
// a producer this repo does not own, on rows written months apart. Every read
// below is defensive for that reason, and the ABSENCE cases are the ones that
// matter: a missing `exempt_reason` must render the words "reason not recorded",
// never an empty string and never a `0`, because a blank beside the word
// "Reason" reads as "there wasn't one" rather than "nobody wrote one down".
// Keeping that decision here rather than in markup is what lets it be tested
// without a DOM and reused by any surface that later needs it.

import type { Approval } from '$lib/types/api';

/**
 * The rule that permitted the self-decision.
 *
 * ⚠️ OPTIONAL BY CONSTRUCTION. The backend began writing this field after rows
 * already carried `self_decision`, so a row with the stamp and no reason is a
 * normal, expected, OLDER row — not a corrupt one. `null` here means "the row
 * does not say", and it is the caller's job to print that, not to guess.
 */
export type SelfDecisionExemptReason = 'solo_tenant_member' | 'roster_names_only_requester';

export interface SelfDecisionStamp {
  /** The user id that both raised and decided the request. */
  by: string | null;
  /** `approved` / `rejected` — recorded because they are different acts. */
  decision: string | null;
  /** The roster AS IT STOOD at decision time: the evidence for the exemption. */
  rosterUserIds: string[];
  /** The required-approver obligation the decision was recorded against. */
  requiredApproverId: string | null;
  at: string | null;
  /** The named rule, or `null` on a row written before the field existed. */
  exemptReason: SelfDecisionExemptReason | null;
  /**
   * WHICH RULE PERMITTED IT, in words, ALWAYS non-empty.
   *
   * ⛔ There is no branch of this that returns `''`. An unrecorded reason gets
   * the sentence that SAYS it is unrecorded; that is the whole point of the
   * field existing on this type rather than being computed in a template, where
   * `{stamp.exemptReason ?? ''}` is one keystroke away and renders a blank.
   */
  ruleSentence: string;
  /** False when the row predates `exempt_reason`. Drives the "not recorded" tone. */
  reasonRecorded: boolean;
}

const REASON_SENTENCES: Record<SelfDecisionExemptReason, string> = {
  // Mirrors the wording the solo-tenant approver control uses, and George's rule
  // verbatim: one member means that member is the default god of that tenant.
  solo_tenant_member:
    'This workspace has one member, so that member is its own approver — there is no second party this request could have been routed to.',
  // The backend's own predicate: `allRequiredApprovers.every(ra => ra.user_id === requester_id)`.
  roster_names_only_requester:
    'Every required approver on this request named the requester and nobody else, so there was no second party this request could have been routed to.',
};

/**
 * The sentence for a row that carries the stamp but not the rule.
 *
 * ⚠️ It states the absence and stops. It must NOT guess "probably a solo
 * tenant": the two reasons are different facts, the evidence for distinguishing
 * them (`rosterUserIds`) is right there for a reader to check, and an auditor
 * told the wrong rule is worse off than one told no rule.
 */
const REASON_NOT_RECORDED =
  'Reason not recorded — this decision predates the field that names the permitting rule. The roster below is the evidence it was recorded against.';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function reasonOf(v: unknown): SelfDecisionExemptReason | null {
  // ⚠️ Whitelisted, not cast. An unrecognised string is treated exactly like an
  // absent one: this surface may only ever print a rule it can actually state.
  return v === 'solo_tenant_member' || v === 'roster_names_only_requester' ? v : null;
}

/**
 * Read the stamp off a row, or `null` when the row has none.
 *
 * ⛔ `null` means "this row was NOT self-decided", and every caller renders
 * nothing for it. It never means "we could not tell": a row whose `metadata` is
 * absent, null, or not an object simply has no stamp, which is the same fact.
 */
export function selfDecisionStamp(
  approval: Pick<Approval, 'metadata'> | null | undefined,
): SelfDecisionStamp | null {
  const metadata = approval?.metadata;
  if (metadata == null || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).self_decision;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const exemptReason = reasonOf(row.exempt_reason);
  return {
    by: str(row.by),
    decision: str(row.decision),
    rosterUserIds: Array.isArray(row.roster_user_ids)
      ? row.roster_user_ids.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      : [],
    requiredApproverId: str(row.required_approver_id),
    at: str(row.at),
    exemptReason,
    ruleSentence: exemptReason ? REASON_SENTENCES[exemptReason] : REASON_NOT_RECORDED,
    reasonRecorded: exemptReason !== null,
  };
}

/**
 * The headline. Names the ACT, because `decision` is recorded precisely so an
 * auditor can tell an approve from a reject without opening the database.
 */
export function selfDecisionHeadline(stamp: SelfDecisionStamp): string {
  if (stamp.decision === 'approved') return 'The requester approved their own request.';
  if (stamp.decision === 'rejected') return 'The requester rejected their own request.';
  // The stamp exists, so a self-decision happened; the verb is what is missing.
  return 'The requester decided their own request.';
}
