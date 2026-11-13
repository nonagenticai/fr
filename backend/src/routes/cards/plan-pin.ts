// U11 — GET /api/cards/:cardId/plan-pin and GET /api/cards/:cardId/plan-conformance.
//
// Both are tenant-predicated IN THE QUERY: every read of the migration-148
// tables carries `tenant_id = <active tenant>`. A card pinned under another
// tenant is therefore indistinguishable from an unpinned one — plan-pin answers
// 404 for both (never 403, which would confirm the card exists elsewhere), and
// plan-conformance answers `unproven` with empty arrays for both.
//
// plan-conformance is a THIN route over the pure computePlanConformance()
// (services/improvement-cards/plan-conformance.ts).

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { NotFoundError } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import { loadPlanLedger, loadPlanPin } from '../../services/improvement-cards/plan-pin';
import { computePlanConformance } from '../../services/improvement-cards/plan-conformance';

export async function handleGetCardPlanPin(req: Request, cardId: string): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  const pin = await loadPlanPin(cardId, tenantId);
  if (!pin) throw new NotFoundError('Plan pin not found');
  return jsonResponse(
    {
      data: {
        card_id: pin.card_id,
        plan_sha256: pin.plan_sha256,
        plan: pin.plan,
        created_at: pin.created_at,
        // The Metadata.plan_pin pointer this row backs.
        pointer: { store: 'fr', sha256: pin.plan_sha256 },
      },
    },
    200,
  );
}

export async function handleGetCardPlanConformance(req: Request, cardId: string): Promise<Response> {
  const user = await validateAuth(req);
  const tenantId = ctxTenantId(user.tenantId);
  const ledger = await loadPlanLedger(cardId, tenantId);
  return jsonResponse({ data: { card_id: cardId, ...computePlanConformance(ledger) } }, 200);
}
