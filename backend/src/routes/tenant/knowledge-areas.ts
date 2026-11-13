// routes/tenant/knowledge-areas.ts
//
// THE VOCABULARY, SERVED. `GET /api/tenant/knowledge-areas`.
//
// The caller tenant's knowledge areas = its requirements_management capabilities
// (design: fr consumes RM vocabulary, Q1 = a), each with its title and the
// tenant's card types in it, read through the one reader
// (services/catalogue/tenant-catalogue.ts). A picker that fetches its own
// vocabulary cannot go stale, and a tenant that adds a capability in RM sees it
// here with no fr change. An uninitialised tenant is 409
// `catalogue_not_initialised` — never an empty list.
//
// ── AUTHZ ───────────────────────────────────────────────────────────────────
// `validateAuth` only — any authenticated caller, reading ITS OWN tenant's
// vocabulary (the request tenant). It contains no member data.

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { knowledgeAreaEntriesOf, type KnowledgeAreaEntry } from '../../lib/knowledge-areas';

export type { KnowledgeAreaEntry } from '../../lib/knowledge-areas';

/**
 * ⚠️ `{ items }`, one of the four shapes fr's response-envelope convention
 * sanctions for a NEW route. No `total`: it would be `items.length` restated.
 */
export interface KnowledgeAreasResponse {
  items: KnowledgeAreaEntry[];
}

/** GET /api/tenant/knowledge-areas */
export async function handleListKnowledgeAreas(req: Request): Promise<Response> {
  let tenantId: string;
  try {
    tenantId = ctxTenantId((await validateAuth(req)).tenantId);
  } catch {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  // ⚠️ A BARE `{ items: ... }` LITERAL, with no `satisfies` clause (the envelope
  // scanner cannot parse one).
  const items: KnowledgeAreaEntry[] = await knowledgeAreaEntriesOf(tenantId);
  return jsonResponse({ items });
}
