// src/routes/approval-bug-fix-for-card.ts
//
// GET /api/approvals/bug-fix-for-card/:bugCardId?tenant_id=<uuid>[&include_closed=true] — U3. THE way ncn finds
// the bug-fix authorization for a BUG card. fr writes nothing onto the bug card (no Planka
// Metadata stamp): the approvals row is the only record, and migration 153's partial UNIQUE
// index guarantees there is at most one per (tenant, bug card) whose status is neither voided
// nor expired. The lookup uses the same predicate, newest first by (created_at, id).
//
// ⛔ LICENCE DOOR ONLY (G4, George 2026-10-10 — lib/licence-door.ts `licenceOnly`): the shared
// X-Webhook-Secret door that used to front this route is REMOVED. There is NO Keycloak-JWT
// lane, so an end user cannot reach it. The tenant is still NAMED by the caller (`tenant_id`,
// required), and must be the licence's own.
//
// ⛔ TENANT-PREDICATED: the row is read with `approvals.tenant_id = tenant_id`. Another
// tenant's bug card is 404 — the same answer as no approval at all, so it never leaks.
//
// include_closed (L5 M12 — how a hunt finds the ONE approval it raised, since
// that approval is not a card field): absent or 'false' ⇒ the default below, byte-for-byte;
// 'true' ⇒ the LATEST marked row in ANY status, same tenant predicate, same (created_at, id)
// DESC order, same shape — so "never raised" (404) is distinguishable from "raised and closed".
// Any other value is 400, never silently the default (fail closed).
//
//   200 { data: { id, status, report_id, report_hash, decided_at } }
//         default: status ∈ pending | approved | rejected. Voided and EXPIRED rows are never
//         returned: an expired authorization's card goes back to TODO to be re-raised, so the
//         answer is 404 until the re-raise mints the new row, which is then returned. (status
//         is the stored column; a pending row past expires_at reads pending until the worker
//         runs.)
//         include_closed=true: status ∈ pending | approved | rejected | expired | voided — the
//         newest marked row; 404 ONLY when no marked row ever existed for this card+tenant.
//         decided_at = approvals.completed_at (ISO-8601) or null while pending.
//   400 tenant_id_invalid       tenant_id missing / not a uuid
//   400 include_closed_invalid  include_closed present and neither 'true' nor 'false'
//   401                         no licence token, or a licence token refused (an X-Webhook-Secret
//                               header is ignored — the secret door is gone)
//
// TENANT BINDING (lib/licence-door.ts): a licence caller may read ONLY its own
// tenant — `tenant_id` must be the licence's tenant, else the SAME 404 as no approval at all
// (this route's not-yours convention; no cross-tenant existence oracle).
//   404 bug_fix_approval_not_found

import { licenceOnly, sameTenant } from '../lib/licence-door';
import { isUuidShape } from '../lib/uuid-shape';
import { BadRequestError, NotFoundError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { findBugFixApprovalForCard } from '../services/approvals/bug-fix-uniqueness';

export const BUG_FIX_APPROVAL_NOT_FOUND = 'bug_fix_approval_not_found' as const;
export const INCLUDE_CLOSED_INVALID = 'include_closed_invalid' as const;

/** Planka card ids are numeric strings today; bound the input rather than trust its shape. */
const MAX_CARD_ID_LENGTH = 128;

export async function handleGetBugFixApprovalForCard(req: Request, bugCardId: string): Promise<Response> {
  const door = await licenceOnly(req);

  const params = new URL(req.url).searchParams;
  const tenantId = params.get('tenant_id')?.trim() ?? '';
  if (!isUuidShape(tenantId)) {
    throw new BadRequestError('tenant_id query parameter (uuid) is required').withCode('tenant_id_invalid');
  }
  if (!sameTenant(tenantId, door.tenantId)) {
    throw new NotFoundError('No bug-fix authorization for this bug card').withCode(BUG_FIX_APPROVAL_NOT_FOUND);
  }
  // Strict: exactly 'true' / 'false' (or absent). Anything else fails closed.
  const includeClosedRaw = params.get('include_closed');
  if (includeClosedRaw !== null && includeClosedRaw !== 'true' && includeClosedRaw !== 'false') {
    throw new BadRequestError("include_closed must be 'true' or 'false'").withCode(INCLUDE_CLOSED_INVALID);
  }
  const includeClosed = includeClosedRaw === 'true';
  const cardId = (bugCardId ?? '').trim();
  const notFound = () =>
    new NotFoundError('No bug-fix authorization for this bug card').withCode(BUG_FIX_APPROVAL_NOT_FOUND);
  if (cardId.length === 0 || cardId.length > MAX_CARD_ID_LENGTH) throw notFound();

  const row = includeClosed
    ? await findBugFixApprovalForCard(tenantId, cardId, undefined, { includeClosed: true })
    : await findBugFixApprovalForCard(tenantId, cardId);
  if (!row) throw notFound();

  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return jsonResponse({
    data: {
      id: row.id,
      status: row.status,
      report_id: typeof meta.report_id === 'string' ? meta.report_id : null,
      report_hash: typeof meta.report_hash === 'string' ? meta.report_hash : null,
      decided_at: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    },
  });
}
