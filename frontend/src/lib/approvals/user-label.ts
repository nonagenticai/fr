/**
 * Display label for a user id that appears on an approval (UI review
 * 2026-10-07: the detail page printed raw ids for the roster and for
 * "Withdrawn by").
 *
 * NO NEW LOOKUP. `GET /api/approvals/:id` already hydrates identities for the
 * roster (`required_approvers[].name/email`), the decisions
 * (`approver_name/email`) and the requester (`requester_name/email`) — the same
 * enrichment the /approvals list renders through `displayName(name,
 * displayName(email, id))`. This only reads those back for an id, with the same
 * precedence and the same honest fallback: the untruncated id when nothing
 * resolves (an 8-char prefix looks like a username).
 *
 * `voided_by` is free text in practice (a script or operator tag, not always a
 * uuid), so a non-uuid value is returned as-is.
 */
import { displayName } from '$lib/utils/displayName';
import type { Approval } from '$lib/types/api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Identity = { name?: string | null; email?: string | null };

export function approvalUserLabel(approval: Approval, id: string | null | undefined): string {
  const raw = typeof id === 'string' ? id.trim() : '';
  if (!raw) return '';
  if (!UUID_RE.test(raw)) return raw;

  const pick = (who: Identity | undefined): string =>
    who ? displayName(who.name, displayName(who.email, '')) : '';

  const roster = (approval.required_approvers ?? []) as Array<{ user_id: string } & Identity>;
  const fromRoster = pick(roster.find((r) => r.user_id === raw));
  if (fromRoster) return fromRoster;

  const decision = (approval.decisions ?? []).find((d) => d.approver_id === raw);
  const fromDecision = decision
    ? pick({ name: decision.approver_name, email: decision.approver_email })
    : '';
  if (fromDecision) return fromDecision;

  // The voider is hydrated server-side (`voided_by_name`) — it is usually in no
  // roster, decision or requester slot (fr review round 3: the oversight account).
  const voidedBy = (approval as Approval & { voided_by?: string | null }).voided_by;
  if (voidedBy?.trim() === raw && approval.voided_by_name) return approval.voided_by_name;

  if (approval.requester_id === raw) {
    const fromRequester = pick({ name: approval.requester_name, email: approval.requester_email });
    if (fromRequester) return fromRequester;
  }
  return raw;
}
