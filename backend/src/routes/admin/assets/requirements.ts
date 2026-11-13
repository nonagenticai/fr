// src/routes/admin/assets/requirements.ts
//
// Super-admin asset console — requirements proxy.
//
// Surface (all rooted at /api/admin/assets/requirements):
//   GET    /                  — list, with system-UNION inheritance
//   GET    /:id                — fetch one
//   POST   /                  — create (system writes super-admin gated)
//   PATCH  /:id                — update (idem)
//   DELETE /:id                — delete (idem)
//
// Direct pattern-replica of principles.ts. The proxy is paper-thin and
// relays to `src/integrations/requirements.ts` which already handles
// upstream URL building + auth via the shared HTTP client. Active tenant
// is supplied by the request-context middleware (post X-Active-Tenant
// override). System UNION on list when the active tenant is NOT system.

import { z } from 'zod';
import {
  listRequirements,
  getRequirement,
  createRequirement,
  updateRequirement,
  deleteRequirement,
  parseListRequirementsParams,
  type ListRequirementsParams,
  getRequirementTarget,
} from '../../../integrations/requirements';
import { getRequestContext } from '../../../integrations/_lib/context';
import {
  isIntegrationError,
  integrationErrorResponse,
} from '../../../integrations/_lib/errors';
import { jsonResponse } from '../../../utils/response';
import { gateReadAsset, gateWriteAsset } from './_lib/gate';
import { refuseSystemOwnedWrite } from './_lib/system-ownership';
import { customerNotFoundError,
  isPlatformTenant, isSystemRow } from '../../assets/_lib/system-union';

type AnyRecord = Record<string, unknown>;
function tagSystem<T extends AnyRecord>(row: T, isSystem: boolean): T & { is_system: boolean } {
  return { ...row, is_system: isSystem };
}

export async function handleListAdminRequirements(req: Request): Promise<Response> {
  const gate = await gateReadAsset(req);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  let params: ListRequirementsParams | undefined;
  try {
    params = parseListRequirementsParams(url.searchParams);
  } catch (e) {
    return jsonResponse({ error: 'bad_request', detail: (e as Error).message }, 400);
  }

  const ctx = getRequestContext();
  const active = ctx.tenantId;
  if (!active) {
    return jsonResponse({ error: 'no_active_tenant' }, 400);
  }

  // STRICT tenant separation (2026-09-30): ONE upstream call, under the
  // caller's active tenant frame. fr never makes a second call pinned to the
  // system tenant for a customer tenant — that union handed customer admins
  // every system row (DRAFTs, conveyor records). When the active tenant IS
  // system (super-admin via X-Active-Tenant) this is the system list, as
  // before. `is_system` is read off each ROW (`tenant_id === system`), not
  // inferred from which call produced it.
  try {
    const rows = await listRequirements(params);
    // A customer (non-platform) tenant never sees a system-tenant row, even if
    // the upstream's inheritance regresses. Platform tenants keep them, tagged.
    const visible = isPlatformTenant(active) ? rows : rows.filter((r) => !isSystemRow(r));
    const tagged = visible.map((r) =>
      tagSystem(r as unknown as AnyRecord, isSystemRow(r)),
    );
    return jsonResponse({ requirements: tagged });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

export async function handleGetAdminRequirement(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateReadAsset(req);
  if (!gate.ok) return gate.response;
  try {
    const row = await getRequirement(id);
    const ctx = getRequestContext();
    // `is_system` comes from the ROW's owner, not the active tenant. A customer
    // (non-platform) tenant never sees a system-owned row: answer it exactly as
    // an upstream miss would.
    const isSystem = isSystemRow(row);
    if (isSystem && !isPlatformTenant(ctx.tenantId)) {
      return integrationErrorResponse(
        customerNotFoundError(getRequirementTarget(id)),
      );
    }
    return jsonResponse({
      requirement: tagSystem(row as unknown as AnyRecord, isSystem),
    });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

const RequirementBodySchema = z.object({}).passthrough();

export async function handleCreateAdminRequirement(req: Request): Promise<Response> {
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  let body;
  try {
    body = RequirementBodySchema.parse(await req.json());
  } catch (e) {
    return jsonResponse({ error: 'bad_request', detail: (e as Error).message }, 400);
  }
  try {
    const created = await createRequirement(
      body as unknown as Parameters<typeof createRequirement>[0],
    );
    return jsonResponse({ requirement: created }, 201);
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

export async function handleUpdateAdminRequirement(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  // A customer tenant-admin may not edit/delete a SYSTEM-owned row, even
  // when upstream resolves it under their frame. Super-admin proceeds.
  const refused = await refuseSystemOwnedWrite(gate.user, () => getRequirement(id));
  if (refused) return refused;
  let body;
  try {
    body = RequirementBodySchema.parse(await req.json());
  } catch (e) {
    return jsonResponse({ error: 'bad_request', detail: (e as Error).message }, 400);
  }
  try {
    const updated = await updateRequirement(
      id,
      body as unknown as Parameters<typeof updateRequirement>[1],
    );
    return jsonResponse({ requirement: updated });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

export async function handleDeleteAdminRequirement(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  // A customer tenant-admin may not edit/delete a SYSTEM-owned row, even
  // when upstream resolves it under their frame. Super-admin proceeds.
  const refused = await refuseSystemOwnedWrite(gate.user, () => getRequirement(id));
  if (refused) return refused;
  try {
    await deleteRequirement(id);
    return new Response(null, { status: 204 });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}
