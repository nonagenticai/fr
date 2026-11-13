// /api/conveyor/catalogue/* — proxy over requirements_management's tenant PM
// catalogue (`integrations/pm-catalogue.ts`, the single seam).
//
//   GET    /api/conveyor/catalogue/:resource                   list (limit/offset + filters)
//   POST   /api/conveyor/catalogue/:resource                   create      (tenant admin)
//   GET    /api/conveyor/catalogue/:resource/:id               get
//   PUT    /api/conveyor/catalogue/:resource/:id               update      (tenant admin)
//   DELETE /api/conveyor/catalogue/:resource/:id               delete      (tenant admin)
//   GET    /api/conveyor/catalogue/project-types/:id/card-types  matrix
//   PUT    /api/conveyor/catalogue/project-types/:id/card-types  matrix set (tenant admin)
//   GET    /api/conveyor/catalogue/wip-limits/resolve            effective WIP limit
//   POST   /api/conveyor/catalogue/import-defaults               seed      (tenant admin)
//
// ⛔ FACILITATOR, NOT JUDGE. fr authenticates, picks the tenant, gates writes on
// tenant-admin, and refuses resource names outside the allowlist (404, RM never
// called). It does NOT validate bodies or filters: RM does, and RM's 4xx comes
// back through `integrationErrorResponse` with its status and caller-safe body.
//
// Reads: any authenticated caller, scoped to their request tenant (the same
// guard as `/api/conveyor/taxonomy`). Writes: workspace admin of that tenant via
// the canonical `isWorkspaceAdminVia` (realm `tenant_admin` pinned to the raw
// `tenant_id` claim, or a `workspace-admin` grant) — never a raw claim check
// (scripts/check-admin-claim-only.ts).

import { CardTypeInDefinitionOfDone } from '@fr/service-client-requirements';
import { projectTypeCreatableOn } from '../lib/project-type-tenant';
import { validateAuth } from '../middleware/auth';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { isUuidShape } from '../lib/uuid-shape';
import { ctxTenantId } from '../middleware/request-context';
import { jsonResponse } from '../utils/response';
import { authErrorToResponse } from './card-types';
import { integrationErrorResponse, isIntegrationError } from '../integrations/_lib/errors';
import { userRolesService } from '../services/user-roles';
import {
  createPmCatalogueItem,
  deletePmCatalogueItem,
  getPmCatalogueItem,
  getProjectTypeCardTypes,
  importPmCatalogueDefaults,
  isPmCatalogueResource,
  listPmCatalogue,
  PM_CATALOGUE_RESOURCES,
  resolvePmWipLimit,
  setProjectTypeCardTypes,
  updatePmCatalogueItem,
  type PmCatalogueResource,
} from '../integrations/pm-catalogue';
import {
  invalidateTenantCatalogue,
  priorities as cataloguePriorities,
  isStartableProjectType,
  projectTypes as catalogueProjectTypes,
} from '../services/catalogue/tenant-catalogue';

type Caller = { user: Awaited<ReturnType<typeof validateAuth>>; tenantId: string };

async function authenticate(req: Request): Promise<Caller | Response> {
  let user: Awaited<ReturnType<typeof validateAuth>>;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }
  return { user, tenantId: ctxTenantId(user.tenantId) };
}

/** 403 unless the caller is a workspace admin (tenant_admin) of their request tenant. */
async function adminRefusal(caller: Caller): Promise<Response | null> {
  if (await userRolesService.isWorkspaceAdminVia(caller.user, caller.tenantId, userRolesService.hasRole)) {
    return null;
  }
  return jsonResponse({ error: 'tenant_admin_required' }, 403);
}

function unknownResource(resource: string): Response {
  return jsonResponse(
    { error: 'unknown_catalogue_resource', resource, allowed: PM_CATALOGUE_RESOURCES },
    404,
  );
}

/** The request body forwarded as-is; an empty body is `undefined`. */
async function readBody(req: Request): Promise<{ body: unknown } | Response> {
  const text = await req.text();
  if (text.trim() === '') return { body: undefined };
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
}

/**
 * Call RM. Its non-2xx (status + caller-safe body) comes back as the Response
 * to return; everything that is not an IntegrationError is rethrown.
 */
async function upstream(call: () => Promise<unknown>): Promise<{ value: unknown } | Response> {
  try {
    return { value: await call() };
  } catch (err) {
    if (isIntegrationError(err)) return integrationErrorResponse(err);
    throw err;
  }
}

/**
 * A WRITE to RM. Same as `upstream`, and then — whatever the outcome — drops
 * the tenant's cached catalogue (services/catalogue/tenant-catalogue.ts), so the
 * next read of that tenant sees the write. Invalidated on failure too: a
 * timed-out write may still have landed in RM.
 */
async function upstreamWrite(tenantId: string, call: () => Promise<unknown>): Promise<{ value: unknown } | Response> {
  try {
    return await upstream(call);
  } finally {
    invalidateTenantCatalogue(tenantId);
  }
}

function resourceOr404(resource: string): PmCatalogueResource | Response {
  return isPmCatalogueResource(resource) ? resource : unknownResource(resource);
}

/**
 * The catalogue's closed vocabularies, from the REGENERATED RM client (never a
 * fr copy): today the card-type `definition_of_done` values (rm#212 added
 * `asset_persisted`). A value RM adds reaches the editor with the next client
 * regen, not a hand-edited list.
 */
const CATALOGUE_ENUMS = Object.freeze({
  definition_of_done: Object.freeze(Object.values(CardTypeInDefinitionOfDone)) as readonly string[],
});

/** GET /api/conveyor/catalogue/enums → `{ data: { definition_of_done: string[] } }`. */
export async function handleGetCatalogueEnums(req: Request): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  return jsonResponse({ data: { definition_of_done: [...CATALOGUE_ENUMS.definition_of_done] } });
}

export async function handleListCatalogue(req: Request, resource: string): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const r = resourceOr404(resource);
  if (r instanceof Response) return r;
  const params = new URL(req.url).searchParams;
  const out = await upstream(() => listPmCatalogue(caller.tenantId, r, params));
  if (out instanceof Response) return out;
  return jsonResponse({ data: out.value });
}

export async function handleGetCatalogueItem(
  req: Request,
  resource: string,
  id: string,
): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const r = resourceOr404(resource);
  if (r instanceof Response) return r;
  const out = await upstream(() => getPmCatalogueItem(caller.tenantId, r, id));
  if (out instanceof Response) return out;
  return jsonResponse({ data: out.value });
}

export async function handleCreateCatalogueItem(req: Request, resource: string): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const r = resourceOr404(resource);
  if (r instanceof Response) return r;
  const refused = await adminRefusal(caller);
  if (refused) return refused;
  const parsed = await readBody(req);
  if (parsed instanceof Response) return parsed;
  const out = await upstreamWrite(caller.tenantId, () => createPmCatalogueItem(caller.tenantId, r, parsed.body));
  if (out instanceof Response) return out;
  return jsonResponse({ data: out.value });
}

export async function handleUpdateCatalogueItem(
  req: Request,
  resource: string,
  id: string,
): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const r = resourceOr404(resource);
  if (r instanceof Response) return r;
  const refused = await adminRefusal(caller);
  if (refused) return refused;
  const parsed = await readBody(req);
  if (parsed instanceof Response) return parsed;
  const out = await upstreamWrite(caller.tenantId, () => updatePmCatalogueItem(caller.tenantId, r, id, parsed.body));
  if (out instanceof Response) return out;
  return jsonResponse({ data: out.value });
}

export async function handleDeleteCatalogueItem(
  req: Request,
  resource: string,
  id: string,
): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const r = resourceOr404(resource);
  if (r instanceof Response) return r;
  const refused = await adminRefusal(caller);
  if (refused) return refused;
  const out = await upstreamWrite(caller.tenantId, () => deletePmCatalogueItem(caller.tenantId, r, id));
  if (out instanceof Response) return out;
  return jsonResponse({ data: out.value });
}

export async function handleGetProjectTypeCardTypes(req: Request, id: string): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const out = await upstream(() => getProjectTypeCardTypes(caller.tenantId, id));
  if (out instanceof Response) return out;
  return jsonResponse({ data: out.value });
}

export async function handleSetProjectTypeCardTypes(req: Request, id: string): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const refused = await adminRefusal(caller);
  if (refused) return refused;
  const parsed = await readBody(req);
  if (parsed instanceof Response) return parsed;
  const out = await upstreamWrite(caller.tenantId, () => setProjectTypeCardTypes(caller.tenantId, id, parsed.body));
  if (out instanceof Response) return out;
  return jsonResponse({ data: out.value });
}

export async function handleImportCatalogueDefaults(req: Request): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const refused = await adminRefusal(caller);
  if (refused) return refused;
  const parsed = await readBody(req);
  if (parsed instanceof Response) return parsed;
  const out = await upstreamWrite(caller.tenantId, () => importPmCatalogueDefaults(caller.tenantId, parsed.body));
  if (out instanceof Response) return out;
  return jsonResponse({ data: out.value });
}

export async function handleResolveWipLimit(req: Request): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const params = new URL(req.url).searchParams;
  const out = await upstream(() => resolvePmWipLimit(caller.tenantId, params));
  if (out instanceof Response) return out;
  return jsonResponse({ data: out.value });
}

/**
 * POST /api/admin/tenants/:tenantId/catalogue/import-defaults — SUPER-ADMIN ONLY.
 *
 * Seeds the NAMED tenant's PM catalogue from RM's defaults (idempotent by name;
 * never overwrites — RM's contract). This is the remedy the UI offers for a
 * `catalogue_not_initialised` tenant (services/catalogue/tenant-catalogue.ts),
 * and the same call tenant provisioning makes. The tenant is the PATH tenant,
 * not the caller's: `pm-catalogue` names it explicitly in `x-tenant-id`, so the
 * delegated client carries it as `X-Effective-Tenant-Id`. The tenant's cached
 * catalogue is dropped afterwards.
 */
export async function handleSuperAdminImportCatalogueDefaults(
  req: Request,
  tenantId: string,
): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  if (!isSuperAdmin(caller.user)) return jsonResponse({ error: 'super_admin_required' }, 403);
  if (!isUuidShape(tenantId)) return jsonResponse({ error: 'invalid_tenant_id', tenant_id: tenantId }, 400);
  const parsed = await readBody(req);
  if (parsed instanceof Response) return parsed;
  const out = await upstreamWrite(tenantId, () => importPmCatalogueDefaults(tenantId, parsed.body));
  if (out instanceof Response) return out;
  return jsonResponse({ data: out.value });
}

/**
 * GET /api/conveyor/project-types — the caller tenant's project types WITH their
 * ordered phases (name + title), through the one reader
 * (services/catalogue/tenant-catalogue.ts). Backs the project form's type picker
 * and every phase label in the UI. Unlike the raw `/api/conveyor/catalogue/project-types`
 * proxy, an EMPTY catalogue is not `[]` here: it is 409
 * `catalogue_not_initialised` (with `details.tenant_id`), so the UI can offer the
 * super-admin import instead of an empty picker.
 */
export async function handleListTenantProjectTypes(req: Request): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const types = await catalogueProjectTypes(caller.tenantId);
  return jsonResponse({
    data: types.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description ?? null,
      // RM's retirement stamp: a draft carrying a retired type no longer appears
      // as startable, so the picker labels it "not a project type of this
      // workspace" instead of offering it.
      retired_at: t.retired_at ?? null,
      phases: [...t.phases]
        .sort((a, b) => a.position - b.position)
        .map((p) => ({ name: p.name, title: p.title, position: p.position, has_gate: p.has_gate })),
      // v4: only a type whose RM phase list starts with `setup` can start a
      // project (POST /api/projects answers 422 project_type_not_startable for
      // the rest) — AND only on the tenant that may create it (kata in the
      // conveyor workspace is 400 project_type_tenant_mismatch). The form offers
      // only these, so an offered type never fails on create; phase labels still
      // read every type.
      startable: isStartableProjectType(t) && projectTypeCreatableOn(t.name, caller.tenantId),
    })),
  });
}

/**
 * GET /api/conveyor/priority-levels — the caller tenant's RM priority levels,
 * ordered by rank (design Q3 = b), through the one reader. Backs every priority
 * picker. 409 `catalogue_not_initialised` when the tenant has none — never a
 * local P0..P3 list.
 */
export async function handleListTenantPriorityLevels(req: Request): Promise<Response> {
  const caller = await authenticate(req);
  if (caller instanceof Response) return caller;
  const levels = await cataloguePriorities(caller.tenantId);
  return jsonResponse({
    data: levels.map((l) => ({
      id: l.id,
      name: l.name,
      title: l.title,
      rank: l.rank,
      is_default: l.is_default,
      conveyor_may_set: l.conveyor_may_set,
      description: l.description ?? null,
    })),
  });
}
