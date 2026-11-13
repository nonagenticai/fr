// GET /api/conveyor/taxonomy[?template=] — fr#1477 (design §3 "A, Conveyor map").
//
// Read-only catalogue of the CALLER TENANT's RM PM catalogue: its phases, its
// capabilities and every card type's (capability, phase, group) — see
// services/conveyor/taxonomy.ts. Any authenticated caller, reading its own
// tenant (409 catalogue_not_initialised when it has none). `?template=`:
// template reads are platform-only
// (`canReadConveyorTemplates`), and fr has no templates yet, so a permitted read
// answers 404 `template_not_found`.

import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { jsonResponse } from '../utils/response';
import { authErrorToResponse } from './card-types';
import {
  buildConveyorTaxonomy,
  canReadConveyorTemplates,
  loadTaxonomyCatalogue,
} from '../services/conveyor/taxonomy';

export async function handleGetConveyorTaxonomy(req: Request): Promise<Response> {
  let user: Awaited<ReturnType<typeof validateAuth>>;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }

  const tenantId = ctxTenantId(user.tenantId);
  const template = new URL(req.url).searchParams.get('template');
  if (template !== null) {
    if (!canReadConveyorTemplates(tenantId)) {
      return jsonResponse({ error: 'template_read_forbidden' }, 403);
    }
    return jsonResponse({ error: 'template_not_found', template }, 404);
  }

  // The tenant's RM catalogue (409 catalogue_not_initialised when it has none).
  const catalogue = await loadTaxonomyCatalogue(tenantId);
  return jsonResponse({ data: buildConveyorTaxonomy(catalogue) });
}
