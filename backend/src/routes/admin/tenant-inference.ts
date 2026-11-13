// src/routes/admin/tenant-inference.ts
//
// The owner's per-tenant "Inference" surface (PLAN tenant-inference-provisioning
// §2.6, gate 1a). The provision form decides a NEW tenant's inference; these
// routes let the owner read, change and roll back an EXISTING tenant's:
//
//   GET  /api/admin/inference/config                              — flags + per-setup availability
//   GET  /api/admin/tenants/:tenantId/inference-policy            — IR: active doc + version history
//   POST /api/admin/tenants/:tenantId/inference/apply             — edit / "Re-run checks"
//   POST /api/admin/tenants/:tenantId/inference-policy/activate   — roll back/forward to a stored version
//
// An edit is NEVER a bare IR PUT: it is provisioning's apply (licences
// byo_mode + currency + bundle, billing money budget + markup + quote, IR policy,
// then a 1-token smoke per tier PROVED by an IR ledger read-back), with a FRESH
// idempotency key each time — so a re-submit reaches IR (same doc → `unchanged`,
// same version, no second budget) and "Re-run checks" really re-runs the smoke.
//
// RBAC (every route): `validateAuth` (401), then the VERIFIED request-frame flag
// `callerIsSuperAdmin === true` (403) — computed once from the signed
// `realm_access.roles` claim, never a header. A tenant_admin of the target is
// 403: this is the owner's surface (tenant_admin's is Phase 2). The tenant
// routes additionally need the owner's own verified portal token (provisioning /
// IR authorise that human) and FR_INFERENCE_PROVISIONING on (404 otherwise, so
// with the flag off nothing here is reachable but the read-only config probe).
//
// Not here yet, and named so their absence is not read as done: BYO credential
// CRUD/test (IR gate 1b), breakers list/reset and the runaway status (IR gate
// 1c). The IR routes for those two do not exist yet. (The USD→EUR FX row is NOT
// missing: it shipped in fr#1366 and lives on the super-admin pricing page —
// `GET/PUT /api/admin/pricing/fx-rates`, routes/settings/pricing-admin.ts.)
//
// No key or token is ever echoed, audited or stored: the owner JWT is relayed
// in a header and dropped; setup 3 (the only key-bearing setup) is refused by
// the schema.

import { z } from 'zod';
import { validateAuth } from '../../middleware/auth';
import { tryGetRequestContext } from '../../middleware/request-context';
import { isUuidShape } from '../../lib/uuid-shape';
import { isIntegrationError } from '../../integrations/_lib/errors';
import { AppError, NotFoundError } from '../../utils/errors';
import { adminGetTenant } from '../../services/licenses';
import { applyTenantInference } from '../../services/provisioning';
import {
  activateTenantInferencePolicy,
  getTenantInferencePolicy,
} from '../../services/inference-admin';
import {
  INFERENCE_SETUPS,
  InferenceInputSchema,
  SETUP_UNAVAILABLE,
  buildApplyRequest,
  inferenceFlags,
  newApplyIdempotencyKey,
  normaliseApplyResult,
  ownerPortalToken,
} from '../../lib/inference-provisioning';
import { jsonResponse } from '../../utils/response';
import { handle } from '../assets/_lib/handler';

/** 401 → 403 (verified frame flag). */
async function requireOwner(req: Request): Promise<void> {
  await validateAuth(req);
  const ctx = tryGetRequestContext();
  if (!ctx || ctx.callerIsSuperAdmin !== true) {
    throw new AppError(403, 'super-admin only');
  }
}

/** requireOwner → 404 (flag off) → owner token (403) → live tenant id (404). */
async function ownerTenantScope(
  req: Request,
  tenantId: string,
): Promise<{ tenantId: string; ownerToken: string }> {
  await requireOwner(req);
  if (!inferenceFlags().enabled) throw new NotFoundError('tenant inference provisioning is off');
  const ownerToken = await ownerPortalToken(req);
  if (!ownerToken) {
    throw new AppError(
      403,
      'owner_portal_token_required: tenant inference is changed on behalf of the signed-in owner; ' +
        'no verified super_admin portal token was presented',
    );
  }
  return { tenantId: await resolveLiveTenantId(tenantId), ownerToken };
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
    throw new NotFoundError('tenant not found');
  }
  // Archived = "do not provision into this"; changing its inference is provisioning.
  if (tenant.archived_at) throw new NotFoundError('tenant not found');
  return tenant.id.trim();
}

// --- GET /api/admin/inference/config ----------------------------------------

export async function handleGetInferenceConfig(req: Request): Promise<Response> {
  await requireOwner(req);
  const flags = inferenceFlags();
  return jsonResponse({
    data: {
      enabled: flags.enabled,
      setup2_enabled: flags.setup2Enabled,
      setups: INFERENCE_SETUPS.map((setup) => {
        if (setup === 'local') return { setup, available: true, reason: null };
        if (setup === 'owner_commercial' && flags.setup2Enabled) {
          return { setup, available: true, reason: null };
        }
        return { setup, available: false, reason: SETUP_UNAVAILABLE[setup].reason };
      }),
    },
  });
}

// --- GET /api/admin/tenants/:tenantId/inference-policy ------------------------

export async function handleGetTenantInferencePolicy(req: Request, tenantId: string): Promise<Response> {
  const scope = await ownerTenantScope(req, tenantId);
  return handle(
    () => getTenantInferencePolicy(scope.tenantId, scope.ownerToken),
    (data) => jsonResponse({ data }),
  );
}

// --- POST /api/admin/tenants/:tenantId/inference/apply ------------------------

export async function handleApplyTenantInference(req: Request, tenantId: string): Promise<Response> {
  const scope = await ownerTenantScope(req, tenantId);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }
  const parsed = InferenceInputSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid request body', details: parsed.error.errors }, 422);
  }
  const key = newApplyIdempotencyKey(scope.tenantId);
  return handle(
    () =>
      applyTenantInference({
        tenantId: scope.tenantId,
        ownerPortalToken: scope.ownerToken,
        body: buildApplyRequest(parsed.data, key) as unknown as Record<string, unknown>,
      }),
    (result) => jsonResponse({ data: normaliseApplyResult(result, key) }),
  );
}

// --- POST /api/admin/tenants/:tenantId/inference-policy/activate --------------

const ActivateBody = z.object({ version: z.number().int().min(1) }).strict();

export async function handleActivateTenantInferencePolicy(req: Request, tenantId: string): Promise<Response> {
  const scope = await ownerTenantScope(req, tenantId);
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400);
  }
  const parsed = ActivateBody.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid request body', details: parsed.error.errors }, 422);
  }
  return handle(
    () => activateTenantInferencePolicy(scope.tenantId, parsed.data.version, scope.ownerToken),
    (data) => jsonResponse({ data }),
  );
}
