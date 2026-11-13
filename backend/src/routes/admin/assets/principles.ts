// src/routes/admin/assets/principles.ts
//
// Super-admin asset console — principles proxy.
//
// Surface (all rooted at /api/admin/assets/principles):
//   GET    /                  — list (active tenant only; no system union)
//   GET    /:id                — fetch one
//   POST   /                  — create (system writes super-admin gated)
//   PATCH  /:id                — update (idem)
//   DELETE /:id                — delete (idem)
//
// The proxy is paper-thin: it relays to `src/integrations/principles.ts`
// which already handles upstream URL building + auth via the shared HTTP
// client. The active tenant is supplied by the request-context middleware
// (post X-Active-Tenant override).
//
// STRICT tenant separation (2026-09-30): the list makes ONE call under the
// active tenant — never a second call pinned to the system tenant for a
// customer tenant. `is_system` is derived from each row's `tenant_id`. A
// non-super-admin update/delete of a SYSTEM-owned row is refused 403
// `system_asset_read_only` (see ./_lib/system-ownership.ts).

import { z } from 'zod';
import {
  listPrinciples,
  getPrinciple,
  createPrinciple,
  updatePrinciple,
  deletePrinciple,
  parseListPrinciplesParams,
  type ListPrinciplesParams,
  getPrincipleTarget,
} from '../../../integrations/principles';
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

// PrincipleOut from the generated client doesn't include our `is_system`
// inheritance flag — define an extended row shape for the response so the
// UI can pick it up without a casts dance.
type AnyRecord = Record<string, unknown>;
function tagSystem<T extends AnyRecord>(row: T, isSystem: boolean): T & { is_system: boolean } {
  return { ...row, is_system: isSystem };
}

export async function handleListAdminPrinciples(req: Request): Promise<Response> {
  const gate = await gateReadAsset(req);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  let params: ListPrinciplesParams | undefined;
  try {
    params = parseListPrinciplesParams(url.searchParams);
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
    const rows = await listPrinciples(params);
    // A customer (non-platform) tenant never sees a system-tenant row, even if
    // the upstream's inheritance regresses. Platform tenants keep them, tagged.
    const visible = isPlatformTenant(active) ? rows : rows.filter((r) => !isSystemRow(r));
    const tagged = visible.map((r) =>
      tagSystem(r as unknown as AnyRecord, isSystemRow(r)),
    );
    return jsonResponse({ principles: tagged });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

export async function handleGetAdminPrinciple(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateReadAsset(req);
  if (!gate.ok) return gate.response;
  try {
    const row = await getPrinciple(id);
    const ctx = getRequestContext();
    // `is_system` comes from the ROW's owner, not the active tenant. A customer
    // (non-platform) tenant never sees a system-owned row: answer it exactly as
    // an upstream miss would.
    const isSystem = isSystemRow(row);
    if (isSystem && !isPlatformTenant(ctx.tenantId)) {
      return integrationErrorResponse(
        customerNotFoundError(getPrincipleTarget(id)),
      );
    }
    return jsonResponse({
      principle: tagSystem(row as unknown as AnyRecord, isSystem),
    });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

// PrincipleIn shape is generated; we accept an opaque body and let the
// upstream service validate. Routes that need stricter Zod schemas can
// tighten here later.
const PrincipleBodySchema = z.object({}).passthrough();

export async function handleCreateAdminPrinciple(req: Request): Promise<Response> {
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  let body;
  try {
    body = PrincipleBodySchema.parse(await req.json());
  } catch (e) {
    return jsonResponse({ error: 'bad_request', detail: (e as Error).message }, 400);
  }
  try {
    const created = await createPrinciple(body as unknown as Parameters<typeof createPrinciple>[0]);
    return jsonResponse({ principle: created }, 201);
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

export async function handleUpdateAdminPrinciple(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  // A customer tenant-admin may not edit/delete a SYSTEM-owned row, even
  // when upstream resolves it under their frame. Super-admin proceeds.
  const refused = await refuseSystemOwnedWrite(gate.user, () => getPrinciple(id));
  if (refused) return refused;
  let body;
  try {
    body = PrincipleBodySchema.parse(await req.json());
  } catch (e) {
    return jsonResponse({ error: 'bad_request', detail: (e as Error).message }, 400);
  }
  try {
    const updated = await updatePrinciple(
      id,
      body as unknown as Parameters<typeof updatePrinciple>[1],
    );
    return jsonResponse({ principle: updated });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

export async function handleDeleteAdminPrinciple(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateWriteAsset(req);
  if (!gate.ok) return gate.response;
  // A customer tenant-admin may not edit/delete a SYSTEM-owned row, even
  // when upstream resolves it under their frame. Super-admin proceeds.
  const refused = await refuseSystemOwnedWrite(gate.user, () => getPrinciple(id));
  if (refused) return refused;
  try {
    await deletePrinciple(id);
    return new Response(null, { status: 204 });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}
