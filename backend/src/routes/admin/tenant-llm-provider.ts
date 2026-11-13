// src/routes/admin/tenant-llm-provider.ts
//
// Owner (platform super-admin) sets a CUSTOMER tenant's BYO LLM provider.
//
// Every customer tenant runs on local-llm by default. The owner must be able to
// switch one onto the tenant's OWN commercial key(s) — per tier — test it, and
// switch it back. The tenant_admin path already exists at
// `/api/settings/llm-provider`, but it acts on the caller's frame tenant, and
// the super-admin `X-Active-Tenant` switch is deliberately limited to the
// internal / execution / own tenants (`middleware/request-context.ts`). So the
// owner could not reach a customer tenant at all. These routes name the target
// tenant in the PATH instead of widening that switch.
//
// RBAC (every route):
//   * `validateAuth` (401), then the VERIFIED request-frame flag
//     `callerIsSuperAdmin === true` (403). That flag is computed once, in
//     `buildRequestContext`, from the SIGNED `realm_access.roles` claim — never
//     from a client header. A tenant_admin OF THE TARGET tenant is still 403:
//     this surface is the owner's, theirs is `/settings/llm-provider`.
//   * `:tenantId` must resolve (licences service) to a real, NON-archived
//     tenant (404 otherwise). The canonical `id` licences returns is what is
//     sent to worker_management, never the raw path segment.
//
// Routes (mirror `/api/settings/llm-provider`, same bodies, same responses):
//   GET    /api/admin/tenants/:tenantId/llm-provider[?tier=]
//   GET    /api/admin/tenants/:tenantId/llm-provider/all
//   GET    /api/admin/tenants/:tenantId/llm-provider/catalog
//   PUT    /api/admin/tenants/:tenantId/llm-provider[?tier=]
//   DELETE /api/admin/tenants/:tenantId/llm-provider[?tier=]
//   POST   /api/admin/tenants/:tenantId/llm-provider/test
//   GET    /api/admin/tenants/:tenantId/llm-provider/audit[?limit=1..200]
//
// HOW THE TARGET REACHES WM: the proxy bodies are the SAME functions the
// settings routes use (`*Op(req, scope)` in `routes/settings/llm-provider.ts`).
// The scope here runs the WM call inside a NESTED request frame whose `tenantId`
// is the target, so `integrations/workers.ts` sends
// `X-Effective-Tenant-Id: <target>` on the delegated pair. The owner's own
// portal token is carried into that frame (`verifiedSuperAdminPortalToken`:
// re-verified RS256, human, signed super_admin, `sub` — never a service account
// or an fr-agent token, and independent of any X-Active-Tenant switch), so
// `X-End-User-Token` rides the call: worker_management (branch `feat/owner-sets-tenant-byo`)
// is what decides whether an owner's token may decrypt the target's row for a
// key TEST. Until that ships WM answers the test `ok:false` ("withheld"), which
// is a normal 200 the UI renders as a red dot. Keys are never returned by any
// of these routes — WM's view carries `hasKey` only.

import { validateAuth } from '../../middleware/auth';
import {
  tryGetRequestContext,
  verifiedSuperAdminPortalToken,
  withRequestContext,
  type RequestContext,
} from '../../middleware/request-context';
import { isUuidShape } from '../../lib/uuid-shape';
import { isIntegrationError } from '../../integrations/_lib/errors';
import { AppError, NotFoundError } from '../../utils/errors';
import { adminGetTenant } from '../../services/licenses';
import { jsonResponse, noContentResponse } from '../../utils/response';
import { handle } from '../assets/_lib/handler';
import {
  deleteLlmProviderOp,
  getLlmAuditOp,
  getLlmCatalogOp,
  getLlmProviderOp,
  listLlmProvidersOp,
  putLlmProviderOp,
  testLlmProviderOp,
  type TenantScope,
} from '../settings/llm-provider';

/** 401 → 403 (frame flag) → 404 (unknown/archived) → a scope naming the target. */
async function ownerScopeFor(req: Request, tenantId: string): Promise<TenantScope> {
  await validateAuth(req);
  const ctx = tryGetRequestContext();
  // The VERIFIED flag only. `isSuperAdmin(user)` on validateAuth's user would
  // also be signed, but the frame flag is the single place the decision was
  // already made for this request (and what error redaction keys on).
  if (!ctx || ctx.callerIsSuperAdmin !== true) {
    throw new AppError(403, 'super-admin only');
  }
  const targetId = await resolveLiveTenantId(tenantId);
  // The frame's `endUserToken` is set only when the JWT tenant equals the
  // frame tenant, so it is ABSENT whenever the owner has switched workspace
  // (X-Active-Tenant). Re-derive the owner's own VERIFIED human portal token
  // instead; service accounts and fr-agent tokens yield nothing.
  const ownerToken = await verifiedSuperAdminPortalToken(ctx.bearerToken);
  const target: RequestContext = {
    ...ctx,
    tenantId: targetId,
    // Not a service-account subject: the tenant came from licences.
    tenantIsServiceAccountSubject: undefined,
    endUserToken: ownerToken,
  };
  return (fn) => withRequestContext(target, fn);
}

async function resolveLiveTenantId(tenantId: string): Promise<string> {
  const raw = (tenantId ?? '').trim();
  if (!raw) throw new NotFoundError('tenant not found');
  let tenant;
  try {
    tenant = await adminGetTenant(raw);
  } catch (e) {
    if (isIntegrationError(e) && e.code === 'UPSTREAM_NOT_FOUND') {
      throw new NotFoundError('tenant not found');
    }
    throw e;
  }
  if (!tenant || typeof tenant.id !== 'string' || !isUuidShape(tenant.id.trim())) {
    // The id that goes to WM as X-Effective-Tenant-Id must be a real UUID;
    // anything else from licences is treated as no tenant at all.
    throw new NotFoundError('tenant not found');
  }
  if (tenant.archived_at) {
    // Archived = "do not provision into this". Configuring a provider for it
    // is provisioning, so it is not addressable here.
    throw new NotFoundError('tenant not found');
  }
  return tenant.id.trim();
}

export async function handleAdminGetTenantLlmProvider(req: Request, tenantId: string): Promise<Response> {
  const scope = await ownerScopeFor(req, tenantId);
  return handle(getLlmProviderOp(req, scope), (data) => jsonResponse({ data }));
}
export async function handleAdminListTenantLlmProviders(req: Request, tenantId: string): Promise<Response> {
  const scope = await ownerScopeFor(req, tenantId);
  return handle(listLlmProvidersOp(scope), (data) => jsonResponse({ data }));
}
export async function handleAdminGetTenantLlmCatalog(req: Request, tenantId: string): Promise<Response> {
  const scope = await ownerScopeFor(req, tenantId);
  return handle(getLlmCatalogOp(scope), (data) => jsonResponse({ data }));
}
export async function handleAdminPutTenantLlmProvider(req: Request, tenantId: string): Promise<Response> {
  const scope = await ownerScopeFor(req, tenantId);
  return handle(await putLlmProviderOp(req, scope), (data) => jsonResponse({ data }));
}
export async function handleAdminDeleteTenantLlmProvider(req: Request, tenantId: string): Promise<Response> {
  const scope = await ownerScopeFor(req, tenantId);
  return handle(deleteLlmProviderOp(req, scope), () => noContentResponse());
}
export async function handleAdminTestTenantLlmProvider(req: Request, tenantId: string): Promise<Response> {
  const scope = await ownerScopeFor(req, tenantId);
  return handle(await testLlmProviderOp(req, scope), (data) => jsonResponse({ data }));
}
export async function handleAdminGetTenantLlmAudit(req: Request, tenantId: string): Promise<Response> {
  const scope = await ownerScopeFor(req, tenantId);
  return handle(getLlmAuditOp(req, scope), (data) => jsonResponse({ data }));
}
