/**
 * Side-effect-free RBAC predicates a capability DECLARATION can reference
 * (define.ts forbids importing the db or Keycloak there; `principal.ts` does both).
 * `principal.ts` re-exports these, so existing importers are unchanged.
 */
import type { ActionContext } from '../agui/types';
import { tryGetRequestContext } from '../integrations/_lib/context';
import { isConveyorAllowedRequest } from '../lib/conveyor-identity';
import { isLicenceRouteAllowed } from '../lib/licence-route-allowlist';
import { isSuperAdmin } from '../lib/super-admin-gate';
import {
  AA_CONVEYOR_TENANT_ID,
  EXECUTION_TENANT_ID,
  V4_CONVEYOR_TENANT_ID,
  isInternalTenant,
  isPlatformTenant,
} from '../middleware/internal-tenant-only';
import type { HttpMethod } from './define';

/** The capability's own route: the exact `router.add` pattern it is served on. */
export interface CapabilityRoute {
  readonly method: HttpMethod;
  readonly path: string;
}

/**
 * The principal-route doors `validateAuth` / `validateAuthWithToken` apply
 * (middleware/auth.ts) BEFORE any handler logic, decided from the SAME sources:
 *   * a LICENCE caller (frame `authKind === 'licence'`, set by
 *     `buildRequestContext` from the introspected licence) reaches only
 *     `LICENCE_ROUTE_ALLOWLIST` — `isLicenceRouteAllowed`, the exact
 *     (method, router pattern) compare `assertLicenceRouteAllowed` makes for a
 *     routed request; otherwise 403 `licence_route_not_allowed`;
 *   * the CONVEYOR priority identity (frame `conveyorActor`, set by
 *     `buildRequestContext` with `isConveyorActor` over the signed azp /
 *     preferred_username / realm roles) reaches every GET/HEAD and only the
 *     `CONVEYOR_WRITE_ROUTES` writes — `isConveyorAllowedRequest`, which
 *     `assertConveyorRouteAllowed` runs over the request pathname; its patterns
 *     are `[^/]+` per segment, so a `:param` pattern matches exactly where the
 *     paths it serves do. Otherwise 403 `conveyor_route_forbidden`.
 * Both modules are dependency-free (no config / Keycloak), so the env-free
 * guards that import the declarations still load.
 */
export function principalDoorAdmits(route: CapabilityRoute): boolean {
  const frame = tryGetRequestContext();
  if (frame?.authKind === 'licence' && !isLicenceRouteAllowed(route.method, route.path)) return false;
  if (frame?.conveyorActor === true && !isConveyorAllowedRequest(route.method, route.path)) return false;
  return true;
}

/**
 * The web rule for `projects.create` (rbac `custom`): a signed-in human acting in
 * a tenant. Mirrors `POST /api/projects` (validateAuthWithToken, then the
 * service-account-subject gate inside createSingleProject) — no role string.
 */
export async function isAuthenticatedTenantUser(ctx: ActionContext): Promise<boolean> {
  return Boolean(ctx.userId) && Boolean(ctx.tenantId);
}

/**
 * A signed-in caller, tenant or not, that `validateAuth` lets onto `route`: the
 * bar `validateAuth` alone sets (the KAG routes, fr-agui P4a1) — authenticated,
 * AND past its licence / conveyor route doors (`principalDoorAdmits`). Distinct
 * from `isAuthenticatedTenantUser` on purpose — those routes do not refuse a
 * caller without a resolvable tenant at the edge (the KAG gateway scopes by the
 * forwarded tenant), so declaring the tenant bar would overstate the route.
 */
export async function isAuthenticatedUser(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  return Boolean(ctx.userId) && principalDoorAdmits(route);
}

/**
 * fr-agui P4a2 — the gate of the research / media proxy routes
 * (routes/research/{discover,scientific,media}.ts): `validateAuth` — which
 * refuses a licence caller off the licence route allowlist and the conveyor
 * identity on a write (`principalDoorAdmits`) — then `ctxTenantId(user.tenantId)`
 * — the REQUEST-CONTEXT tenant (a switched super_admin's accepted
 * X-Active-Tenant), else the JWT tenant — which THROWS when neither exists, so
 * no upstream call is made. A caller is therefore served exactly when it is
 * authenticated, passes those doors for `route`, AND that tenant resolves. This
 * resolves the tenant the same way, through the light frame accessor (importing
 * middleware/request-context would load Keycloak config into the env-free
 * guards; agui/rbac.ts `workspace-admin` does the same).
 */
export async function isAuthenticatedUserInResolvedTenant(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  return (
    Boolean(ctx.userId) && principalDoorAdmits(route) && Boolean(tryGetRequestContext()?.tenantId || ctx.tenantId)
  );
}

/**
 * fr-agui P4a3 — the gate of the routes whose upstream client REQUIRES a frame
 * tenant (`createHttpClient({ requireTenant: true })` over requirements_management:
 * routes/assets/{architecture,toc}.ts; the TOC read cache's
 * `cacheTenant`): `validateAuth` (its licence / conveyor doors,
 * `principalDoorAdmits`), then a REQUEST-CONTEXT tenant that is non-blank after
 * trim, else MISSING_TENANT (409) before anything is sent. The JWT tenant is NOT
 * a fallback there (unlike `ctxTenantId`), so it is not one here.
 */
export async function isAuthenticatedUserInFrameTenant(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  return Boolean(ctx.userId) && principalDoorAdmits(route) && Boolean(tryGetRequestContext()?.tenantId?.trim());
}

/**
 * `validateAuth`, then the route's own `requireTenant()` — the frame tenant,
 * refused only when ABSENT or empty (`!getTenantId()`, no trim; MISSING_TENANT
 * 409). So the bar is the frame tenant, untrimmed.
 */
export async function isAuthenticatedUserWithFrameTenant(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  return Boolean(ctx.userId) && principalDoorAdmits(route) && Boolean(tryGetRequestContext()?.tenantId);
}

/**
 * fr-agui P4a3 — the stream andon cord (routes/andon.ts `requireSuperAdmin`):
 * `validateAuth` (its doors), then `isSuperAdmin(user)` — the `super_admin`
 * Keycloak realm role on the verified token (lib/super-admin-gate.ts, the same
 * predicate). Platform-scoped: the tenant plays no part.
 */
export async function isAuthenticatedSuperAdmin(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  return Boolean(ctx.userId) && principalDoorAdmits(route) && isSuperAdmin({ roles: ctx.tenantRoles ?? [] });
}

/**
 * fr-agui P4a3 — the conveyor catalogue proxies (routes/conveyor-catalogue.ts,
 * routes/conveyor-taxonomy.ts): `validateAuth` (its doors), `ctxTenantId(user.tenantId)`
 * (the frame tenant, else the JWT one; a throw → 500 when neither), and then the
 * requirements_management client, which names that tenant explicitly and refuses
 * (MISSING_TENANT, nothing sent) when it is blank after trim. So: the resolved
 * tenant must be non-blank. (The static `enums` read has no upstream:
 * `isAuthenticatedUserInResolvedTenant`.)
 */
export async function isAuthenticatedUserInResolvedNonBlankTenant(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  return Boolean(ctx.userId) && principalDoorAdmits(route) && Boolean((tryGetRequestContext()?.tenantId || ctx.tenantId)?.trim());
}

/**
 * fr-agui P4c part 1 — `GET /api/assets/_assignments` (routes/assets/assignments.ts):
 * `validateAuth` (its doors), then `tryCtxTenantId() ?? user.tenantId` — the
 * REQUEST-CONTEXT tenant when the frame carries one (even an empty one: `??`, not
 * `||`), else the JWT tenant — refused (403 'tenant context required') when that is
 * empty. A whitespace frame tenant is NOT refused (it is truthy).
 */
export async function isAuthenticatedUserInFrameOrJwtTenant(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  return Boolean(ctx.userId) && principalDoorAdmits(route) && Boolean(tryGetRequestContext()?.tenantId ?? ctx.tenantId);
}

/**
 * fr-agui P4c part 2 — `GET /api/admin/assets/workflows/:id` (routes/admin/assets/workflows.ts):
 * `gateReadAsset` (validateAuth, its doors), then `canReadProductionWorkflows(user,
 * getRequestContext().tenantId)` (lib/production-workflows-gate.ts) — a super_admin, or a caller
 * whose active tenant is a PLATFORM tenant; anyone else gets the 404 an unknown id answers, before
 * n8n is called. ⚠️ An ABSENT frame tenant hits that function's default parameter
 * (`tryGetRequestContext()?.tenantId ?? user.tenantId`), so it falls back to the JWT tenant; an
 * EMPTY one does not. Hence `frame ?? jwt`, not `||`.
 */
export async function isAuthenticatedProductionWorkflowReader(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  return (
    Boolean(ctx.userId) &&
    principalDoorAdmits(route) &&
    (isSuperAdmin({ roles: ctx.tenantRoles ?? [] }) || isPlatformTenant(tryGetRequestContext()?.tenantId ?? ctx.tenantId))
  );
}

/**
 * fr-agui P4d-2a — the licence-ONLY routes (lib/licence-door.ts `requireLicenceCaller`:
 * routes/approval-write-set.ts, routes/approval-bug-fix-for-card.ts): `validateAuth`, then the
 * caller must be a LICENCE (frame `authKind === 'licence'`) with a resolved tenant, else 401. The
 * licence door admits them only because these routes are on the licence allowlist.
 */
export async function isLicenceCallerWithTenant(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  const frame = tryGetRequestContext();
  return (
    Boolean(ctx.userId) && principalDoorAdmits(route) && frame?.authKind === 'licence' && Boolean(frame?.tenantId || ctx.tenantId)
  );
}

/**
 * fr-agui P4d-2a — `POST /api/approvals/:approvalId/mint-design-units`
 * (routes/approval-mint-design-units.ts): `validateAuth` (its doors), then the resolved
 * tenant (`ctxTenantId`: frame, else JWT) must be the EXECUTION tenant, else 403
 * `mint_design_units_exec_only`.
 */
export async function isAuthenticatedUserInExecutionTenant(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  return Boolean(ctx.userId) && principalDoorAdmits(route) && (tryGetRequestContext()?.tenantId || ctx.tenantId) === EXECUTION_TENANT_ID;
}

/**
 * fr-agui P4d-2a part 2 — `POST /api/projects/constraint-check` (routes/project-constraint-check.ts):
 * `validateAuth` (its doors), then `requireAnyInternalTenant` — the REQUEST-CONTEXT tenant
 * (`getTenantId()`, no JWT fallback) must be an internal workspace (system), else an opaque 404.
 */
export async function isAuthenticatedUserInInternalTenant(ctx: ActionContext, route: CapabilityRoute): Promise<boolean> {
  return Boolean(ctx.userId) && principalDoorAdmits(route) && isInternalTenant(tryGetRequestContext()?.tenantId);
}

/**
 * The kata routes (routes/katas.ts `assertKataCaller`) that admit the CONVEYOR LICENCE: a licence
 * caller (frame `authKind === 'licence'`) whose tenant is the v4 or the AA conveyor tenant.
 * `withSuperAdmin` also admits a super_admin on a human token. No tenant role is admitted.
 */
export function isKataCaller(opts: { withSuperAdmin: boolean }) {
  return async (ctx: ActionContext, route: CapabilityRoute): Promise<boolean> => {
    if (!ctx.userId || !principalDoorAdmits(route)) return false;
    const frame = tryGetRequestContext();
    if (frame?.authKind === 'licence') {
      const tenant = (frame.tenantId || ctx.tenantId || '').toLowerCase();
      return tenant === V4_CONVEYOR_TENANT_ID || tenant === AA_CONVEYOR_TENANT_ID;
    }
    return opts.withSuperAdmin && isSuperAdmin({ roles: ctx.tenantRoles ?? [] });
  };
}
