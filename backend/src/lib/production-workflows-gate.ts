// src/lib/production-workflows-gate.ts
//
// ⛔ The PRODUCTION n8n instance is platform data. Owner rule (2026-09-30):
// system / improvement data is NEVER visible to a customer tenant.
//
// fr talks to exactly one n8n — the production instance that runs the
// conveyor (~360 workflows, ~350 of them "AA …" conveyor workflows; the demo
// instance is a separate deployment fr does not proxy). Every surface that
// hands out that instance's workflow catalogue or a workflow definition
// (node code included) must therefore ask this predicate first:
//
//   - super-admin (the `super_admin` realm role), in ANY active tenant, or
//   - a caller whose ACTIVE tenant is a platform tenant (`isPlatformTenant` —
//     the one shared set; do not re-derive it).
//
// Everyone else is a customer and sees an EMPTY catalogue / a not-found, never
// a 403 on reads: a 403 would confirm the data exists.

import { isSuperAdmin } from './super-admin-gate';
import {
  customerNotFoundError,
  isPlatformTenant,
} from '../routes/assets/_lib/system-union';
import { tryGetRequestContext } from '../integrations/_lib/context';
import type { IntegrationError } from '../integrations/_lib/errors';
import { getGetWorkflowsIdUrl } from '@fr/service-client-n8n';

/**
 * The caller's ACTIVE tenant: the request-context frame's tenantId (post
 * X-Active-Tenant override, which only super-admins can steer), falling back
 * to the JWT tenant when there is no frame (unit tests, AG-UI dispatch).
 */
export function activeTenantOf(user: { tenantId?: string | null }): string | undefined {
  return tryGetRequestContext()?.tenantId ?? user.tenantId ?? undefined;
}

export function canReadProductionWorkflows(
  user: { roles?: readonly string[]; tenantId?: string | null },
  activeTenantId: string | null | undefined = activeTenantOf(user),
): boolean {
  return isSuperAdmin(user) || isPlatformTenant(activeTenantId);
}

/**
 * The error a GENUINE unknown id produces on `getWorkflow(id)`. Built by the
 * shared `customerNotFoundError` (the same masking every system-asset read
 * uses), which mirrors `http-client.ts`'s upstream-404 construction field for
 * field (code, message `${service} ${method} ${path} returned 404`, service,
 * path, method, upstreamStatus, upstreamBody); n8n's fixed 404 body lives in
 * `upstreamNotFoundBody`. After `integrationErrorResponse` a masked read and a
 * real miss are byte-identical, so the response leaks no existence.
 */
export function productionWorkflowNotFoundError(id: string): IntegrationError {
  return customerNotFoundError({
    service: 'n8n',
    method: 'GET',
    path: getGetWorkflowsIdUrl(id),
    detail: 'not found',
  });
}
